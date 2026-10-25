import type { AgentRun, PlanState, RunProgress, TaskInfo } from "@pi-harness/contracts";
import type { HarnessDatabase } from "../db/database.js";

/** Reconcile durable state once, without creating agents or replaying tools. */
export function recoverInterruptedTasks(db: HarnessDatabase, now = Date.now()): void {
 db.transaction(() => {
  const put = (taskId:string,type:string,value:unknown) => {
   db.prepare("DELETE FROM task_events WHERE task_id=? AND type=?").run(taskId,type);
   db.prepare("INSERT INTO task_events(task_id,type,payload,created_at) VALUES(?,?,?,?)").run(taskId,type,JSON.stringify(value),now);
  };
  const latest = <T>(id:string,type:string):T|null => {
   const row=db.prepare("SELECT payload FROM task_events WHERE task_id=? AND type=? ORDER BY id DESC LIMIT 1").get(id,type) as {payload:string}|undefined;
   try { return row ? JSON.parse(row.payload) as T : null; } catch { return null; }
  };
  for(const row of db.prepare("SELECT id,payload FROM task_events WHERE type='agent_run'").all() as Array<{id:number;payload:string}>) {
   let agent:AgentRun;try {agent=JSON.parse(row.payload);}catch{continue;}
   if(agent && ["queued","starting","running","waiting_approval"].includes(agent.status))
    db.prepare("UPDATE task_events SET payload=? WHERE id=?").run(JSON.stringify({...agent,status:"interrupted",error:"上次运行中断，等待用户恢复",updatedAt:now}),row.id);
  }
  for(const task of db.prepare("SELECT id,status FROM tasks").all() as Array<{id:string;status:TaskInfo["status"]}>) {
   const progress=latest<RunProgress>(task.id,"run_progress");
   const liveProgress=progress && !["complete","failed","stopped"].includes(progress.stage);
   const interrupted=["running","waiting_approval","waiting_user","waiting_recommend"].includes(task.status) || (task.status==="draft" && liveProgress);
   if(interrupted) {
    put(task.id,"interruption",{interruptedAt:now,previousStatus:task.status,stage:progress?.stage});
    db.prepare("UPDATE tasks SET status='cancelled',updated_at=? WHERE id=?").run(now,task.id);
   }
   // Freeze at the last persisted observation; offline time is not execution time.
   if(liveProgress)put(task.id,"run_progress",{...progress,stage:task.status==="done" ? "complete" : task.status==="error" ? "failed" : "stopped"});
   const plan=latest<PlanState>(task.id,"plan_state");
   if(plan?.status==="approved")put(task.id,"plan_state",{...plan,status:"paused"});
   const compaction=latest<{compacting:boolean;lastCompactedAt?:number;capturedAt?:number;error?:string}>(task.id,"context_compaction");
   if(compaction?.compacting)put(task.id,"context_compaction",{...compaction,compacting:false,error:"上次上下文整理中断，保留已有记录",capturedAt:now});
  }
 });
}
