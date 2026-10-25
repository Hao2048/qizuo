import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessDatabase } from "../db/database.js";
import { MemoryService } from "../memory/memory-service.js";
import { RoleService } from "./role-service.js";

let dir: string;
let db: HarnessDatabase;
let memory: MemoryService;
let roles: RoleService;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pih-roles-"));
	db = HarnessDatabase.open(join(dir, "harness.db"));
	memory = new MemoryService(db);
	roles = new RoleService({ db, memory });
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("RoleService", () => {
	it("默认角色幂等 seed：含框架提示词与记忆种子", () => {
		const first = roles.seedDefault();
		const again = roles.seedDefault();
		expect(again.id).toBe(first.id);
		expect(first.isDefault).toBe(true);
		expect(first.systemPrompt).toContain("栖作 Qizuo");
		expect(first.memoryCount).toBe(1);
		// 记忆种子在角色层
		const seeds = memory.list({ scopeType: "role", scopeId: first.id });
		expect(seeds.items[0]?.title).toBe("工作偏好");
	});

	it("默认角色不能归档；自定义角色可以归档/恢复", () => {
		const def = roles.seedDefault();
		expect(() => roles.archive(def.id, true)).toThrow();
		const r = roles.create({ name: "代码评审员" });
		roles.archive(r.id, true);
		expect(roles.list().find((x) => x.id === r.id)).toBeUndefined();
		expect(roles.list(true).find((x) => x.id === r.id)?.status).toBe("archived");
		roles.archive(r.id, false);
		expect(roles.list().find((x) => x.id === r.id)?.status).toBe("active");
	});

	it("六项字段 CRUD", () => {
		roles.seedDefault();
		const created = roles.create({
			name: "测试角色",
			intro: "介绍",
			systemPrompt: "你是测试角色",
			boundSkills: ["pdf-tools"],
			preferredModel: { provider: "zai", modelId: "glm-4.7" },
			preferredThinking: "high",
		});
		expect(created.intro).toBe("介绍");
		expect(created.boundSkills).toEqual(["pdf-tools"]);
		expect(created.preferredModel).toEqual({ provider: "zai", modelId: "glm-4.7" });

		const updated = roles.update(created.id, { name: "改名", preferredModel: null });
		expect(updated.name).toBe("改名");
		expect(updated.preferredModel).toBeNull();
		expect(updated.systemPrompt).toBe("你是测试角色"); // 未指定字段不动
	});

	it("克隆仅配置：记忆不跟随；克隆配置+记忆快照：复制且此后独立", () => {
		roles.seedDefault();
		const src = roles.create({ name: "源角色", systemPrompt: "SP" });
		memory.write({ scopeType: "role", scopeId: src.id, title: "经验", content: "重要经验" });

		const cfgOnly = roles.clone(src.id, false);
		expect(cfgOnly.systemPrompt).toBe("SP");
		expect(cfgOnly.memoryCount).toBe(0);

		const withMem = roles.clone(src.id, true);
		expect(withMem.memoryCount).toBe(1);
		// 此后独立：源再写不影响克隆
		memory.write({ scopeType: "role", scopeId: src.id, title: "新经验", content: "x" });
		expect(roles.get(withMem.id).memoryCount).toBe(1);
		expect(roles.get(src.id).memoryCount).toBe(2);
	});

	it("快照冻结当时六项（编辑角色不影响快照）", () => {
		roles.seedDefault();
		const r = roles.create({ name: "A", systemPrompt: "版本1" });
		const snap1 = roles.snapshot(r.id);
		roles.update(r.id, { systemPrompt: "版本2" });
		const snap2 = roles.snapshot(r.id);
		expect(snap1.systemPrompt).toBe("版本1");
		expect(snap2.systemPrompt).toBe("版本2");
	});
});
