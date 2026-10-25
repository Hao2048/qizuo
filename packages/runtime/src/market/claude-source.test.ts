/**
 * Claude 技能源测试（mock fetch，零网络）：
 * 目录解析（trees API）、限流回退、frontmatter 解析、安装写盘（完整/回退/重复/失败）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSkillSource } from "./claude-source.js";
import { Logger } from "../logging/logger.js";

let dir: string;
let agentDir: string;
let events: string[];

const TREE_JSON = {
	tree: [
		{ path: "README.md", type: "blob" },
		{ path: "skills/docx/SKILL.md", type: "blob" },
		{ path: "skills/docx/scripts/convert.py", type: "blob" },
		{ path: "skills/docx/references/formats.md", type: "blob" },
		{ path: "skills/pdf/SKILL.md", type: "blob" },
		{ path: "spec/agentskills.md", type: "blob" },
		{ path: "skills", type: "tree" },
	],
};

const SKILL_DOCX = `---
name: docx
description: "Use this skill whenever the user wants to create or edit Word documents."
license: Proprietary
---

# DOCX creation`;
const SKILL_PDF = `---
name: pdf
description: PDF 处理技能
---

# PDF`;

function mockFetch(handler: (url: string) => { status: number; body: string } | undefined) {
	return vi.fn(async (url: unknown) => {
		const r = handler(String(url));
		if (!r) return new Response("{}", { status: 404 });
		return new Response(r.body, { status: r.status });
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pih-claude-"));
	agentDir = join(dir, "pi");
	events = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

function makeSource(): ClaudeSkillSource {
	return new ClaudeSkillSource({
		agentDir,
		logger: new Logger(),
		emit: (t, p) => events.push(`${t}:${JSON.stringify(p)}`),
	});
}

describe("ClaudeSkillSource", () => {
	it("目录解析：trees API 分组、frontmatter 描述/许可证提取", async () => {
		vi.stubGlobal(
			"fetch",
			mockFetch((url) => {
				if (url.includes("/git/trees/")) return { status: 200, body: JSON.stringify(TREE_JSON) };
				if (url.endsWith("/skills/docx/SKILL.md")) return { status: 200, body: SKILL_DOCX };
				if (url.endsWith("/skills/pdf/SKILL.md")) return { status: 200, body: SKILL_PDF };
				return undefined;
			}),
		);
		const src = makeSource();
		const items = await src.list();
		expect(items.map((i) => i.name)).toEqual(["docx", "pdf"]);
		expect(items[0]!.fileCount).toBe(3);
		expect(items[0]!.description).toContain("Word documents");
		expect(items[0]!.license).toContain("Proprietary");
		expect(items[0]!.fallback).toBe(false);

		const search = await src.list("pdf");
		expect(search.map((i) => i.name)).toEqual(["pdf"]);
	});

	it("限流回退：trees API 失败 → 精选清单 + fallback 标记", async () => {
		vi.stubGlobal(
			"fetch",
			mockFetch((url) => {
				if (url.includes("/git/trees/")) return { status: 403, body: '{"message":"rate limit"}' };
				if (url.endsWith("/skills/pdf/SKILL.md")) return { status: 200, body: SKILL_PDF };
				if (url.endsWith("/skills/docx/SKILL.md")) return { status: 200, body: SKILL_DOCX };
				return undefined;
			}),
		);
		const src = makeSource();
		const items = await src.list();
		expect(items.length).toBeGreaterThanOrEqual(2);
		expect(items.every((i) => i.fallback)).toBe(true);
	});

	it("安装（完整目录）：SKILL.md + 脚本 + 参考全部落盘", async () => {
		vi.stubGlobal(
			"fetch",
			mockFetch((url) => {
				if (url.includes("/git/trees/")) return { status: 200, body: JSON.stringify(TREE_JSON) };
				if (url.endsWith("/skills/docx/SKILL.md")) return { status: 200, body: SKILL_DOCX };
				if (url.endsWith("scripts/convert.py")) return { status: 200, body: "print('convert')" };
				if (url.endsWith("references/formats.md")) return { status: 200, body: "formats" };
				return undefined;
			}),
		);
		const src = makeSource();
		const r = await src.install("docx");
		expect(r.ok).toBe(true);
		expect(r.files.sort()).toEqual(["SKILL.md", "references/formats.md", "scripts/convert.py"].sort());
		expect(readFileSync(join(agentDir, "skills", "docx", "SKILL.md"), "utf8")).toContain("DOCX");
		expect(existsSync(join(agentDir, "skills", "docx", "scripts", "convert.py"))).toBe(true);
		expect(events.some((e) => e.startsWith("market:progress"))).toBe(true);
	});

	it("安装（回退模式）：仅 SKILL.md 且消息如实标注", async () => {
		let treesCalled = false;
		vi.stubGlobal(
			"fetch",
			mockFetch((url) => {
				if (url.includes("/git/trees/")) {
					treesCalled = true;
					return { status: 403, body: "{}" };
				}
				if (url.endsWith("/skills/pdf/SKILL.md")) return { status: 200, body: SKILL_PDF };
				return undefined;
			}),
		);
		const src = makeSource();
		const r = await src.install("pdf");
		expect(r.ok).toBe(true);
		expect(r.files).toEqual(["SKILL.md"]);
		expect(events.some((e) => e.includes("仅安装 SKILL.md"))).toBe(true);
		expect(treesCalled).toBe(true);
	});

	it("重复安装拒绝；非法名拒绝；下载失败如实报错", async () => {
		vi.stubGlobal(
			"fetch",
			mockFetch((url) => {
				if (url.endsWith("/skills/pdf/SKILL.md")) return { status: 200, body: SKILL_PDF };
				return { status: 403, body: "{}" };
			}),
		);
		const src = makeSource();
		const bad = await src.install("../evil");
		expect(bad.ok).toBe(false);

		const first = await src.install("pdf");
		expect(first.ok).toBe(true);
		const again = await src.install("pdf");
		expect(again.ok).toBe(false);
		expect(again.message).toContain("已安装");
	});

	it("详情：返回 SKILL.md 全文；不存在时报错", async () => {
		vi.stubGlobal(
			"fetch",
			mockFetch((url) => {
				return url.endsWith("/skills/pdf/SKILL.md") ? { status: 200, body: SKILL_PDF } : undefined;
			}),
		);
		const src = makeSource();
		const content = await src.detail("pdf");
		expect(content).toContain("# PDF");
		await expect(src.detail("nope")).rejects.toThrow(/不存在/);
	});
});

describe("Claude 官方仓库聚合", () => {
	const TREES = {
		"anthropics/skills": { tree: [{ path: "skills/docx/SKILL.md", type: "blob" }] },
		"anthropics/claude-code": {
			tree: [
				{ path: "plugins/code-review/skills/github-automation/SKILL.md", type: "blob" },
				{ path: "plugins/code-review/commands/review.md", type: "blob" },
			],
		},
		"davepoon/buildwithclaude": {
			tree: [{ path: "plugins/agent-triforce/skills/code-health/SKILL.md", type: "blob" }],
		},
	};
	it("官方技能与官方插件技能可搜，社区库不会混入官方来源", async () => {
		vi.stubGlobal(
			"fetch",
			mockFetch((url) => {
				for (const [repo, tree] of Object.entries(TREES)) {
					if (url.includes(`/repos/${repo}/git/trees/`)) return { status: 200, body: JSON.stringify(tree) };
				}
				if (url.endsWith("skills/github-automation/SKILL.md")) {
					return { status: 200, body: "---\\nname: github-automation\\ndescription: GitHub automation\\n---\\n# GH" };
				}
				return undefined;
			}),
		);
		const src = makeSource();
		const items = await src.list();
		expect(items.map((i) => i.name).sort()).toEqual(["docx", "github-automation"]);
		expect(items.find((i) => i.name === "github-automation")!.sourceLabel).toBe("Claude 官方插件");
		expect(items.find((i) => i.name === "code-health")).toBeUndefined();
		// 用户案例：github 类技能可搜到
		const hit = await src.list("github");
		expect(hit.map((i) => i.name)).toEqual(["github-automation"]);
	});
});

it("描述抓取最多 16 路，并发目录请求复用目录与描述", async () => {
	let active = 0,
		maxActive = 0,
		detailCalls = 0,
		catalogCalls = 0;
	const files = Array.from({ length: 40 }, (_, i) => ({ name: `/skills/test-${i}/SKILL.md` }));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: unknown) => {
			if (String(url).includes("data.jsdelivr.com")) {
				catalogCalls++;
				return new Response(JSON.stringify({ files }));
			}
			if (String(url).endsWith("SKILL.md")) {
				detailCalls++;
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 1));
				active--;
				return new Response("---\nname: test\ndescription: test skill\n---\nbody");
			}
			return new Response("{}", { status: 404 });
		}),
	);
	const src = makeSource();
	const lists = await Promise.all([src.list(), src.list()]);
	expect(lists[0]).toHaveLength(40);
	expect(lists[1]).toEqual(lists[0]);
	expect(maxActive).toBeLessThanOrEqual(16);
	expect(maxActive).toBeGreaterThan(1);
	expect(detailCalls).toBe(40);
	expect(catalogCalls).toBe(3);
});

it("official market separates native-only plugins, MCP, and bundled skills", async () => {
 const files = ["external_plugins/github/.mcp.json", "external_plugins/github/.claude-plugin/plugin.json", "plugins/workflow/.claude-plugin/plugin.json", "plugins/workflow/skills/review/SKILL.md", "plugins/native/.claude-plugin/plugin.json", "plugins/native/hooks/hooks.json"];
 vi.stubGlobal("fetch", mockFetch(url => {
 if (url.includes("data.jsdelivr.com") && url.includes("claude-plugins-official")) return { status: 200, body: JSON.stringify({ files: files.map(name => ({ name })) }) };
 if (url.endsWith(".mcp.json")) return { status: 200, body: JSON.stringify({ github: { url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" } } }) };
 if (url.endsWith("plugin.json")) return { status: 200, body: JSON.stringify({ description: "Official workflow" }) };
 if (url.endsWith("SKILL.md")) return { status: 200, body: "---\nname: review\ndescription: Code review\n---\nReview code" };
 return undefined;
 }));
 const source = makeSource(); const plugins = await source.list(undefined, "plugins");
 expect(plugins.map(x => x.name)).toEqual(["github", "native", "workflow"]);
 expect(plugins.find(x => x.name === "native")).toMatchObject({ installable: false });
 expect((await source.list(undefined, "skills")).map(x => x.name)).toEqual(["review"]);
 expect(await source.getMcpPlugin("github")).toMatchObject({ github: { headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" } } });
 const dir = await source.downloadForPackage("workflow", agentDir);
 expect(existsSync(join(dir,"skills/review/SKILL.md"))).toBe(true);
 expect(JSON.parse(readFileSync(join(dir,"package.json"),"utf8")).pi.skills).toEqual(["./skills"]);
 await expect(source.downloadForPackage("native",agentDir)).rejects.toThrow(/暂不支持/);
});

it("skill installation preserves binary assets and rejects incomplete downloads without writing SKILL.md", async () => {
 const files = ["skills/example/SKILL.md", "skills/example/assets/image.png"];
 let fail = true;
 const binary = new Uint8Array([137,80,78,71,255,0,1]);
 vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
 if (String(url).includes("data.jsdelivr.com")) return new Response(JSON.stringify({ files: files.map(name => ({name})) }));
 if (String(url).endsWith("SKILL.md")) return new Response("# Example");
 if (String(url).endsWith("image.png")) return fail ? new Response("", { status: 503 }) : new Response(binary);
 return new Response("{}", { status: 404 });
 }));
 const source = makeSource(); expect((await source.install("example")).ok).toBe(false);
 expect(existsSync(join(agentDir,"skills/example/SKILL.md"))).toBe(false);
 fail = false; expect((await source.install("example")).ok).toBe(true);
 expect(readFileSync(join(agentDir,"skills/example/assets/image.png"))).toEqual(Buffer.from(binary));
});

it("keeps a mixed plugin's skills, scripts and Pi manifest together across asset replacement",async()=>{
 const files=["plugins/mixed/.claude-plugin/plugin.json","plugins/mixed/.mcp.json","plugins/mixed/skills/review/SKILL.md","plugins/mixed/server.js"];
 let fail=false;
 vi.stubGlobal("fetch",mockFetch(url=>{
  if(url.includes("data.jsdelivr.com") && url.includes("claude-plugins-official"))return {status:200,body:JSON.stringify({files:files.map(name=>({name}))})};
  if(url.endsWith("plugin.json"))return {status:200,body:'{"description":"Mixed"}'};
  if(url.endsWith(".mcp.json"))return {status:200,body:'{"server":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.js"]}}'};
  if(url.endsWith("SKILL.md"))return {status:200,body:"# Review"};
  if(url.endsWith("server.js"))return {status:fail ? 503 : 200,body:"// server"};
  return undefined;
 }));
 const source=makeSource();const packageRoot=join(dir,"claude-pkg");const path=await source.downloadForPackage("mixed",packageRoot);
 expect(existsSync(join(path,"server.js"))).toBe(true);await source.downloadPluginAssets("mixed",packageRoot);expect(JSON.parse(readFileSync(join(path,"package.json"),"utf8")).pi.skills).toEqual(["./skills"]);
 fail=true;await expect(source.downloadForPackage("mixed",packageRoot)).rejects.toThrow();expect(readFileSync(join(path,"server.js"),"utf8")).toBe("// server");expect(existsSync(join(path,"skills/review/SKILL.md"))).toBe(true);
});

it("cancels parallel skill downloads, drains them and leaves no published files", async () => {
	let downloading = false, pending = 0;
	vi.stubGlobal("fetch", vi.fn(async (url: unknown, options?: RequestInit) => {
		const path = String(url);
		if (path.includes("/git/trees/")) return new Response(JSON.stringify(TREE_JSON));
		if (path.includes("/skills/docx/")) {
			if (!downloading) return new Response(SKILL_DOCX);
			pending++;
			return new Promise<Response>((_resolve, reject) => {
				const abort = () => { pending--; reject(options?.signal?.reason); };
				options?.signal?.addEventListener("abort", abort, { once: true });
				if (options?.signal?.aborted) abort();
			});
		}
		return new Response("{}", { status: 404 });
	}));
	const source = makeSource(); await source.list(); downloading = true;
	const controller = new AbortController(); const installing = source.install("docx", controller.signal);
	await vi.waitFor(() => expect(pending).toBe(3)); controller.abort(new Error("已取消安装"));
	expect(await installing).toEqual({ ok: false, message: "已取消安装", files: [] });
	expect(pending).toBe(0); expect(existsSync(join(agentDir, "skills/docx"))).toBe(false);
	expect(readdirSync(join(agentDir, "skills")).some(x => x.startsWith(".pih-install-"))).toBe(false);
});
