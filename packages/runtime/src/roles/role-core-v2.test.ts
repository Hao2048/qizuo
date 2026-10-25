import { it, expect } from "vitest";
import { HarnessDatabase } from "../db/database.js";
import { MemoryService } from "../memory/memory-service.js";
import { RoleService } from "./role-service.js";
it("protects the default coordinator while allowing an independent clone", () => {
  const db = HarnessDatabase.open(":memory:");
  try {
    const memory = new MemoryService(db),
      roles = new RoleService({ db, memory });
    const role = roles.seedDefault();
    expect(role.name).toBe("任务助手");
    expect(() => roles.archive(role.id, true)).toThrow();
    expect(() =>
      roles.update(role.id, { systemPrompt: "execute everything" }),
    ).toThrow();
    const clone = roles.clone(role.id, false);
    expect(clone.isDefault).toBe(false);
    expect(
      roles.update(clone.id, { systemPrompt: "custom" }).systemPrompt,
    ).toBe("custom");
  } finally {
    db.close();
  }
});
it("deduplicates scoped memory and bounds retrieval without altering stored content", () => {
  const db = HarnessDatabase.open(":memory:");
  try {
    const memory = new MemoryService(db);
    const input = {
      scopeType: "role" as const,
      scopeId: "a",
      title: "工作方式",
      content: "验证结果".repeat(4000),
    };
    const first = memory.write(input);
    expect(memory.write(input).id).toBe(first.id);
    memory.write({ ...input, scopeId: "b", content: "other role secret" });
    const result = memory.retrieve({
      scopes: [{ scopeType: "role", scopeId: "a" }],
      query: "验证结果",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.content.length).toBeLessThanOrEqual(2000);
    expect(memory.get(first.id).content).toBe(input.content);
    memory.forget(first.id);
    expect(
      memory.retrieve({ scopes: [{ scopeType: "role", scopeId: "a" }] }),
    ).toEqual([]);
  } finally {
    db.close();
  }
});
