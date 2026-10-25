import type { MemoryInfo, MemoryUsageInfo } from "@pi-harness/contracts";
import type { HarnessDatabase } from "../db/database.js";

type Owner = { taskId: string; workbenchId?: never; stage: "execution" }
  | { workbenchId: string; taskId?: never; stage: "routing" | "planning" };

/** Host-only metadata. A citation means request context inclusion, never semantic use or success. */
export class MemoryUsage {
  constructor(private db: HarnessDatabase) {}

  record(roleId: string, memories: Pick<MemoryInfo, "id" | "version">[], owner: Owner): void {
    if (!memories.length) return;
    try { this.db.transaction(() => {
      let projectId: string | null;
      if (owner.taskId) {
        const task = this.db.prepare("SELECT role_id,project_id FROM tasks WHERE id=?").get(owner.taskId) as {role_id:string;project_id:string|null}|undefined;
        if (!task || task.role_id !== roleId) return;
        projectId = task.project_id;
      } else {
        const row = this.db.prepare("SELECT body FROM workbenches WHERE id=?").get(owner.workbenchId) as {body:string}|undefined;
        if (!row) return;
        const w = JSON.parse(row.body);
        if (owner.stage === "routing") {
          if (!this.db.prepare("SELECT 1 FROM roles WHERE id=? AND is_default=1 AND status='active'").get(roleId)) return;
        } else if (!w.participants.some((p:{roleId:string;enabled:boolean;unavailable?:boolean})=>p.roleId===roleId && p.enabled && !p.unavailable)) return;
        projectId = w.projectId ?? null;
      }
      const insert = this.db.prepare(`INSERT INTO memory_citations
        (memory_id,version,owner_key,task_id,workbench_id,stage,first_at,last_at)
        SELECT m.id,v.ver,?,?,?,?,?,? FROM memories m JOIN memory_versions v ON v.memory_id=m.id
        WHERE m.id=? AND m.scope_type='role' AND m.scope_id=? AND v.ver=?
        AND COALESCE(json_extract(v.quality,'$.verification'),'legacy')!='pending'
        AND (json_extract(v.quality,'$.projectId') IS NULL OR json_extract(v.quality,'$.projectId')=?)
        ON CONFLICT(memory_id,version,owner_key,stage) DO UPDATE SET last_at=excluded.last_at`);
      const now = Date.now();
      for (const m of memories.slice(0, 10)) insert.run(
        owner.taskId ? `task:${owner.taskId}` : `workbench:${owner.workbenchId}`,
        owner.taskId ?? null, owner.workbenchId ?? null, owner.stage, now, now,
        m.id, roleId, m.version, projectId,
      );
    }); } catch {
      // Observability must never prevent the authorized request. No prompt or database error text is logged.
      console.warn("记忆引用统计未写入；任务继续执行");
    }
  }

  get(roleId: string, memoryId?: string): MemoryUsageInfo {
    if (memoryId && !this.db.prepare("SELECT 1 FROM memories WHERE id=? AND scope_type='role' AND scope_id=?").get(memoryId,roleId)) throw Error("记忆不属于当前角色或已不存在");
    const summary = this.db.prepare(`SELECT count(*) total,
      coalesce(sum(CASE WHEN json_extract(m.quality,'$.source') IN ('agent','workbench') THEN 1 ELSE 0 END),0) automaticTotal,
      coalesce(sum(CASE WHEN json_extract(m.quality,'$.source') IN ('agent','workbench') AND m.status='active' AND json_extract(m.quality,'$.verification') IN ('confirmed','verified') THEN 1 ELSE 0 END),0) automaticRetained,
      coalesce(sum(CASE WHEN json_extract(m.quality,'$.source') IN ('agent','workbench') AND m.status='active' AND json_extract(m.quality,'$.verification')='pending' THEN 1 ELSE 0 END),0) automaticPending,
      coalesce(sum(CASE WHEN json_extract(m.quality,'$.source') IN ('agent','workbench') AND m.status='forgotten' THEN 1 ELSE 0 END),0) automaticForgotten,
      coalesce(sum(CASE WHEN json_extract(m.quality,'$.source') IN ('agent','workbench') AND EXISTS(
        SELECT 1 FROM memory_versions v JOIN memory_versions initial ON initial.memory_id=v.memory_id AND initial.ver=1
        WHERE v.memory_id=m.id AND (v.title!=initial.title OR v.content!=initial.content)) THEN 1 ELSE 0 END),0) automaticRevised
      FROM memories m WHERE m.scope_type='role' AND m.scope_id=?`).get(roleId) as MemoryUsageInfo["summary"];
    // Origin tasks and the originating workbench are not later reuse. Deleted owners cascade away.
    const from = `FROM memory_citations c JOIN memories m ON m.id=c.memory_id
      LEFT JOIN tasks t ON t.id=c.task_id LEFT JOIN workbenches w ON w.id=c.workbench_id
      LEFT JOIN workbench_runs source ON source.task_id=m.source_task_id
      LEFT JOIN workbench_runs execution ON execution.task_id=c.task_id
      WHERE m.scope_type='role' AND m.scope_id=?`;
    const subsequent = `(m.source_task_id IS NULL OR (
      coalesce(c.task_id,'')!=m.source_task_id AND
      (source.workbench_id IS NULL OR source.workbench_id!=coalesce(c.workbench_id,execution.workbench_id,''))))`;
    const reused = this.db.prepare(`SELECT count(DISTINCT m.id) referencedMemories ${from} AND ${subsequent}`).get(roleId) as {referencedMemories:number};
    const rows = memoryId ? this.db.prepare(`SELECT c.version,c.task_id taskId,
      coalesce(c.workbench_id,execution.workbench_id) workbenchId,c.stage,c.first_at firstAt,c.last_at lastAt,
      CASE WHEN c.workbench_id IS NOT NULL THEN json_extract(w.body,'$.title') ELSE t.title END title,
      CASE WHEN ${subsequent} THEN 1 ELSE 0 END subsequent ${from} AND m.id=?
      ORDER BY c.last_at DESC,c.version DESC,c.owner_key,c.stage LIMIT 20`).all(roleId,memoryId) as Array<{
        version:number;taskId:string|null;workbenchId:string|null;stage:"routing"|"planning"|"execution";firstAt:number;lastAt:number;title:string;subsequent:number;
      }> : [];
    const count = memoryId ? this.db.prepare(`SELECT count(*) total ${from} AND m.id=?`).get(roleId,memoryId) as {total:number} : {total:0};
    return { roleId, observedSince:Number(this.db.getMeta("memory_observed_since")), summary:{...summary,...reused},
      memoryId:memoryId ?? null, references:rows.map(r=>({...r,subsequent:!!r.subsequent})), referenceTotal:count.total };
  }
}
