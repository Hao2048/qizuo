import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessDatabase, MIGRATIONS } from "./database.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pih-db-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** better-sqlite3 的 pragma() 返回行对象或行对象数组，这里取第一个字段值。 */
function pragmaField(
  db: HarnessDatabase,
  name: string,
  field: string,
): unknown {
  const raw = db.pragma(name) as unknown;
  const row = Array.isArray(raw) ? raw[0] : raw;
  return (row as Record<string, unknown> | undefined)?.[field];
}

describe("HarnessDatabase", () => {
  it("内存库迁移到最新版本且核心表齐全", () => {
    const db = HarnessDatabase.memory();
    expect(db.version).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
    const tables = db.tableNames();
    for (const t of [
      "app_meta",
      "projects",
      "roles",
      "memories",
      "memory_versions",
      "tasks",
      "task_events",
      "task_graph_nodes",
      "usage_ledger",
      "schema_migrations",
    ]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it("文件库：WAL 模式生效，重复打开迁移幂等", () => {
    const file = join(tmpDir, "data", "harness.db");
    const db1 = HarnessDatabase.open(file);
    expect(
      String(pragmaField(db1, "journal_mode", "journal_mode")).toLowerCase(),
    ).toContain("wal");
    const v1 = db1.version;
    db1.setMeta("probe", "1");
    db1.close();

    const db2 = HarnessDatabase.open(file);
    expect(db2.version).toBe(v1);
    expect(db2.getMeta("probe")).toBe("1");
    // schema_migrations 每个版本恰好一行
    const rows = db2
      .prepare("SELECT COUNT(*) AS c FROM schema_migrations")
      .get() as { c: number };
    expect(rows.c).toBe(MIGRATIONS.length);
    db2.close();
  });

  it("外键强制开启：违规插入抛错", () => {
    const db = HarnessDatabase.memory();
    expect(pragmaField(db, "foreign_keys", "foreign_keys")).toBe(1);
    expect(() =>
      db
        .prepare(
          "INSERT INTO memory_versions (memory_id, ver, title, content, created_at) VALUES (?, 1, 't', 'c', 0)",
        )
        .run("nonexistent-memory"),
    ).toThrow();
    db.close();
  });

  it("CHECK 约束：非法 scope_type 被拒绝", () => {
    const db = HarnessDatabase.memory();
    expect(() =>
      db
        .prepare(
          "INSERT INTO memories (id, scope_type, scope_id, title, content, created_at, updated_at) VALUES ('m1', 'global', 'x', 't', 'c', 0, 0)",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it("app_meta upsert 生效", () => {
    const db = HarnessDatabase.memory();
    db.setMeta("k", "a");
    db.setMeta("k", "b");
    expect(db.getMeta("k")).toBe("b");
    expect(db.getMeta("missing")).toBeNull();
    db.close();
  });

  it("任务事件级联删除", () => {
    const db = HarnessDatabase.memory();
    db.prepare(
      "INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'demo', 0, 0)",
    ).run();
    db.prepare(
      "INSERT INTO task_events (task_id, type, created_at) VALUES ('t1', 'x', 0)",
    ).run();
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM task_events").get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
    db.prepare("DELETE FROM tasks WHERE id = 't1'").run();
    expect(
      (
        db.prepare("SELECT COUNT(*) AS c FROM task_events").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
    db.close();
  });
});
it("从上一版数据库升级保留正文、状态、来源与版本，旧记忆不冒充已验证", async () => {
  const { default: Sqlite } = await import("better-sqlite3"),
    file = join(tmpDir, "old-v10.db"),
    legacy = new Sqlite(file);
  legacy.exec(
    "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)",
  );
  for (const m of MIGRATIONS.filter((m) => m.version <= 10)) {
    legacy.exec(m.sql);
    legacy
      .prepare("INSERT INTO schema_migrations VALUES(?,?,?)")
      .run(m.version, m.name, 1);
  }
  legacy
    .prepare(
      "INSERT INTO memories(id,scope_type,scope_id,title,content,status,source_task_id,created_at,updated_at) VALUES('old','role','r','旧经验','已有方法','active','old-source',1,2)",
    )
    .run();
  legacy
    .prepare(
      "INSERT INTO memories(id,scope_type,scope_id,title,content,status,created_at,updated_at) VALUES('forgotten','role','r','旧记录','已忘记的方法','forgotten',1,2)",
    )
    .run();
  legacy
    .prepare(
      "INSERT INTO memory_versions(memory_id,ver,title,content,reason,created_at) VALUES('old',1,'旧经验','初版方法','原始依据',1),('old',2,'旧经验','已有方法','旧纠错',2)",
    )
    .run();
  legacy.close();
  const { MemoryService } = await import("../memory/memory-service.js");
  let db = HarnessDatabase.open(file);
  const memory = new MemoryService(db);
  expect(memory.get("old")).toMatchObject({
    content: "已有方法",
    version: 2,
    sourceTaskId: "old-source",
    sourceDeleted: true,
    quality: { verification: "legacy", source: "legacy" },
  });
  expect(memory.history("old").map((v) => v.content)).toEqual([
    "初版方法",
    "已有方法",
  ]);
  expect(memory.get("forgotten").status).toBe("forgotten");
  expect(
    memory
      .retrieve({ scopes: [{ scopeType: "role", scopeId: "r" }] })
      .map((m) => m.id),
  ).toEqual(["old"]);
  db.close();
  db = HarnessDatabase.open(file);
  expect(
    (
      db
        .prepare("SELECT count(*) c FROM schema_migrations WHERE version=11")
        .get() as { c: number }
    ).c,
  ).toBe(1);
  db.close();
});

it("从v15升级不改变记忆正文/版本/候选状态，不虚构旧引用；重开保留观测起点",async()=>{
  const {default:Sqlite}=await import('better-sqlite3');
  const file=join(tmpDir,'old-v15.db'),old=new Sqlite(file);
  old.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at INTEGER NOT NULL)');
  for(const m of MIGRATIONS.filter(m=>m.version<=15)) {
    old.exec(m.sql);old.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(m.version,m.name,1);
  }
  old.prepare("INSERT INTO memories(id,scope_type,scope_id,title,content,quality,created_at,updated_at) VALUES('m','role','r','旧候选','原始方法',?,1,2)").run(JSON.stringify({verification:'pending',source:'agent'}));
  old.prepare("INSERT INTO memory_versions(memory_id,ver,title,content,created_at,quality) VALUES('m',1,'旧候选','原始方法',1,?)").run(JSON.stringify({verification:'pending',source:'agent'}));
  const original=old.prepare('SELECT * FROM memories').all(),versions=old.prepare('SELECT * FROM memory_versions').all();old.close();
  let db=HarnessDatabase.open(file);
  expect(db.prepare('SELECT * FROM memories').all()).toEqual(original);
  expect(db.prepare('SELECT * FROM memory_versions').all()).toEqual(versions);
  expect(db.prepare('SELECT * FROM memory_citations').all()).toEqual([]);
  const since=db.getMeta('memory_observed_since');expect(Number(since)).toBeGreaterThan(0);db.close();
  db=HarnessDatabase.open(file);expect(db.getMeta('memory_observed_since')).toBe(since);db.close();
});
