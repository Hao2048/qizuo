import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { HarnessDatabase } from "../db/database.js";

/** Remove retired modes only. Native single-role child sessions and workbench runs survive. */
export function removeRetiredData(db: HarnessDatabase, dataDir: string) {
  const rows = db
    .prepare(
      "SELECT id,pi_session_id FROM tasks WHERE mode IN ('team','supervisor')",
    )
    .all() as Array<{ id: string; pi_session_id: string | null }>;
  const paths = new Set<string>();
  const protectedSessions = new Set(
    (
      db
        .prepare(
          "SELECT pi_session_id FROM tasks WHERE mode='single' AND pi_session_id IS NOT NULL",
        )
        .all() as Array<{ pi_session_id: string }>
    ).flatMap((row) =>
      existsSync(row.pi_session_id) ? [realpathSync(row.pi_session_id)] : [],
    ),
  );
  const root = realpathSync(dataDir);
  function owned(path: string) {
    if (!existsSync(path)) return;
    const rel = relative(root, realpathSync(path));
    if (
      !rel ||
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      lstatSync(path).isSymbolicLink()
    )
      throw Error("旧数据路径超出应用目录，已停止清理");
    paths.add(path);
  }
  for (const row of rows) {
    if (!/^[a-zA-Z0-9_-]+$/.test(row.id))
      throw Error("旧会话标识无效，已停止清理");
    for (const folder of ["member-sessions", "checkpoints", "workspaces"]) {
      const base = join(dataDir, folder);
      if (existsSync(base) && lstatSync(base).isSymbolicLink())
        throw Error("旧会话目录不能是符号链接");
      owned(join(base, row.id));
    }
    if (
      row.pi_session_id &&
      !db
        .prepare("SELECT 1 FROM tasks WHERE pi_session_id=? AND mode='single'")
        .get(row.pi_session_id)
    ) {
      const path = resolve(row.pi_session_id),
        rel = relative(resolve(dataDir, "sessions"), path);
      if (
        rel &&
        !rel.startsWith("..") &&
        !isAbsolute(rel) &&
        (!existsSync(path) || !protectedSessions.has(realpathSync(path)))
      )
        owned(path);
    }
  }
  const outputs = db
    .prepare(
      "SELECT DISTINCT o.output_id FROM task_tool_outputs o JOIN tasks t ON t.id=o.task_id WHERE t.mode IN ('team','supervisor') AND NOT EXISTS(SELECT 1 FROM task_tool_outputs x JOIN tasks s ON s.id=x.task_id WHERE x.output_id=o.output_id AND s.mode='single')",
    )
    .all() as Array<{ output_id: string }>;
  for (const { output_id } of outputs) {
    if (!/^[a-f0-9]{64}$/.test(output_id)) throw Error("旧输出编号无效");
    const base = join(dataDir, "tool-outputs");
    if (existsSync(base) && lstatSync(base).isSymbolicLink())
      throw Error("工具输出目录不能是符号链接");
    owned(join(base, output_id + ".txt"));
  }
  // Remove artifacts first: a failed disk cleanup keeps the DB identifiers available for retry.
  for (const path of paths) rmSync(path, { recursive: true, force: true });
  const memories = db.transaction(() => {
    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM memories WHERE scope_type!='role'")
        .get() as { n: number }
    ).n;
    db.prepare(
      "DELETE FROM conversation_references WHERE json_valid(payload) AND json_extract(payload,'$.sourceTaskId') IN (SELECT id FROM tasks WHERE mode IN ('team','supervisor'))",
    ).run();
    db.prepare(
      "UPDATE memories SET source_task_id=NULL WHERE source_task_id IN (SELECT id FROM tasks WHERE mode IN ('team','supervisor'))",
    ).run();
    db.prepare("DELETE FROM tasks WHERE mode IN ('team','supervisor')").run();
    for (const { output_id } of outputs)
      db.prepare(
        "DELETE FROM tool_outputs WHERE id=? AND NOT EXISTS(SELECT 1 FROM task_tool_outputs WHERE output_id=?)",
      ).run(output_id, output_id);
    db.prepare("DELETE FROM memories WHERE scope_type!='role'").run();
    db.prepare(
      "UPDATE tasks SET members=NULL,max_rounds=NULL WHERE members IS NOT NULL OR max_rounds IS NOT NULL",
    ).run();
    return count;
  });
  return { tasks: rows.length, memories, artifacts: paths.size };
}
