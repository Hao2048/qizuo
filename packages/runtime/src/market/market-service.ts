function toVis(v: unknown): "public" | "private" {
	return v === "private" ? "private" : "public";
}

/**
 * MarketService：市场基础版。
 * - 已安装：pi 包（settings.json 声明）+ 本地 skills/extensions 目录扫描
 * - npm 安装：DefaultPackageManager（自动下载声明依赖）
 * - 本地安装：目录/文件 → pi 本地源（原文件不改写）
 * - 目录搜索：npm registry 关键词 pi-package
 */
import { DirectoryIndex } from "./directory-index.js";
import { mapConcurrent } from "./concurrency.js";
import { sealInstall } from "./install-operations.js";
import { installNpmDirectory } from "./npm-install.js";
import { installBundle, recoverBundleInstalls, stageInstall, type InstallChange } from "./bundle-install.js";
import { recoverDirectoryInstalls } from "./directory-install.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** 基础能力插件：赋予 harness 核心能力，UI 单独分区展示；服务端禁止移除与设为私有。 */
function coreSource(source: string): string {
	return source.match(/^(npm:(?:@[^/]+\/)?[^@]+)(?:@.*)?$/)?.[1] ?? source;
}

const CORE_PLUGINS = new Map<string, string>([
	["npm:pi-web-access", "联网能力：网页搜索、URL 抓取、GitHub 克隆、PDF 与视频理解"],
	["npm:@amaster.ai/pi-computer-use", "电脑控制：截屏录屏、鼠标键盘操作、界面元素理解"],
	["npm:pi-subagents", "子代理舰队：委派评审/勘察/实现，独立模型与 worktree 隔离"],
	["npm:pi-goal-x", "目标规划：跨会话目标跟踪、持久进度与独立复查"],
	["npm:pi-lens", "代码反馈：LSP、lint、类型检查改动即时回贴"],
	["npm:billion-context", "上下文压缩：接近上限自动压缩，长任务续航"],
]);
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { InstalledPackageInfo, InstalledSkillInfo, NpmSearchItem } from "@pi-harness/contracts";
import type { Logger } from "../logging/logger.js";

export interface MarketServiceOptions {
	agentDir: string;
	cwd: string;
	logger: Logger;
	emit: (type: string, payload: unknown) => void;
	/** 记录/查询资源可见性（public/private） */
	getVisibility: (name: string, kind: "skill" | "package") => "public" | "private";
	setVisibilityRow: (
		name: string,
		kind: "skill" | "package",
		visibility: "public" | "private",
		source: string | null,
	) => void;
	/** 读取包的存储声明源（恢复公开时回填用） */
	getVisibilitySource?: (name: string) => string | null;
	listPrivatePackages?: () => Array<{ name: string; source: string | null }>;
	deleteVisibilityRow?: (name: string, kind: "package") => void;
}

export class MarketService {
	#index=new DirectoryIndex();
	#pm: DefaultPackageManager;
	#settings: SettingsManager;
	#opts: MarketServiceOptions;

	private constructor(pm: DefaultPackageManager, settings: SettingsManager, opts: MarketServiceOptions) {
		this.#pm = pm;
		this.#settings = settings;
		this.#opts = opts;
		pm.setProgressCallback((event) => {
			const message = [event.type, event.action, event.source, event.message].filter(Boolean).join(" · ");
			this.#opts.emit("market:progress", { message });
		});
	}

	static async create(opts: MarketServiceOptions): Promise<MarketService> {
		try { recoverBundleInstalls(dirname(opts.agentDir),basename(opts.agentDir)); recoverDirectoryInstalls(opts.agentDir); }
		catch (error) { opts.logger.warn("npm 安装恢复失败，已保留现场", { message: String(error) }); }
		const settingsManager = await SettingsManager.create(opts.cwd, opts.agentDir);
		const pm = new DefaultPackageManager({ cwd: opts.cwd, agentDir: opts.agentDir, settingsManager });
		return new MarketService(pm, settingsManager, opts);
	}

	listInstalled(): { packages: InstalledPackageInfo[]; localSkills: InstalledSkillInfo[]; localExtensions: string[] } {
		const packages = this.#pm
			.listConfiguredPackages()
			.filter((p) => !p.filtered)
			.map((p) => ({
				source: p.source,
				scope: p.scope,
				installedPath: p.installedPath ?? null,
				visibility: toVis(this.#opts.getVisibility(p.source, "package")),
				core: CORE_PLUGINS.has(coreSource(p.source)) || undefined,
				intro: CORE_PLUGINS.get(coreSource(p.source)),
			}));
		// 默认加载声明与安装清单分开：私有包仍可管理、绑定、恢复公开。
		for (const p of this.#opts.listPrivatePackages?.() ?? []) {
			if (packages.some((entry) => entry.source === p.name)) continue;
			packages.push({
				source: p.name,
				scope: "user",
				installedPath: this.resolvePackagePath(p.source ?? p.name),
				visibility: "private",
				core: undefined,
				intro: undefined,
			});
		}
		// 本地 skills 目录（含从包内解出的？——包内技能由包整体控制；此处仅本地目录技能）
		const localSkills: InstalledSkillInfo[] = this.#scanDir(join(this.#opts.agentDir, "skills")).map((name) => ({
			name,
			source: "local",
			visibility: toVis(this.#opts.getVisibility(name, "skill")),
		}));
		return {
			packages,
			localSkills,
			localExtensions: this.#scanDir(join(this.#opts.agentDir, "extensions")),
		};
	}

	/** 可绑定资源清单（角色卡下拉用）：包（按 source 名）+ 本地技能。 */
	listBindable(): Array<{ name: string; kind: "skill" | "package" }> {
		const { packages, localSkills } = this.listInstalled();
		return [
			...packages.map((p) => ({ name: p.source, kind: "package" as const })),
			...localSkills.map((s) => ({ name: s.name, kind: "skill" as const })),
		];
	}

	/**
	 * 设置可见性。package 私有 = 从 pi settings.json 声明移除（文件保留，绑定角色经路径注入）；
	 * 恢复公开 = 重新写入声明。
	 */
	async setVisibility(
		name: string,
		kind: "skill" | "package",
		visibility: "public" | "private",
	): Promise<{ ok: boolean; message?: string }> {
		return this.#serialize(() => this.#setVisibility(name, kind, visibility));
	}

	async #setVisibility(
		name: string,
		kind: "skill" | "package",
		visibility: "public" | "private",
	): Promise<{ ok: boolean; message?: string }> {
		if (kind === "package" && CORE_PLUGINS.has(coreSource(name))) {
			return { ok: false, message: "基础能力插件不可移除或设为私有" };
		}
		try {
			if (kind === "package") {
				if (visibility === "private") {
					if (this.#opts.getVisibility(name, "package") === "private") return { ok: true };
					const configured = this.#pm.listConfiguredPackages().find((p) => p.source === name);
					if (!configured) return { ok: false, message: `包未安装: ${name}` };
					// npm:/git: 规格原样透传，本地声明转绝对路径（与 remove 同语义）
					if (!this.#pm.removeSourceFromSettings(this.#normalizeSource(configured.source))) {
						return { ok: false, message: "从默认加载移除失败（声明未命中）" };
					}
					this.#opts.setVisibilityRow(name, "package", "private", configured.source);
					this.#opts.logger.info("包设为私有（从默认加载移除）", { name });
				} else {
					// 恢复公开：用存储的原始声明源回填（npm:/git: 原样，本地转绝对路径）
					const row = this.#opts.getVisibilitySource?.(name);
					const sourceToRestore = row ?? name;
					if (
						!this.#pm.listConfiguredPackages().some((p) => p.source === sourceToRestore) &&
						!this.#pm.addSourceToSettings(this.#normalizeSource(sourceToRestore))
					) {
						return { ok: false, message: "恢复默认加载失败（声明未命中）" };
					}
					this.#opts.setVisibilityRow(name, "package", "public", null);
					this.#opts.logger.info("包设为公开（恢复默认加载）", { name });
				}
			} else {
				this.#opts.setVisibilityRow(name, "skill", visibility, null);
			}
			return { ok: true };
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		}
	}

	/** 包安装路径（供私有包路径注入）。 */
	resolvePackagePath(source: string): string | null {
		return this.#pm.getInstalledPath(source, "user") ?? null;
	}

	/** pi.dev 官方包画廊（服务端渲染页解析；失败如实说明）。npm 源附带近 30 天下载量（进程内缓存 1h）。 */
	#dlCache = new Map<string, { at: number; map: Map<string, number | null> }>();

	/** npm 近 30 天下载量：非作用域包批量、作用域包逐个（bulk 接口不支持 scoped）。失败降级为 null。 */
	async #npmDownloads(names: string[]): Promise<Map<string, number | null>> {
		const picked = [...new Set(names)].slice(0, 80);
		if (picked.length === 0) return new Map();
		const cacheKey = picked.join(",");
		const hit = this.#dlCache.get(cacheKey);
		if (hit && Date.now() - hit.at < 3600_000) return hit.map;
		const map = new Map<string, number | null>();
		const plain = picked.filter((n) => !n.startsWith("@"));
		const scoped = picked.filter((n) => n.startsWith("@"));
		if (plain.length > 0) {
			try {
				const res = await fetch(`https://api.npmjs.org/downloads/point/last-month/${plain.join(",")}`, {
					headers: { accept: "application/json" },
					signal: AbortSignal.timeout(15_000),
				});
				if (res.ok) {
					const data = (await res.json()) as Record<string, { downloads?: number }>;
					for (const [k, v] of Object.entries(data)) {
						if (typeof v?.downloads === "number") map.set(k, v.downloads);
					}
				}
			} catch {
				this.#opts.logger.warn("pi 画廊下载量获取失败", {});
			}
		}
		await mapConcurrent(scoped.slice(0, 20), 5, async (name) => {
			try {
				const res = await fetch(`https://api.npmjs.org/downloads/point/last-month/${name}`, {
					headers: { accept: "application/json" },
					signal: AbortSignal.timeout(10_000),
				});
				if (res.ok) {
					const v = (await res.json()) as { downloads?: number; package?: string };
					if (typeof v.downloads === "number") map.set(v.package ?? name, v.downloads);
				}
			} catch {
				/* 单包失败降级为无下载量 */
			}
		});
		this.#dlCache.set(cacheKey, { at: Date.now(), map });
		if (this.#dlCache.size > 128) {
			const oldest = [...this.#dlCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (oldest) this.#dlCache.delete(oldest[0]);
		}
		return map;
	}

	async listPiGallery(query?: string): Promise<{
		items: Array<{ source: string; name: string; description: string | null; downloads: number | null; popularity?: number }>;
		note?: string;
	}> {
		// 数据源 = pi.dev 官方精选（约 50 个，带官网描述）+ npm 全量 pi-package 生态（1 万+，registry 搜索）
		const gallery = await this.#piDevGallery();
		// 中英别名并发检索：飞书 ⇄ lark ⇄ feishu（npm 描述多为英文，中文词直接搜不到 lark 系包）
		const q = query?.trim().toLowerCase() ?? "";
		let npmItems = await this.#searchNpmRaw(query ?? "", 100);
		let aliasHits: Set<string> | null = null;
		if (/飞书|feishu|lark/i.test(q)) {
			const stripped = query!
				.replace(/飞书|feishu|lark/gi, " ")
				.replace(/\s+/g, " ")
				.trim();
			const extras = (
				await Promise.all(["lark", "feishu"].map((extra) => this.#searchNpmRaw(`${stripped} ${extra}`.trim(), 50)))
			).flat();
			aliasHits = new Set(extras.map((x) => x.name));
			npmItems = [...npmItems, ...extras.filter((x) => !npmItems.some((o) => o.name === x.name))];
		}
		const merged = new Map<
			string,
			{ source: string; name: string; description: string | null; downloads: number | null; featured: boolean; popularity?: number }
		>();
		for (const g of gallery) {
			merged.set(g.name, {
				source: g.source,
				name: g.name,
				description: g.description,
				downloads: null,
				featured: true,
			});
		}
		for (const n of npmItems) {
			if (merged.has(n.name)) { merged.get(n.name)!.popularity = n.popularity; continue; }
			merged.set(n.name, {
				source: `npm:${n.name}`,
				name: n.name,
				description: n.description,
				downloads: null,
				featured: false,
 popularity: n.popularity,
			});
		}
		let items = [...merged.values()];
		if (q) {
			items = items.filter(
				(i) =>
					i.name.toLowerCase().includes(q) ||
					(i.description ?? "").toLowerCase().includes(q) ||
					(aliasHits?.has(i.name) ?? false),
			);
		}
		// 精选在前；其余按下载量降序
		const dl = await this.#npmDownloads(items.filter((i) => i.source.startsWith("npm:")).map((i) => i.source.slice(4)));
		for (const i of items) {
			if (i.source.startsWith("npm:")) i.downloads = dl.get(i.source.slice(4)) ?? null;
		}
		items.sort((a, b) => Number(b.featured) - Number(a.featured) || (b.downloads ?? -1) - (a.downloads ?? -1));
		const note =
			gallery.length === 0 && npmItems.length === 0
				? "pi.dev 与 npm 检索均不可用（网络）"
				: items.length === 0
					? "无匹配"
					: undefined;
		return { items, note };
	}

	/** pi.dev 官方精选画廊（SSR 页解析；失败返回空并如实说明）。 */
	async #piDevGallery(): Promise<Array<{ source: string; name: string; description: string | null }>> {
		try {
			const res = await fetch("https://pi.dev/packages", {
				headers: { "user-agent": "pi-harness" },
				signal: AbortSignal.timeout(20_000),
			});
			if (!res.ok) {
				this.#opts.logger.warn("pi.dev 画廊不可用", { status: res.status });
				return [];
			}
			const html = await res.text();
			const items: Array<{ source: string; name: string; description: string | null }> = [];
			const seen = new Set<string>();
			for (const m of html.matchAll(/pi install (npm:[A-Za-z0-9@/._-]+|git:[A-Za-z0-9@/._-]+)/g)) {
				const source = m[1]!;
				if (seen.has(source)) continue;
				seen.add(source);
				const seg = html.slice(Math.max(0, m.index! - 3000), m.index!);
				const pdesc = [...seg.matchAll(/<p[^>]*>(.*?)<\/p>/gs)].pop();
				const desc = pdesc
					? pdesc[1]!
							.replace(/<[^>]+>/g, "")
							.trim()
							.slice(0, 160)
					: null;
				items.push({ source, name: source.replace(/^(npm:|git:)/, ""), description: desc || null });
			}
			return items;
		} catch {
			this.#opts.logger.warn("pi.dev 画廊不可达", {});
			return [];
		}
	}

	/** npm registry 原始搜索（pi-package 关键字 + 用户词）。 */
	/** 变更类操作串行队列：防并发安装时 process.env 摘除/恢复交错、mcp.json/settings 读改写丢失更新 */
	#opQueue: Promise<unknown> = Promise.resolve();

	#serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#opQueue.then(fn, fn);
		this.#opQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * npm 11 安装脚本策略：环境变量级的 allow-scripts 在 --prefix 项目化安装下会被硬拒（EALLOWSCRIPTS，
	 * "Add the entries to the allowScripts field in package.json, or to .npmrc"）。
	 * 经 npx/pnpm/vitest 启动时用户 ~/.npmrc 的配置会被注入为 npm_config_* 环境变量，触发该拒绝。
	 * 安装/卸载期间临时摘除（文件级 ~/.npmrc 与项目 package.json 的 allowScripts 不受影响），完成后恢复。
	 */
	async #withNpmScriptPolicy<T>(fn: () => Promise<T>): Promise<T> {
		const keys = Object.keys(process.env).filter((k) => /^npm_config_(allow_scripts|install_scripts)$/.test(k));
		const saved = keys.map((k) => [k, process.env[k] as string] as const);
		for (const k of keys) delete process.env[k];
		try {
			return await fn();
		} finally {
			for (const [k, v] of saved) process.env[k] = v;
		}
	}

	async #searchNpmRaw(query: string, size: number): Promise<Array<{ name: string; description: string | null; popularity?: number }>> {
		const text = encodeURIComponent(`keywords:"pi-package" ${query}`.trim());
		try {
			const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${text}&size=${size}`, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(15_000),
			});
			if (!res.ok) return [];
			const data = (await res.json()) as {
				objects?: Array<{ package: { name: string; description?: string }; score?: { detail?: { popularity?: number } } }>;
			};
			return (data.objects ?? []).map((o) => ({ name: o.package.name, description: o.package.description ?? null, popularity: o.score?.detail?.popularity }));
		} catch {
			return [];
		}
	}

	async installFromNpm(spec: string, signal?: AbortSignal): Promise<{ ok: boolean; message?: string }> {
		const source = /^(npm:|git:)/.test(spec) ? spec : `npm:${spec}`;
		try {
			await this.#serialize(() => this.#withNpmScriptPolicy(async () => {
				signal?.throwIfAborted();
				if (!source.startsWith("npm:")) { sealInstall(signal); await this.#pm.installAndPersist(source); return; }
				await this.#settings.reload();
				await this.#bundle(async work => {
					const stagedAgent = join(work,"staged-agent");
					await stageInstall(signal,child => installNpmDirectory({
						agentDir: stagedAgent, cwd: this.#opts.cwd, source,
						sourceDirectory:join(this.#opts.agentDir,"npm"), settings:this.#settings.getSettings(),signal:child,
						progress:event => this.#opts.emit("market:progress",{message:[event.type,event.action,event.source,event.message].filter(Boolean).join(" · ")}),
					}));
					return () => [
						{target:`${basename(this.#opts.agentDir)}/npm`,staged:join(stagedAgent,"npm")},
						this.prepareSourceDeclaration(source,join(work,"settings.next")),
					];
				},signal);
			}));
			this.#opts.logger.info("市场安装完成", { source });
			return { ok: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.#opts.logger.warn("市场安装失败", { source, message });
			return { ok: false, message };
		}
	}

	/** Serialize bundle changes with npm/local install, removal and visibility changes. */
	installBundle(build:(work:string)=>Promise<()=>InstallChange[]>,signal?:AbortSignal):Promise<void> {
		return this.#serialize(()=>this.#bundle(build,signal));
	}
	async #bundle(build:(work:string)=>Promise<()=>InstallChange[]>,signal?:AbortSignal):Promise<void> {
		await this.#settings.flush();
		try { await installBundle(dirname(this.#opts.agentDir),basename(this.#opts.agentDir),build,signal); }
		finally { await this.#settings.reload(); }
	}
	/** Called synchronously at commit time; merge only packages into the latest disk settings. */
	prepareSourceDeclaration(source:string,staged:string):InstallChange {
		const path=join(this.#opts.agentDir,"settings.json");
		const raw=existsSync(path)?JSON.parse(readFileSync(path,"utf8")):{};
		if(!raw || typeof raw!=="object" || Array.isArray(raw) || raw.packages && !Array.isArray(raw.packages))throw new Error("加载配置格式无效，已有文件未覆盖");
		const memory=SettingsManager.inMemory(raw);
		new DefaultPackageManager({cwd:this.#opts.cwd,agentDir:this.#opts.agentDir,settingsManager:memory}).addSourceToSettings(source);
		writeFileSync(staged,JSON.stringify({...raw,packages:memory.getGlobalSettings().packages},null,"\t"),{mode:0o600});
		return {target:`${basename(this.#opts.agentDir)}/settings.json`,staged};
	}

	async installLocal(path: string, signal?: AbortSignal): Promise<{ ok: boolean; message?: string }> {
		if (!existsSync(path)) return { ok: false, message: `路径不存在: ${path}` };
		try {
			// 用户级本地源声明：原文件保留在用户选择的路径。
			await this.#serialize(() => {signal?.throwIfAborted();return this.#pm.installAndPersist(path);});
			this.#opts.logger.info("本地安装完成", { path });
			return { ok: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.#opts.logger.warn("本地安装失败", { path, message });
			return { ok: false, message };
		}
	}

	/** pi 声明源规整：npm:/git: 规格必须原样透传（pi 的 parseSource 按前缀解析）；本地声明转绝对路径。 */
	#normalizeSource(source: string): string {
		if (/^(npm:|git:)/.test(source) || source.startsWith("/")) return source;
		return resolve(this.#opts.agentDir, source);
	}

	async remove(source: string): Promise<{ ok: boolean; message?: string }> {
		if (CORE_PLUGINS.has(coreSource(source))) {
			this.#opts.logger.warn("拒绝移除基础能力插件", { source });
			return { ok: false };
		}
		try {
			const removed = await this.#serialize(async () => {
				const wasPrivate = this.#opts.getVisibility(source, "package") === "private";
				const declaredSource = this.#opts.getVisibilitySource?.(source) ?? source;
				const normalized = this.#normalizeSource(declaredSource);
				if (wasPrivate) this.#pm.addSourceToSettings(normalized);
				try {
					const ok = await this.#withNpmScriptPolicy(() => this.#pm.removeAndPersist(normalized));
					if (ok) this.#opts.deleteVisibilityRow?.(source, "package");
					return ok;
				} finally {
					if (wasPrivate) this.#pm.removeSourceFromSettings(normalized);
				}
			});
			if (!removed) {
				this.#opts.logger.warn("市场移除未命中声明", { source });
				return { ok: false, message: "包声明未找到（可能已被移除）" };
			}
			return { ok: true };
		} catch (err) {
			this.#opts.logger.warn("市场移除失败", {
				source,
				message: err instanceof Error ? err.message : String(err),
			});
			return { ok: false };
		}
	}

	/** npm registry 搜索（关键词 pi-package + 用户词）。失败如实返回空并记日志。 */
	async searchNpm(query: string): Promise<NpmSearchItem[]> {
		const text = encodeURIComponent(`keywords:"pi-package" ${query}`.trim());
		const url = `https://registry.npmjs.org/-/v1/search?text=${text}&size=20`;
		try {
			const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
			if (!res.ok) {
				this.#opts.logger.warn("npm 搜索失败", { status: res.status });
				return [];
			}
			const data = (await res.json()) as {
				objects?: Array<{
					package: {
						name: string;
						description?: string;
						version?: string;
						publisher?: { username?: string };
						date?: string;
					};
				}>;
			};
			return (data.objects ?? []).map((o) => ({
				name: o.package.name,
				description: o.package.description ?? null,
				version: o.package.version ?? null,
				publisher: o.package.publisher?.username ?? null,
				date: o.package.date ?? null,
			}));
		} catch (err) {
			this.#opts.logger.warn("npm 搜索异常", {
				message: err instanceof Error ? err.message : String(err),
			});
			return [];
		}
	}

	/**
	 * M7 每日推荐：pi-package 关键词搜索 → 近 30 天下载量（npm downloads 批量接口）排序。
	 * 结果按日缓存（app_meta），失败如实降级（无下载量字段）。
	 */
	async recommend(meta: {
		get: (k: string) => string | null;
		set: (k: string, v: string) => void;
	}): Promise<{
		items: Array<{ name: string; description: string | null; downloads: number | null; source: string }>;
		generatedAt: number;
		note?: string;
	}> {
		const today = new Date().toISOString().slice(0, 10);
		const cached = meta.get("market_recommend");
		if (cached) {
			try {
				const parsed = JSON.parse(cached) as {
					day: string;
					items: Array<{ name: string; description: string | null; downloads: number | null; source: string }>;
				};
				if (parsed.day === today) return { items: parsed.items, generatedAt: Date.parse(`${today}T00:00:00Z`) };
			} catch {
				/* 缓存损坏 → 重建 */
			}
		}
		const results = await this.searchNpm("");
		if (results.length === 0) {
			return { items: [], generatedAt: Date.now(), note: "npm 检索不可用（网络），今日无推荐" };
		}
		const top = results.slice(0, 20);
		const names = top.map((r) => r.name);
		const downloads = await this.#npmDownloads(names);
		const items = top
			.map((r) => ({
				name: r.name,
				description: r.description ?? null,
				downloads: downloads.get(r.name) ?? null,
				source: "npm",
			}))
			.sort((a, b) => (b.downloads ?? -1) - (a.downloads ?? -1))
			.slice(0, 10);
		const payload = { day: today, items };
		meta.set("market_recommend", JSON.stringify(payload));
		return {
			items,
			generatedAt: Date.now(),
			note: downloads.size === 0 ? "下载量不可用，按检索顺序推荐" : undefined,
		};
	}

	#scanDir(dir: string): string[] {return this.#index.list(dir);}
}
