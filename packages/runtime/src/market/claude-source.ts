import { waitForInstall } from "./install-operations.js";
import { installDirectory, recoverDirectoryInstalls } from "./directory-install.js";
/**
 * Claude 技能源：多仓库聚合（官方技能 + 官方市场插件 + 官方插件内技能）。
 * - anthropics/skills：官方技能仓库（skills/<name>/）
 * - anthropics/claude-code：官方插件市场（plugins/<name>/ 内含 skills/<skill>/；
 *   插件的 commands/agents/hooks 对 pi 不生效，仅其技能部分可装，如实标注）
 * - anthropics/claude-plugins-official：Claude 官方维护的插件市场
 * 目录：git trees API（失败/限流 → 内置精选回退清单，仅装 SKILL.md 并如实标注）
 * 详情/安装：raw.githubusercontent 按 (repo, 前缀) 构造路径
 */
import { mkdirSync, writeFileSync, existsSync,readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mapConcurrent } from "./concurrency.js";
import type { Logger } from "../logging/logger.js";

interface SkillSourceRepo {
	repo: string;
	label: string;
	/** trees API URL */
	treesUrl: string;
	/** raw 基址 */
	rawBase: string;
}

const REPOS: SkillSourceRepo[] = [
	{
		repo: "anthropics/skills",
		label: "Claude 官方",
		treesUrl: "https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1",
		rawBase: "https://cdn.jsdelivr.net/gh/anthropics/skills@main",
	},
	{
		repo: "anthropics/claude-plugins-official",
		label: "Claude 官方市场",
		treesUrl: "https://api.github.com/repos/anthropics/claude-plugins-official/git/trees/main?recursive=1",
		rawBase: "https://cdn.jsdelivr.net/gh/anthropics/claude-plugins-official@main",
	},
	{
		repo: "anthropics/claude-code",
		label: "Claude 官方插件",
		treesUrl: "https://api.github.com/repos/anthropics/claude-code/git/trees/main?recursive=1",
		rawBase: "https://cdn.jsdelivr.net/gh/anthropics/claude-code@main",
	},

];

/** API 不可用时的精选回退清单（探测于 2026-10，仅含确认存在的技能） */
export const CURATED_CLAUDE_SKILLS = [
	"algorithmic-art",
	"brand-guidelines",
	"canvas-design",
	"docx",
	"frontend-design",
	"internal-comms",
	"mcp-builder",
	"pdf",
	"pptx",
	"slack-gif-creator",
	"theme-factory",
	"webapp-testing",
	"xlsx",
];

export interface ClaudeSkillInfo {
	name: string;
	description: string;
	license: string | null;
	fileCount: number;
	/** 回退清单来源（无完整目录） */
	fallback: boolean;
	/** 来源仓库标签（官方/官方插件/社区） */
	sourceLabel: string;
	/** skill=技能目录安装；mcp-plugin=MCP 型插件（安装=接入 MCP 服务器） */
	kind?: "skill" | "mcp-plugin" | "plugin";
 installable?: boolean;
 compatibility?: string;
}

export interface ClaudeSkillServiceOptions {
	agentDir: string;
	logger: Logger;
	emit: (type: string, payload: unknown) => void;
}

interface TreeEntry {
	path: string;
	type: string;
}

/** 目录条目：技能名 → 所在仓库与前缀（安装/详情按此构造 raw 路径） */
interface CatalogEntry {
	repo: SkillSourceRepo;
	/** skills/<name> 之前的路径前缀（可为 ""） */
	prefix: string;
	fileCount: number;
}

/** MCP 型插件条目（.mcp.json 定义的服务器集合，安装=接入 MCP） */
interface McpPluginEntry {
 hasMcp?: boolean;
 skillNames?: string[];
	repo: SkillSourceRepo;
	/** .mcp.json 所在目录（含尾斜杠） */
	dir: string;
	description: string;
}

export class ClaudeSkillSource {
	#opts: ClaudeSkillServiceOptions;
    #installQueue:Promise<unknown>=Promise.resolve();
    #serializeInstall<T>(fn:()=>Promise<T>):Promise<T>{const run=this.#installQueue.then(fn,fn);this.#installQueue=run.catch(()=>{});return run;}
    install(name:string,signal?:AbortSignal){return this.#serializeInstall(()=>{signal?.throwIfAborted();return this.#install(name,signal);});}
    downloadForPackage(name:string,root:string,signal?:AbortSignal){return this.#serializeInstall(()=>{signal?.throwIfAborted();return this.#downloadForPackage(name,root,signal);});}
    downloadPluginAssets(name:string,root:string,signal?:AbortSignal){return this.#serializeInstall(()=>{signal?.throwIfAborted();return this.#downloadPluginAssets(name,root,signal);});}
	#catalogCache: {
		at: number;
		entries: Map<string, CatalogEntry>;
		mcpPlugins: Map<string, McpPluginEntry>;
		fallback: boolean;
	} | null = null;
	#descriptions = new Map<string, { description: string; license: string | null }>();
	#catalogPending: Promise<{
		entries: Map<string, CatalogEntry>;
		mcpPlugins: Map<string, McpPluginEntry>;
		fallback: boolean;
	}> | null = null;
	#metaPending = new Map<string, Promise<{ description: string; license: string | null }>>();

	constructor(opts: ClaudeSkillServiceOptions) {
		this.#opts = opts;
        for(const root of [join(opts.agentDir,"skills"),join(opts.agentDir,"..","claude-pkg")]){
            try{recoverDirectoryInstalls(root);}catch(error){opts.logger.warn("安装恢复未完成，已保留现场",{root,message:error instanceof Error ? error.message : String(error)});}
        }
	}

	async list(query?: string, kind?: "plugins" | "skills"): Promise<ClaudeSkillInfo[]> {
		const { entries, mcpPlugins, fallback } = await this.#catalog();
		const items: ClaudeSkillInfo[] = [];
		// 描述/许可证并发拉取（16 路；结果按完成序填充后统一排序）
		const pairs = kind === "plugins" ? [] : [...entries.entries()];
		const metas = await mapConcurrent(pairs, 16, async ([name, entry]) => ({
			name,
			entry,
			meta: await this.#meta(name, entry),
		}));
		for (const { name, entry, meta } of metas) {
 if (kind === "plugins") continue;
			items.push({
				name,
				description: meta.description,
				license: meta.license,
				fileCount: entry.fileCount,
				fallback,
				sourceLabel: entry.repo.label,
			});
		}
		for (const [name, entry] of mcpPlugins) {
 if (kind === "skills") continue;
			items.push({
				name,
				description: entry.description || "MCP 型插件：安装即接入其 MCP 服务器",
				license: null,
				fileCount: 1,
				fallback,
				sourceLabel: entry.repo.label,
				kind: entry.hasMcp ? "mcp-plugin" : "plugin",
 installable: !!entry.hasMcp || !!entry.skillNames?.length,
 compatibility: entry.hasMcp ? entry.skillNames?.length ? "接入 MCP 工具并安装技能；Claude 命令、Agent 与 Hook 暂不支持" : "接入 MCP 工具" : entry.skillNames?.length ? "安装技能部分；Claude 命令、Agent 与 Hook 暂不支持" : "依赖 Claude Code 命令、Agent 或 Hook，当前 Harness 暂不支持",
			});
		}
		items.sort((a, b) => a.name.localeCompare(b.name));
		const q = query?.trim().toLowerCase();
		return q ? items.filter((i) => i.name.includes(q) || i.description.toLowerCase().includes(q)) : items;
	}

	async detail(name: string, kind?: "plugins" | "skills"): Promise<string> {
		const catalog = await this.#catalog();
 const plugin = catalog.mcpPlugins.get(name);
 if (plugin && kind !== "skills") {
 const text = await this.#fetchText(`${plugin.repo.rawBase}/${plugin.dir}README.md`) ?? await this.#fetchText(`${plugin.repo.rawBase}/${plugin.dir}.claude-plugin/plugin.json`);
 if (text) return text;
 return plugin.description;
 }
 const entry = catalog.entries.get(name);
		if (!entry) throw new Error(`技能不存在于任何已聚合源: ${name}`);
		const res = await this.#fetchText(`${entry.repo.rawBase}/${entry.prefix}skills/${name}/SKILL.md`);
		if (res === null) throw new Error(`获取失败（网络或技能不存在）: ${name}`);
		return res;
	}

	async #install(name: string, signal?: AbortSignal): Promise<{ ok: boolean; message: string; files: string[] }> {
		if (!/^[A-Za-z0-9_-]+$/.test(name)) return { ok: false, message: "非法技能名", files: [] };
		const mcpEntry = (await waitForInstall(this.#catalog(),signal)).mcpPlugins.get(name);
        signal?.throwIfAborted();
		if (mcpEntry && !(await waitForInstall(this.#catalog(),signal)).entries.has(name)) {
			return { ok: false, message: `「${name}」是 MCP 型插件，请经 MCP 接入安装`, files: [] };
		}
		const targetDir = join(this.#opts.agentDir, "skills", name);
		if (existsSync(join(targetDir, "SKILL.md"))) {
			return { ok: false, message: `技能已安装: ${name}（如需更新请先在本地资源中删除）`, files: [] };
		}
		const entry = (await waitForInstall(this.#catalog(),signal)).entries.get(name);
		if (!entry) return { ok: false, message: `技能不存在于任何已聚合源: ${name}`, files: [] };
		let written:string[];
        try {written = await installDirectory(targetDir,async staging=>{
            const files=await this.#downloadSkillFiles(name,entry,staging,signal);
            if(!files.includes("SKILL.md"))throw new Error(`下载失败（网络或仓库中无 SKILL.md）: ${name}`);
            return files;
        },signal);}catch(error){return {ok:false,message:error instanceof Error ? error.message : String(error),files:[]};}
		if (written.length === 0 || !written.includes("SKILL.md")) {
			return { ok: false, message: `下载失败（网络或仓库中无 SKILL.md）: ${name}`, files: [] };
		}
		this.#opts.logger.info("Claude 技能安装完成", { name, files: written.length, repo: entry.repo.repo });
		return {
			ok: true,
			message: `已安装 ${name}（${written.length} 个文件，来源 ${entry.repo.label}）`,
			files: written,
		};
	}

	/** 以插件（pi 本地包）形式安装：下载到 <stagingRoot>/claude-<name>/skills/<name>/，返回包目录。 */
	async #downloadForPackage(name: string, stagingRoot: string, signal?: AbortSignal): Promise<string> {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("非法技能名");
        const catalog=await waitForInstall(this.#catalog(),signal);signal?.throwIfAborted();const plugin=catalog.mcpPlugins.get(name),entry=catalog.entries.get(name);
        if(plugin && !plugin.skillNames?.length)throw new Error("该插件只有 Claude Code 专用能力，当前 Harness 暂不支持");
        if(!plugin && !entry)throw new Error(`技能不存在于任何已聚合源: ${name}`);
        const target=join(stagingRoot,`claude-${name}`);
        await installDirectory(target,async staging=>{
            const names=plugin?.skillNames ?? [name];
            for(const skillName of names){
                const skill=plugin ? {repo:plugin.repo,prefix:plugin.dir,fileCount:1} : entry!;
                const written=await this.#downloadSkillFiles(skillName,skill,join(staging,"skills",skillName),signal);
                if(!written.includes("SKILL.md"))throw new Error(`技能下载失败: ${skillName}`);
            }
            if(plugin){
                for(const file of await this.#pluginFiles(plugin,signal)){
                    const path=join(staging,file.relative);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,file.data,{mode:file.data.subarray(0,2).toString()==="#!" ? 0o755 : 0o644});
                }
            }
            writeFileSync(join(staging,"package.json"),JSON.stringify({name:`claude-${name}`,version:"1.0.0",pi:{skills:["./skills"]}}));
        },signal);
        return target;
    }

	/* ---------------- 内部 ---------------- */

	/** 多仓库聚合目录（缓存 1 小时；同名技能按仓库声明顺序优先，官方在前）。
	 * 目录层走 jsDelivr data API（CDN 无认证无限流），GitHub trees 作回退。 */
	#catalog(): Promise<{
		entries: Map<string, CatalogEntry>;
		mcpPlugins: Map<string, McpPluginEntry>;
		fallback: boolean;
	}> {
		if (!this.#catalogPending)
			this.#catalogPending = this.#loadCatalog().finally(() => {
				this.#catalogPending = null;
			});
		return this.#catalogPending;
	}

	async #loadCatalog(): Promise<{
		entries: Map<string, CatalogEntry>;
		mcpPlugins: Map<string, McpPluginEntry>;
		fallback: boolean;
	}> {
		if (this.#catalogCache && Date.now() - this.#catalogCache.at < 3600_000) {
			return this.#catalogCache;
		}
		const entries = new Map<string, CatalogEntry>();
		const mcpPlugins = new Map<string, McpPluginEntry>();
		let anyOk = false;
 const catalogs = await Promise.all(REPOS.map(repo => this.#listFiles(repo)));
		for (const [index, repo] of REPOS.entries()) {
			const paths = catalogs[index];
			if (!paths) continue;
			anyOk = true;
			// 技能：任意前缀下 skills/<name>/...
			const bySkill = new Map<string, string[]>();
			for (const p of paths) {
				const m = p.match(/^(.*?)(skills\/[A-Za-z0-9_-]+)\//);
				if (!m) continue;
				const name = m[2]!.slice("skills/".length);
				const list = bySkill.get(name) ?? [];
				list.push(p);
				bySkill.set(name, list);
			}
			for (const [name, list] of bySkill) {
				if (entries.has(name)) continue;
				if (!list.some((p) => p.endsWith("/SKILL.md"))) continue;
 const first = list[0]!;
				const idx = first.indexOf(`skills/${name}/`);
				entries.set(name, { repo, prefix: first.slice(0, idx), fileCount: list.length });
			}
 // 官方插件：以 plugin.json/.mcp.json 为条目，保留不兼容能力的说明。
 for (const p of paths) {
 const m = p.match(/^\/?(?:external_plugins|plugins)\/([A-Za-z0-9_-]+)\/(?:\.mcp\.json|\.claude-plugin\/plugin\.json)$/);
 if (!m) continue;
 const name = m[1]!;
 const dir = p.slice(0, p.indexOf(`/${name}/`) + name.length + 2);
 if (mcpPlugins.has(name)) continue;
 mcpPlugins.set(name, { repo, dir, description: "", hasMcp: paths.includes(`${dir}.mcp.json`), skillNames: [...new Set(paths.filter(x => x.startsWith(`${dir}skills/`) && x.endsWith("/SKILL.md")).map(x => x.slice(`${dir}skills/`.length).split("/")[0]!))] });
 }
		}
		// MCP 插件描述：拉 plugin.json（懒、并发、失败留空）
		await mapConcurrent([...mcpPlugins.entries()].slice(0, 40), 16, async ([_name, entry]) => {
			const raw = await this.#fetchText(`${entry.repo.rawBase}/${entry.dir}.claude-plugin/plugin.json`);
			if (!raw) return;
			try {
				const desc = (JSON.parse(raw) as { description?: string }).description;
				if (desc) entry.description = desc.slice(0, 200);
			} catch {
				/* 描述缺省 */
			}
		});
		if (anyOk) {
			this.#catalogCache = { at: Date.now(), entries, mcpPlugins, fallback: false };
			return this.#catalogCache;
		}
		// 回退清单（仅 anthropics/skills 官方，SKILL.md 单文件）
		const fallbackEntries = new Map<string, CatalogEntry>();
		for (const name of CURATED_CLAUDE_SKILLS) {
			fallbackEntries.set(name, { repo: REPOS[0]!, prefix: "", fileCount: 1 });
		}
		return { entries: fallbackEntries, mcpPlugins: new Map(), fallback: true };
	}

	/** 目录列举：jsDelivr data API（CDN）优先，GitHub trees 回退；均失败返回 null。 */
	async #listFiles(repo: SkillSourceRepo, signal?: AbortSignal): Promise<string[] | null> {
		try {
			const res = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${repo.repo}@main?structure=flat`, {
				headers: { accept: "application/json" },
				signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
			});
			if (res.ok) {
				const data = (await res.json()) as { files?: Array<{ name: string }> };
				const names = (data.files ?? []).map((f) => f.name.replace(/^\//, ""));
				if (names.length > 0) return names;
			}
		} catch {
			signal?.throwIfAborted();
			/* 走回退 */
		}
		const tree = (await this.#fetchJson(repo.treesUrl,signal)) as { tree?: TreeEntry[] } | null;
		return tree?.tree ? tree.tree.filter((t) => t.type === "blob").map((t) => t.path) : null;
	}

    /** Scripts referenced by MCP's CLAUDE_PLUGIN_ROOT need the actual plugin directory. */
    async #downloadPluginAssets(name: string, stagingRoot: string, signal?: AbortSignal): Promise<string> {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("非法插件名");
        const entry = (await waitForInstall(this.#catalog(),signal)).mcpPlugins.get(name);
        signal?.throwIfAborted();
        if (!entry) throw new Error("插件不存在");
        const files=await this.#pluginFiles(entry,signal);
        const root = join(stagingRoot, `claude-${name}`);
        let wrapper:string|undefined;
        try{const raw=readFileSync(join(root,"package.json"),"utf8"),manifest=JSON.parse(raw);if(manifest.name===`claude-${name}` && manifest.pi?.skills?.includes("./skills"))wrapper=raw;}catch{}
        await installDirectory(root,async staging=>{
            for (const file of files) {
                const path=join(staging,file.relative);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,file.data,{mode:file.data.subarray(0,2).toString()==="#!" ? 0o755 : 0o644});
            }
            if(wrapper)writeFileSync(join(staging,"package.json"),wrapper);
        },signal);
        return root;
    }

    async #pluginFiles(entry:McpPluginEntry, signal?: AbortSignal):Promise<Array<{relative:string;data:Buffer}>> {
        const paths = (await this.#listFiles(entry.repo,signal))?.filter(path => path.startsWith(entry.dir));
        if (!paths?.length) throw new Error("无法读取插件目录，请稍后重试");
        return await mapConcurrent(paths, 6, async path => {
            const relative = path.slice(entry.dir.length);
            if (!relative || relative.split("/").some(part => part === ".." || part === ".") || relative.includes("\\")) throw new Error("非法插件文件路径");
            const response = await fetch(`${entry.repo.rawBase}/${path}`, { signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
            if (!response.ok) throw new Error(`插件文件下载失败: ${relative}`);
            return { relative, data: Buffer.from(await response.arrayBuffer()) };
        });
    }

	async hasPluginSkills(name: string, signal?: AbortSignal): Promise<boolean> { return !!(await waitForInstall(this.#catalog(),signal)).mcpPlugins.get(name)?.skillNames?.length; }

	/** MCP 型插件的服务器配置（安装=接入这些 MCP 服务器）。 */
	async getMcpPlugin(name: string, signal?: AbortSignal): Promise<Record<string, Record<string, unknown>> | null> {
		const entry = (await waitForInstall(this.#catalog(),signal)).mcpPlugins.get(name);
        signal?.throwIfAborted();
		if (!entry || !entry.hasMcp) return null;
		const raw = await this.#fetchText(`${entry.repo.rawBase}/${entry.dir}.mcp.json`,signal);
		if (!raw) throw new Error(`插件配置下载失败: ${name}`);
		try {
			const parsed = JSON.parse(raw);
 return (parsed.mcpServers ?? parsed) as Record<string, Record<string, unknown>>;
		} catch {
			throw new Error(`插件配置格式无效: ${name}`);
		}
	}

	#meta(name: string, entry: CatalogEntry): Promise<{ description: string; license: string | null }> {
		const key = `${entry.repo.repo}/${entry.prefix}${name}`;
		let pending = this.#metaPending.get(key);
		if (!pending) {
			pending = this.#loadMeta(name, entry).finally(() => this.#metaPending.delete(key));
			this.#metaPending.set(key, pending);
		}
		return pending;
	}

	async #loadMeta(name: string, entry: CatalogEntry): Promise<{ description: string; license: string | null }> {
		const cacheKey = `${entry.repo.repo}/${entry.prefix}${name}`;
 const cached = this.#descriptions.get(cacheKey);
		if (cached) return cached;
		const raw = await this.#fetchText(`${entry.repo.rawBase}/${entry.prefix}skills/${name}/SKILL.md`);
		if (raw === null) return { description: "", license: null };
		const fm = raw.match(/^---\n([\s\S]*?)\n---/);
		const description =
			fm?.[1]?.match(/description:\s*"?([\s\S]*?)"?\s*\n\w/i)?.[1]?.trim() ??
			fm?.[1]?.match(/description:\s*(.+)/)?.[1]?.trim() ??
			"";
		const license = fm?.[1]?.match(/license:\s*(.+)/)?.[1]?.trim() ?? null;
		const meta = { description: description.replace(/^"|"$/g, "").slice(0, 300), license };
		this.#descriptions.set(cacheKey, meta);
		return meta;
	}

	/** 下载技能全部文件到目标目录（目录 API 不可用时仅 SKILL.md）。 */
	async #downloadSkillFiles(name: string, entry: CatalogEntry, targetDir: string, signal?: AbortSignal): Promise<string[]> {
        const paths = await this.#skillFilePaths(name, entry,signal);
        if (!paths.length && entry.fileCount > 1) throw new Error(`无法读取完整技能目录，请稍后重试: ${name}`);
        const selected = paths.length ? paths : [`${entry.prefix}skills/${name}/SKILL.md`];
        const files = await mapConcurrent(selected, 6, async path => {
            const relative = path.slice(`${entry.prefix}skills/${name}/`.length);
            if (!relative || relative.split("/").some(part => part === ".." || part === ".") || relative.includes("\\")) throw new Error("非法技能文件路径");
            try {
                const response = await fetch(`${entry.repo.rawBase}/${path}`, { signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
                if (!response.ok) return null;
                return { relative, data: Buffer.from(await response.arrayBuffer()) };
            } catch { signal?.throwIfAborted(); return null; }
        });
        // Download all files before writing; preserve binary assets and reject partial installs.
        if (files.some(file => !file)) return [];
        const written: string[] = [];
        for (const file of files) {
            if (!file) continue;
            const to = join(targetDir, file.relative);
            mkdirSync(dirname(to), { recursive: true });
            writeFileSync(to, file.data);
            written.push(file.relative);
            this.#opts.emit("market:progress", { message: `下载 ${name}/${file.relative}` });
        }
        if (!paths.length) this.#opts.emit("market:progress", { message: `${name}：目录 API 不可用，仅安装 SKILL.md（不含脚本/资源）` });
        return written;
	}

	async #skillFilePaths(name: string, entry: CatalogEntry, signal?: AbortSignal): Promise<string[]> {
		const paths = await this.#listFiles(entry.repo,signal);
		if (!paths) return [];
		return paths.filter((p) => p.startsWith(`${entry.prefix}skills/${name}/`));
	}

	async #fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
		try {
			const res = await fetch(url, {
				headers: { accept: "application/vnd.github+json", "user-agent": "pi-harness" },
				signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
			});
			if (!res.ok) return null;
			return await res.json();
		} catch {
			signal?.throwIfAborted();
			return null;
		}
	}

	async #fetchText(url: string, signal?: AbortSignal): Promise<string | null> {
		try {
			const res = await fetch(url, { signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
			if (!res.ok) return null;
			return await res.text();
		} catch {
			signal?.throwIfAborted();
			return null;
		}
	}
}
