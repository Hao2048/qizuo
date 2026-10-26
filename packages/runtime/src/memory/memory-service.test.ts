import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessDatabase } from "../db/database.js";
import { MemoryService } from "./memory-service.js";

let dir: string;
let db: HarnessDatabase;
let memory: MemoryService;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pih-mem-"));
	db = HarnessDatabase.open(join(dir, "harness.db"));
	memory = new MemoryService(db);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("MemoryService 角色存储", () => {
	it("只允许角色记忆，拒绝旧范围",()=>{expect(()=>memory.write({scopeType:"user",scopeId:"user",title:"x",content:"y"})).toThrow("只支持角色");expect(()=>memory.write({scopeType:"project",scopeId:"project",title:"x",content:"y"})).toThrow("只支持角色");const m=memory.write({scopeType:"role",scopeId:"r",title:"x",content:"y"});expect(m.version).toBe(1)});

	it("role/project 层必须有 scopeId（防虚构归属）", () => {
		expect(() => memory.write({ scopeType: "project", scopeId: "", title: "x", content: "y" })).toThrow();
	});

	it("修正产生新版本，历史完整可查", () => {
		const m = memory.write({ scopeType: "role", scopeId: "role-user", title: "T1", content: "C1" });
		memory.revise(m.id, { content: "C2", reason: "更新" });
		const revised = memory.get(m.id);
		expect(revised.content).toBe("C2");
		expect(revised.version).toBe(2);
		const h = memory.history(m.id);
		expect(h.map((v) => v.content)).toEqual(["C1", "C2"]);
		expect(h[1]?.reason).toBe("更新");
	});

	it("忘记/恢复（软删除，可撤销）", () => {
		const m = memory.write({ scopeType: "role", scopeId: "role-user", title: "T", content: "C" });
		memory.forget(m.id);
		expect(memory.list({ status: "active" }).total).toBe(0);
		expect(memory.list({ status: "forgotten" }).total).toBe(1);
		memory.restore(m.id);
		expect(memory.list({ status: "active" }).total).toBe(1);
	});

	it("关键词过滤与范围过滤", () => {
		memory.write({ scopeType: "role", scopeId: "role-user", title: "TypeScript 偏好", content: "严格模式" });
		memory.write({ scopeType: "role", scopeId: "r1", title: "其他", content: "无关内容" });
		expect(memory.list({ query: "typescript" }).total).toBe(1);
		expect(memory.list({ scopeType: "role" }).total).toBe(2);
	});

	it("检索打分：标题命中优先于正文命中；分范围限额", () => {
		memory.write({ scopeType: "role", scopeId: "role-user", title: "docker 部署", content: "通用" });
		memory.write({ scopeType: "role", scopeId: "role-user", title: "随笔", content: "提到 docker 一次" });
		memory.write({ scopeType: "role", scopeId: "r1", title: "角色经验", content: "与查询无关" });
		const got = memory.retrieve({
			scopes: [
				{ scopeType: "role", scopeId: "role-user" },
				{ scopeType: "role", scopeId: "r1" },
			],
			query: "docker",
			perScopeLimit: 2,
		});
		expect(got.length).toBeGreaterThanOrEqual(1);
		expect(got[0]?.title).toBe("docker 部署");
		// 每范围条目不超限
		const userItems = got.filter((m) => m.scopeId === "role-user");
		expect(userItems.length).toBeLessThanOrEqual(2);
	});

	it("注入格式：带范围标签、超长截断、空数组无块", async () => {
		const { formatMemoriesForPrompt, buildSystemPrompt } = await import("../roles/prompts.js");
		const items = memory.list({}).items;
		expect(formatMemoriesForPrompt(items)).toBe("");
		const m = memory.write({ scopeType: "role", scopeId: "role-user", title: "T", content: "x".repeat(2000) });
		const block = formatMemoriesForPrompt([m]);
		expect(block).toContain("【角色】T");
		expect(block.length).toBeLessThan(1200);

		const prompt = buildSystemPrompt({
			role: { roleId: "r", name: "R", intro: "", systemPrompt: "角色提示词", preferredModel: null, preferredThinking: null },
			memories: [m],
			autoMemory: true,
		});
		expect(prompt).toContain("角色提示词");
		expect(prompt).toContain("【角色】T");
		expect(prompt).toContain("save_memory");
	});

	it("角色间不互读：scopeId 精确隔离", () => {
		memory.write({ scopeType: "role", scopeId: "role-a", title: "A 的秘密", content: "只属于 A" });
		const inB = memory.retrieve({ scopes: [{ scopeType: "role", scopeId: "role-b" }], query: "秘密" });
		expect(inB).toHaveLength(0);
	});
});

it("retrieves older relevant role memory beyond the latest hundred entries",()=>{
 const old=memory.write({scopeType:"role",scopeId:"a",title:"unique protocol",content:"stable guidance"});
 db.prepare("UPDATE memories SET updated_at=1 WHERE id=?").run(old.id);
 for(let i=0;i<101;i++)memory.write({scopeType:"role",scopeId:"a",title:`unrelated ${i}`,content:"daily note"});
 memory.write({scopeType:"role",scopeId:"b",title:"unique protocol",content:"other role private"});
 expect(memory.retrieve({scopes:[{scopeType:"role",scopeId:"a"}],query:"unique protocol"}).map(m=>m.id)).toEqual([old.id]);
});
