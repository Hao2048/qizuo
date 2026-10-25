import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarketService } from "./market-service.js";
import { BackupService } from "./backup-service.js";
import { Logger } from "../logging/logger.js";

vi.mock("node:fs", {spy:true});
let dir: string;
let agentDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pih-m4-"));
	agentDir = join(dir, "pi");
	mkdirSync(join(agentDir, "skills"), { recursive: true });
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe("MarketService", () => {
	it("空态：无包、目录扫描本地资源", async () => {
		writeFileSync(join(agentDir, "skills", "README"), "");
		mkdirSync(join(agentDir, "skills", "pdf-tools"));
		writeFileSync(join(agentDir, "extensions", "my-ext.ts"), "export default () => {}");
		const market = await MarketService.create({ agentDir, cwd: dir, logger: new Logger(), emit: () => {}, getVisibility: () => "public", setVisibilityRow: () => {} });
		const listed = market.listInstalled();
		expect(listed.packages).toHaveLength(0);
		expect(listed.localSkills.map((x) => x.name)).toEqual(expect.arrayContaining(["pdf-tools"]));
		expect(listed.localExtensions).toEqual(["my-ext.ts"]);
	});

	it("本地安装：合法 pi 包目录 → 声明入 settings.json，可再移除", async () => {
		// 构造一个最小 pi 包（skills 目录）
		const pkg = join(dir, "my-pkg");
		mkdirSync(join(pkg, "skills", "demo-skill"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "my-pkg", version: "1.0.0" }));
		writeFileSync(join(pkg, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: demo\n---\n内容");

		const market = await MarketService.create({ agentDir, cwd: dir, logger: new Logger(), emit: () => {}, getVisibility: () => "public", setVisibilityRow: () => {} });
		const result = await market.installLocal(pkg);
		expect(result.ok).toBe(true);

		const listed = market.listInstalled();
		expect(listed.packages.some((p) => p.source.includes("my-pkg"))).toBe(true);

		const removed = await market.remove(listed.packages.find((p) => p.source.includes("my-pkg"))!.source);
		expect(removed.ok).toBe(true);
		expect(market.listInstalled().packages).toHaveLength(0);
	});

	it("本地安装不存在路径失败并说明原因", async () => {
		const market = await MarketService.create({ agentDir, cwd: dir, logger: new Logger(), emit: () => {}, getVisibility: () => "public", setVisibilityRow: () => {} });
		const result = await market.installLocal(join(dir, "no-such"));
		expect(result.ok).toBe(false);
		expect(result.message).toContain("不存在");
	});
});

describe("BackupService", () => {
	it("备份排除凭证/日志/备份目录自身；列表可读", () => {
		mkdirSync(join(agentDir), { recursive: true });
		writeFileSync(join(agentDir, "auth.json"), '{"anthropic":{"type":"api_key","key":"sk-secret"}}');
		writeFileSync(join(agentDir, "models.json"), "{}");
		writeFileSync(join(dir, "harness.db"), "db-bytes");
		mkdirSync(join(dir, "logs"), { recursive: true });
		writeFileSync(join(dir, "logs", "app.jsonl"), "log");

		const backup = new BackupService(dir, new Logger());
		const info = backup.create();
		expect(existsSync(join(info.path, "harness.db"))).toBe(true);
		expect(existsSync(join(info.path, "pi", "models.json"))).toBe(true);
		expect(existsSync(join(info.path, "pi", "auth.json"))).toBe(false); // 凭证不进备份
		expect(existsSync(join(info.path, "logs"))).toBe(false);
		expect(existsSync(join(info.path, "backups"))).toBe(false);

		const list = backup.list();
		expect(list.length).toBe(1);
		expect(list[0]!.id).toBe(info.id);
	});

	it("恢复：标记 → 启动执行（保留现有凭证）", () => {
		// 初始数据 + 备份
		writeFileSync(join(dir, "harness.db"), "v1");
		writeFileSync(join(agentDir, "auth.json"), '{"current":"cred"}');
		const backup = new BackupService(dir, new Logger());
		const info = backup.create();

		// 之后数据被破坏
		writeFileSync(join(dir, "harness.db"), "broken");
		// pi/auth.json 换成新凭证（恢复不得覆盖它）
		writeFileSync(join(agentDir, "auth.json"), '{"newer":"cred"}');

		const req = backup.requestRestore(info.id);
		expect(req.ok).toBe(true);
		expect(existsSync(join(dir, "pending-restore.json"))).toBe(true);

		const executed = BackupService.executePendingRestore(dir);
		expect(executed).toBe(true);
		expect(readFileSync(join(dir, "harness.db"), "utf8")).toBe("v1");
		expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toContain("newer"); // 凭证保留
		expect(existsSync(join(dir, "pending-restore.json"))).toBe(false);
		// 备份目录保留
		expect(backup.list().length).toBe(1);
	});

	it("无标记时启动恢复为空操作", () => {
		expect(BackupService.executePendingRestore(dir)).toBe(false);
	});
});

describe("基础能力插件保护", () => {
	it("基础能力插件：remove 与设私有在服务端被强制拒绝", async () => {
		const market = await MarketService.create({ agentDir, cwd: dir, logger: new Logger(), emit: () => {}, getVisibility: () => "public", setVisibilityRow: () => {} });
		for (const source of ["npm:pi-web-access", "npm:pi-subagents", "npm:@amaster.ai/pi-computer-use"]) {
			const rm = await market.remove(source);
			expect(rm.ok).toBe(false);
			const vis = await market.setVisibility(source, "package", "private");
			expect(vis.ok).toBe(false);
			expect(vis.message).toContain("不可移除");
		}
	});
});

describe("Pi 画廊 npm 全量合并", () => {
	it("lark CLI 经 npm 检索可搜到（合并去重，精选优先）", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown) => {
				const u = String(url);
				if (u.includes("pi.dev/packages")) {
					return new Response('<p>精选</p>\npi install npm:pi-web-access', { status: 200 });
				}
				if (u.includes("registry.npmjs.org/-/v1/search")) {
					return new Response(
						JSON.stringify({
							objects: [
								{ package: { name: "@tunglam/pi-lark-cli", description: "Lark/Feishu CLI for pi" } },
								{ package: { name: "pi-web-access", description: "重复项应去重" } },
							],
						}),
						{ status: 200 },
					);
				}
				if (u.includes("api.npmjs.org/downloads")) {
					return new Response(JSON.stringify({ "@tunglam/pi-lark-cli": { downloads: 500 } }), { status: 200 });
				}
				return new Response("{}", { status: 404 });
			}),
		);
		const svc = await MarketService.create({ agentDir, cwd: dir, logger: new Logger(), emit: () => {}, getVisibility: () => "public", setVisibilityRow: () => {} });
		const r = await svc.listPiGallery("lark");
		expect(r.items.map((i) => i.name)).toContain("@tunglam/pi-lark-cli");
		const all = await svc.listPiGallery();
		expect(all.items.map((i) => i.name)).toContain("pi-web-access");
		expect(all.items.filter((i) => i.name === "pi-web-access")).toHaveLength(1); // 去重
	});

	it("中英别名：搜「飞书」也能命中 lark/feishu 系包（npm 描述多为英文）", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown) => {
				const u = String(url);
				if (u.includes("pi.dev/packages")) return new Response("", { status: 200 });
				if (u.includes("registry.npmjs.org/-/v1/search")) {
					const text = decodeURIComponent(u.split("text=")[1]?.split("&")[0] ?? "");
					if (text.includes("%E9%A3%9E%E4%B9%A6") || text.includes("飞书")) {
						return new Response(JSON.stringify({ objects: [{ package: { name: "pi-feishu-agent", description: "从飞书远程控制" } }] }), { status: 200 });
					}
					if (text.includes("lark")) {
						return new Response(JSON.stringify({ objects: [{ package: { name: "@tunglam/pi-lark-cli", description: "Lark/Feishu CLI" } }] }), { status: 200 });
					}
					if (text.includes("feishu")) {
						return new Response(JSON.stringify({ objects: [{ package: { name: "pi-feishu-connector", description: "Feishu bridge" } }] }), { status: 200 });
					}
					return new Response(JSON.stringify({ objects: [] }), { status: 200 });
				}
				if (u.includes("api.npmjs.org/downloads")) return new Response("{}", { status: 200 });
				return new Response("{}", { status: 404 });
			}),
		);
		const svc = await MarketService.create({ agentDir, cwd: dir, logger: new Logger(), emit: () => {}, getVisibility: () => "public", setVisibilityRow: () => {} });
		const r = await svc.listPiGallery("飞书");
		const names = r.items.map((i) => i.name);
		expect(names).toContain("pi-feishu-agent"); // 原词直接命中（中文描述）
		expect(names).toContain("@tunglam/pi-lark-cli"); // 别名 lark 命中（英文描述）
		expect(names).toContain("pi-feishu-connector"); // 别名 feishu 命中
	});
});

it("reuses unchanged local directory indexes but refreshes names and visibility immediately",async()=>{
 const fs=await import("node:fs");const scan=vi.spyOn(fs,"readdirSync");let visibility:"public"|"private"="public";
 const market=await MarketService.create({agentDir,cwd:dir,logger:new Logger(),emit:()=>{},getVisibility:()=>visibility,setVisibilityRow:()=>{}});
 const skills=join(agentDir,"skills");mkdirSync(join(skills,"first"));
 market.listInstalled();market.listInstalled();
 expect(scan.mock.calls.filter(args=>args[0]===skills)).toHaveLength(1);
 visibility="private";expect(market.listInstalled().localSkills[0]!.visibility).toBe("private");
 mkdirSync(join(skills,"second"));expect(market.listInstalled().localSkills.map(s=>s.name)).toContain("second");
 rmSync(join(skills,"first"),{recursive:true});expect(market.listInstalled().localSkills.map(s=>s.name)).not.toContain("first");scan.mockRestore();
});
