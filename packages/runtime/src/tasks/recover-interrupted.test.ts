import { afterEach,beforeEach,expect,it } from "vitest";
import { HarnessDatabase } from "../db/database.js";
import { recoverInterruptedTasks } from "./recover-interrupted.js";
let db:HarnessDatabase;
beforeEach(()=>{db=HarnessDatabase.memory();});
afterEach(()=>db.close());
function task(id:string,status:string){db.prepare("INSERT INTO tasks(id,title,status,created_at,updated_at) VALUES(?,?,?,0,0)").run(id,id,status);}
function event(id:string,type:string,value:unknown){db.prepare("INSERT INTO task_events(task_id,type,payload,created_at) VALUES(?,?,?,0)").run(id,type,JSON.stringify(value));}
function get(id:string,type:string){const row=db.prepare("SELECT payload FROM task_events WHERE task_id=? AND type=? ORDER BY id DESC LIMIT 1").get(id,type) as {payload:string}|undefined;return row?JSON.parse(row.payload):null;}
it("reconciles a crashed run, pauses approval and freezes elapsed time without replay",()=>{
 task("t","waiting_approval");
 event("t","run_progress",{taskId:"t",runId:"r",stage:"response",startedAt:10,updatedAt:50,elapsedMs:40,stages:[{stage:"request",durationMs:15}]});
 event("t","plan_state",{revision:"rev",requiresApproval:true,status:"approved"});
 event("t","agent_run",{id:"child",status:"running"});
 event("t","context_compaction",{compacting:true,lastCompactedAt:3});
 recoverInterruptedTasks(db,1000);
 expect(get("t","interruption")).toEqual({interruptedAt:1000,previousStatus:"waiting_approval",stage:"response"});
 expect(get("t","run_progress")).toMatchObject({stage:"stopped",elapsedMs:40,updatedAt:50});
 expect(get("t","plan_state")).toMatchObject({revision:"rev",status:"paused"});
 expect(get("t","agent_run")).toMatchObject({status:"interrupted"});
 expect(get("t","context_compaction")).toMatchObject({compacting:false,lastCompactedAt:3});
 recoverInterruptedTasks(db,2000);
 expect(get("t","interruption").interruptedAt).toBe(1000);
 expect(get("t","agent_run").updatedAt).toBe(1000);
 expect((db.prepare("SELECT count(*) AS n FROM task_events WHERE type='interruption'").get() as {n:number}).n).toBe(1);
});
it("catches preparation before running status, leaves idle and settled tasks alone",()=>{
 for(const [id,status] of [["preparing","draft"],["idle","draft"],["done","done"],["stop","cancelled"],["error","error"]])task(id!,status!);
 for(const id of ["preparing","done","stop","error"])event(id,"run_progress",{stage:"preparing",elapsedMs:12});
 recoverInterruptedTasks(db,100);
 expect(get("preparing","interruption")).toMatchObject({previousStatus:"draft"});
 for(const id of ["idle","done","stop","error"])expect(get(id,"interruption")).toBeNull();
 expect(get("done","run_progress").stage).toBe("complete");
 expect(get("error","run_progress").stage).toBe("failed");
});
it("handles malformed event data and cascades recovery records on deletion",()=>{
 task("t","running");
 db.prepare("INSERT INTO task_events(task_id,type,payload,created_at) VALUES('t','agent_run','broken',0)").run();
 db.prepare("INSERT INTO task_events(task_id,type,payload,created_at) VALUES('t','plan_state','broken',0)").run();
 recoverInterruptedTasks(db,100);
 expect(get("t","interruption")).toMatchObject({previousStatus:"running"});
 db.prepare("DELETE FROM tasks WHERE id='t'").run();
 expect((db.prepare("SELECT count(*) AS n FROM task_events").get() as {n:number}).n).toBe(0);
});
