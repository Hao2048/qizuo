import { afterEach, beforeEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessDatabase } from "../db/database.js";
import { removeRetiredData } from "./retired-data.js";
let dir: string, db: HarnessDatabase;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pih-retired-"));
  db = HarnessDatabase.open(join(dir, "harness.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
function task(id: string, mode: string, session?: string) {
  db.prepare(
    "INSERT INTO tasks(id,title,mode,status,pi_session_id,created_at,updated_at) VALUES(?,?,?,'done',?,1,1)",
  ).run(id, id, mode, session ?? null);
}
function memory(id: string, scope: string, source: string | null = null) {
  db.prepare(
    "INSERT INTO memories(id,scope_type,scope_id,title,content,status,source_task_id,created_at,updated_at) VALUES(?,?,?,'title','content','active',?,1,1)",
  ).run(id, scope, "role-a", source);
  db.prepare(
    "INSERT INTO memory_versions(memory_id,ver,title,content,created_at) VALUES(?,1,'title','content',1)",
  ).run(id);
}
it("清理两种旧模式及关联记录，保留普通对话、原生子任务、角色记忆和共享输出", () => {
  mkdirSync(join(dir, "sessions"));
  const sharedSession = join(dir, "sessions", "shared.jsonl");
  writeFileSync(sharedSession, "shared");
  task("old-team", "team", sharedSession);
  task("old-supervisor", "supervisor");
  task("single", "single", sharedSession);
  for (const id of ["old-team", "old-supervisor", "single"]) {
    mkdirSync(join(dir, "member-sessions", id), { recursive: true });
    writeFileSync(join(dir, "member-sessions", id, "session.jsonl"), "history");
    db.prepare(
      "INSERT INTO task_events(task_id,type,payload,created_at) VALUES(?,'user_message','{}',1)",
    ).run(id);
  }
  memory("role-memory", "role", "old-team");
  memory("user-memory", "user");
  memory("project-memory", "project");
  const exclusive = "e".repeat(64),
    shared = "a".repeat(64);
  mkdirSync(join(dir, "tool-outputs"));
  for (const id of [exclusive, shared]) {
    db.prepare("INSERT INTO tool_outputs VALUES(?,1,1)").run(id);
    writeFileSync(join(dir, "tool-outputs", id + ".txt"), "output");
    db.prepare("INSERT INTO task_tool_outputs VALUES(?,?)").run("old-team", id);
  }
  db.prepare("INSERT INTO task_tool_outputs VALUES(?,?)").run("single", shared);
  db.prepare(
    "INSERT INTO conversation_references(id,owner_task_id,payload,created_at) VALUES('ref','single',?,1)",
  ).run(JSON.stringify({ sourceTaskId: "old-team" }));
  expect(removeRetiredData(db, dir)).toMatchObject({ tasks: 2, memories: 2 });
  expect(db.prepare("SELECT id FROM tasks").all()).toEqual([{ id: "single" }]);
  expect(db.prepare("SELECT task_id FROM task_events").all()).toEqual([
    { task_id: "single" },
  ]);
  expect(db.prepare("SELECT id,source_task_id FROM memories").all()).toEqual([
    { id: "role-memory", source_task_id: null },
  ]);
  expect(db.prepare("SELECT memory_id FROM memory_versions").all()).toEqual([
    { memory_id: "role-memory" },
  ]);
  expect(existsSync(join(dir, "member-sessions", "old-team"))).toBe(false);
  expect(
    existsSync(join(dir, "member-sessions", "single", "session.jsonl")),
  ).toBe(true);
  expect(existsSync(sharedSession)).toBe(true);
  expect(existsSync(join(dir, "tool-outputs", exclusive + ".txt"))).toBe(false);
  expect(existsSync(join(dir, "tool-outputs", shared + ".txt"))).toBe(true);
  expect(db.prepare("SELECT id FROM conversation_references").all()).toEqual(
    [],
  );
  expect(removeRetiredData(db, dir)).toEqual({
    tasks: 0,
    memories: 0,
    artifacts: 0,
  });
});
it("遇到符号链接时拒绝清理且不删除外部文件和数据库任务", () => {
  task("old", "team");
  const outside = mkdtempSync(join(tmpdir(), "pih-keep-"));
  try {
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, join(dir, "member-sessions"), "dir");
    expect(() => removeRetiredData(db, dir)).toThrow("符号链接");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    expect(db.prepare("SELECT id FROM tasks").all()).toEqual([{ id: "old" }]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
