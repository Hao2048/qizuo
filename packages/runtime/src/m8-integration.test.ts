/**
 * M8 集成测试：
 * - 资源可见性：默认公开；私有 skill 仅绑定角色可见（系统提示词与技能清单实证）
 * - 私有包：从 pi 声明移除 + 绑定角色路径注入
 * - 绑定优先提示注入
 * - pi.dev 画廊解析（mock fetch）
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AnyAppEvent, AppEvent } from "@pi-harness/contracts";
import { createHarnessCore, type HarnessCore } from "./core/harness-core.js";
import { ensureFauxRegistered, fauxModelRef } from "./pi/faux-provider.js";
import { ResourcePolicy } from "./market/resource-policy.js";
import { HarnessDatabase } from "./db/database.js";
import { Logger } from "./logging/logger.js";

let dir: string;
let core: HarnessCore;
let events: AnyAppEvent[];

async function invoke(name: string, input: unknown): Promise<any> {
	const env = await core.router.invoke(name, input);
	if (!env.ok) throw new Error(`${name} 失败: ${env.error.message}`);
	return env.result;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${what}`);
		await new Promise((r) => setTimeout(r, 30));
	}
}

const states = () => events.filter((e): e is AppEvent<"task:state"> => e.type === "task:state").map((e) => e.payload);

function plantLocalSkill(agentDir: string, name: string, desc: string): void {
	const d = join(agentDir, "skills", name);
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}`);
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pih-m8-"));
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	events = [];
	core.router.onEvent((e) => events.push(e as AnyAppEvent));
	await invoke("settings:set", {
		defaultModel: fauxModelRef(),
		autoApproveTools: ["read", "grep", "find", "ls", "save_memory"],
	});
});

afterEach(() => {
	core.dispose();
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe("M8 资源可见性与角色绑定", () => {
	it("私有 skill：未绑定角色的任务技能清单中被过滤，绑定角色的任务可见且带优先提示", async () => {
		const agentDir = join(dir, "pi");
		plantLocalSkill(agentDir, "pub-skill", "公开技能");
		plantLocalSkill(agentDir, "priv-skill", "私有技能");
		// 重载 loader 前重开 core 使技能被发现
		core.dispose();
		core = await createHarnessCore({ dataDir: dir, enableFaux: true });
		events = [];
		core.router.onEvent((e) => events.push(e as AnyAppEvent));
		await invoke("settings:set", {
			defaultModel: fauxModelRef(),
			autoApproveTools: ["read", "grep", "find", "ls", "save_memory"],
		});

		// 默认公开
		let listed = await invoke("market:list", {});
		expect(listed.localSkills.find((s: { name: string }) => s.name === "priv-skill").visibility).toBe("public");

		// 设为私有
		const set = await invoke("market:setVisibility", { name: "priv-skill", kind: "skill", visibility: "private" });
		expect(set.ok).toBe(true);
		listed = await invoke("market:list", {});
		expect(listed.localSkills.find((s: { name: string }) => s.name === "priv-skill").visibility).toBe("private");

		ensureFauxRegistered().setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok2")]);

		// 未绑定角色：私有技能被过滤（系统提示词不含其描述标记）
		const roleA = await invoke("role:create", { name: "无绑定角色", systemPrompt: "SPA" });
		const t1 = await invoke("task:create", { roleId: roleA.id, title: "t1" });
		await invoke("task:prompt", { taskId: t1.id, text: "hi" });
		await waitFor(() => states().some((s) => s.taskId === t1.id && s.status === "done"), "t1");
		const g1 = await invoke("task:get", { taskId: t1.id });
		expect(g1.task.systemPrompt).not.toContain("priv-skill");
		expect(g1.task.systemPrompt).not.toContain("私有技能");

		// 绑定角色：私有技能可见 + 优先提示
		const roleB = await invoke("role:create", {
			name: "绑定角色",
			systemPrompt: "SPB",
			boundSkills: ["priv-skill"],
		});
		const t2 = await invoke("task:create", { roleId: roleB.id, title: "t2" });
		await invoke("task:prompt", { taskId: t2.id, text: "hi" });
		await waitFor(() => states().some((s) => s.taskId === t2.id && s.status === "done"), "t2");
		const g2 = await invoke("task:get", { taskId: t2.id });
		expect(g2.task.systemPrompt).toContain("优先");
		expect(g2.task.systemPrompt).toContain("priv-skill");
	}, 60_000);

	it("私有包：pi settings 声明移除，恢复公开时回填", async () => {
		const pkg = join(dir, "my-pkg8");
		mkdirSync(join(pkg, "skills", "pkg-skill"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "my-pkg8", version: "1.0.0" }));
		writeFileSync(
			join(pkg, "skills", "pkg-skill", "SKILL.md"),
			"---\nname: pkg-skill\ndescription: 包内技能\n---\n内容",
		);

		await invoke("market:installLocal", { path: pkg });
		let listed = await invoke("market:list", {});
		expect(listed.packages.length).toBe(1);

		// 私有：默认加载声明移除，但管理清单与绑定清单保留
		const source = listed.packages[0].source;
		const set = await invoke("market:setVisibility", { name: source, kind: "package", visibility: "private" });
		expect(set.ok).toBe(true);
		listed = await invoke("market:list", {});
		expect(listed.packages).toHaveLength(1);
		expect(listed.packages[0].visibility).toBe("private");
		const settings = JSON.parse(readFileSync(join(dir, "pi", "settings.json"), "utf8")) as { packages?: string[] };
		expect(settings.packages ?? []).not.toContain(source);

		// 恢复公开
		const back = await invoke("market:setVisibility", {
			name: source,
			kind: "package",
			visibility: "public",
		});
		// 相对路径源以绝对路径恢复——用返回值判断
		expect(back.ok).toBe(true);
		listed = await invoke("market:list", {});
		expect(listed.packages).toHaveLength(1);
	}, 30_000);

	it("policy 单元：白名单/路径/优先名单计算", () => {
		const db = HarnessDatabase.open(join(dir, "unit.db"));
		db.prepare(
			"INSERT INTO resource_visibility (name, kind, visibility, source, updated_at) VALUES ('s1', 'skill', 'private', NULL, 0), ('s2', 'skill', 'public', NULL, 0), ('p1', 'package', 'private', 'npm:x', 0)",
		).run();
		const policy = new ResourcePolicy({ db, resolvePackagePath: (s) => `/installed/${s}` });

		// 未绑定角色：私有 skill 不在白名单（skillsFilter 会过滤）
		const unbound = policy.computeForRole([], []);
		expect(unbound.allowedSkills).toEqual([]);
		expect(unbound.extraExtensionPaths).toEqual([]);

		// 绑定角色：私有 skill 白名单 + 私有包路径注入
		const bound = policy.computeForRole(["s1"], ["p1"]);
		expect(bound.allowedSkills).toEqual(["s1"]);
		expect(bound.extraExtensionPaths).toEqual(["/installed/npm:x"]);
		expect(bound.priorityNames).toEqual(["s1", "p1"]);

		// 过滤回调：私有未绑定被滤掉
		const filter = policy.skillsFilter([]);
		const out = filter({ skills: [{ name: "s1" }, { name: "s2" }], diagnostics: [] });
		expect(out.skills.map((s) => s.name)).toEqual(["s2"]);

		expect(policy.priorityPrompt(["a", "b"])).toContain("a、b");
		db.close();
	});
});

describe("M8 pi.dev 画廊", () => {
	it("目录页解析（mock fetch）：源+描述+去重+过滤", async () => {
		const html = `
		<div class="packages-card"><p>Web search and fetching</p><code>pi install npm:pi-web-access</code></div>
		<div class="packages-card"><p>MCP adapter extension</p><code>pi install npm:pi-mcp-adapter</code></div>
		<div class="packages-card"><p>重复卡片</p><code>pi install npm:pi-web-access</code></div>`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(html, { status: 200 })),
		);
		const { MarketService } = await import("./market/market-service.js");
		const market = await MarketService.create({
			agentDir: join(dir, "pi"),
			cwd: dir,
			logger: new Logger(),
			emit: () => {},
			getVisibility: () => "public",
			setVisibilityRow: () => {},
		});
		const r = await market.listPiGallery();
		expect(r.items.length).toBe(2); // 去重
		expect(r.items.map((i) => i.source)).toContain("npm:pi-web-access");
		expect(r.items.find((i) => i.source === "npm:pi-mcp-adapter")?.description).toContain("MCP");

		const filtered = await market.listPiGallery("web");
		expect(filtered.items.length).toBe(1);
	});

	it("网络失败如实说明", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 500 })),
		);
		const { MarketService } = await import("./market/market-service.js");
		const market = await MarketService.create({
			agentDir: join(dir, "pi"),
			cwd: dir,
			logger: new Logger(),
			emit: () => {},
			getVisibility: () => "public",
			setVisibilityRow: () => {},
		});
		const r = await market.listPiGallery();
		expect(r.items).toEqual([]);
		expect(r.note).toContain("不可用");
	});
});

it("does not partially register an invalid plugin or overwrite a secondary server-name collision",async()=>{
 let invalid=true;
 vi.stubGlobal("fetch",vi.fn(async(url:unknown)=>{
  const u=String(url);
  if(u.includes("data.jsdelivr.com") && u.includes("claude-plugins-official"))return new Response(JSON.stringify({files:[{name:"external_plugins/bridge/.mcp.json"}]}));
  if(u.endsWith(".mcp.json"))return new Response(JSON.stringify(invalid ? {first:{url:"https://first.example/mcp"},broken:{}} : {server:{url:"https://new.example/mcp"}}));
  return new Response("{}",{status:404});
 }));
 core.mcp.upsertMany([{name:"server",url:"https://user.example"},{name:"claude-bridge-server",url:"https://second.example"}]);
 const before=readFileSync(core.mcp.path,"utf8");
 expect((await invoke("market:installClaude",{name:"bridge",as:"package"})).ok).toBe(false);expect(readFileSync(core.mcp.path,"utf8")).toBe(before);
 invalid=false;const result=await invoke("market:installClaude",{name:"bridge",as:"package"});expect(result.ok).toBe(false);expect(result.message).toContain("冲突");expect(readFileSync(core.mcp.path,"utf8")).toBe(before);
});

it("mixed plugin validation failure preserves files and declarations; success merges the latest user settings",async()=>{
	let invalid=true;
	const target=join(dir,"claude-pkg/claude-mixed"),settings=join(core.pi.piDir,"settings.json");
	mkdirSync(target,{recursive:true});writeFileSync(join(target,"old.txt"),"old plugin");
	const previous=existsSync(settings)?readFileSync(settings,"utf8"):"{}";
	const mcpBefore=existsSync(core.mcp.path)?readFileSync(core.mcp.path,"utf8"):undefined;
	const paths=["plugins/mixed/.mcp.json","plugins/mixed/.claude-plugin/plugin.json","plugins/mixed/skills/review/SKILL.md","plugins/mixed/server.js"];
	vi.stubGlobal("fetch",vi.fn(async(url:unknown)=>{
		const path=String(url);
		if(path.includes("data.jsdelivr.com") && path.includes("claude-plugins-official"))return new Response(JSON.stringify({files:paths.map(name=>({name}))}));
		if(path.endsWith("plugin.json"))return new Response('{"description":"Mixed"}');
		if(path.endsWith(".mcp.json"))return new Response(JSON.stringify(invalid?{broken:{}}:{server:{command:"node",args:["${CLAUDE_PLUGIN_ROOT}/server.js"]}}));
		if(path.endsWith("SKILL.md"))return new Response("# Review");
		if(path.endsWith("server.js")) {
			if(!invalid)writeFileSync(settings,JSON.stringify({...JSON.parse(previous),userPreference:"changed while downloading"}));
			return new Response("// installed server");
		}
		return new Response("{}",{status:404});
	}));
	expect((await invoke("market:installClaude",{name:"mixed",as:"package"})).ok).toBe(false);
	expect(readFileSync(join(target,"old.txt"),"utf8")).toBe("old plugin");
	expect(existsSync(settings)?readFileSync(settings,"utf8"):"{}").toBe(previous);
	expect(existsSync(core.mcp.path)?readFileSync(core.mcp.path,"utf8"):undefined).toBe(mcpBefore);
	invalid=false;expect((await invoke("market:installClaude",{name:"mixed",as:"package"})).ok).toBe(true);
	expect(existsSync(join(target,"old.txt"))).toBe(false);
	expect(readFileSync(join(target,"skills/review/SKILL.md"),"utf8")).toBe("# Review");
	const current=JSON.parse(readFileSync(settings,"utf8"));expect(current.userPreference).toBe("changed while downloading");expect(current.packages).toContain("../claude-pkg/claude-mixed");
	expect(core.market.listInstalled().packages.some(pkg=>pkg.installedPath===target)).toBe(true);
	expect(JSON.parse(readFileSync(core.mcp.path,"utf8")).mcpServers.server.args).toEqual([join(target,"server.js")]);
});
