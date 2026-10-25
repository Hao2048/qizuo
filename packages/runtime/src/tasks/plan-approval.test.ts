import { afterEach,beforeEach,expect,it } from "vitest";
import { existsSync,mkdtempSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage,fauxToolCall } from "@earendil-works/pi-ai";
import { createHarnessCore,type HarnessCore } from "../core/harness-core.js";
import { HarnessDatabase } from "../db/database.js";
import { ensureFauxRegistered,fauxModelRef } from "../pi/faux-provider.js";
let dir:string,core:HarnessCore;
async function invoke(name:string,input:unknown):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw new Error(r.error.message);return r.result;}
async function settled(id:string){for(let i=0;i<600;i++){const got=await invoke("task:get",{taskId:id});if(["done","error","cancelled"].includes(got.task.status)){await new Promise(r=>setTimeout(r,20));return invoke("task:get",{taskId:id});}await new Promise(r=>setTimeout(r,25));}throw new Error("timeout");}
async function draft(){ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("update_plan",{steps:[{content:"write report",status:"pending"}]})]),fauxAssistantMessage("方案待确认")]);const t=await invoke("task:create",{});await invoke("task:prompt",{taskId:t.id,text:"拟定报告方案"});return settled(t.id);}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-approve-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});await invoke("settings:set",{defaultModel:fauxModelRef(),permissionMode:"plan",autoApproveTools:["read","write"]});});
afterEach(()=>{core.dispose();rmSync(dir,{recursive:true,force:true});});
it("executes only the approved revision and leaves global plan mode intact",async()=>{
 const got=await draft(),id=got.task.id,target=join(dir,"report.txt");
 expect(got.task.planState).toMatchObject({requiresApproval:true,status:"draft"});
 await expect(invoke("task:approvePlan",{taskId:id,revision:"stale"})).rejects.toThrow("计划已变化");
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("write",{path:target,content:"ok"})]),fauxAssistantMessage([fauxToolCall("update_plan",{steps:[{content:"write report",status:"completed"}]})]),fauxAssistantMessage("完成")]);
 await invoke("task:approvePlan",{taskId:id,revision:got.task.planState.revision});
 const done=await settled(id);expect(existsSync(target)).toBe(true);expect(done.task.planState.status).toBe("complete");
 expect((await invoke("settings:get",{})).permissionMode).toBe("plan");
});
it("changed steps invalidate approval and a global bypass switch cannot approve a draft",async()=>{
 const got=await draft(),id=got.task.id,target=join(dir,"forbidden.txt");
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("update_plan",{steps:[{content:"changed scope",status:"in_progress"}]})]),fauxAssistantMessage([fauxToolCall("write",{path:target,content:"bad"})]),fauxAssistantMessage("重新确认")]);
 await invoke("task:approvePlan",{taskId:id,revision:got.task.planState.revision});const next=await settled(id);
 expect(next.task.planState.status).toBe("draft");expect(next.task.planState.revision).not.toBe(got.task.planState.revision);expect(existsSync(target)).toBe(false);
 await invoke("settings:set",{permissionMode:"bypass",autoApproveTools:["write"]});
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("write",{path:target,content:"bad"})]),fauxAssistantMessage("仍需批准")]);
 await invoke("task:prompt",{taskId:id,text:"补充讨论方案"});await settled(id);expect(existsSync(target)).toBe(false);
});
it("unfinished execution requires a fresh approval after restart",async()=>{
 const got=await draft(),id=got.task.id;
 ensureFauxRegistered().setResponses([fauxAssistantMessage("未完成")]);await invoke("task:approvePlan",{taskId:id,revision:got.task.planState.revision});
 expect((await settled(id)).task.planState.status).toBe("paused");
 core.dispose();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 expect((await invoke("task:get",{taskId:id})).task.planState.status).toBe("paused");
 const target=join(dir,"no-replay.txt");ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("write",{path:target,content:"bad"})]),fauxAssistantMessage("回顾")]);
 await invoke("task:prompt",{taskId:id,text:"聊聊之前的方案"});await settled(id);expect(existsSync(target)).toBe(false);
});

it("stopping approval pauses the plan and subsequent messages cannot inherit its execution grant",async()=>{
 const got=await draft(),id=got.task.id,target=join(dir,"stopped.txt");
 await invoke("settings:set",{permissionMode:"plan",autoApproveTools:["read"]});
 let waiting=false;const unsubscribe=core.router.onEvent(event=>{if(event.type==="task:approval")waiting=true;});
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("write",{path:target,content:"bad"})]),fauxAssistantMessage("stopped")]);
 await invoke("task:approvePlan",{taskId:id,revision:got.task.planState.revision});
 for(let i=0;i<200 && !waiting;i++)await new Promise(r=>setTimeout(r,20));expect(waiting).toBe(true);
 await invoke("task:abort",{taskId:id});expect((await settled(id)).task.planState.status).toBe("paused");expect(existsSync(target)).toBe(false);
 unsubscribe();
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("write",{path:target,content:"bad"})]),fauxAssistantMessage("仅讨论")]);
 await invoke("task:prompt",{taskId:id,text:"继续讨论风险"});await settled(id);expect(existsSync(target)).toBe(false);
 await core.shutdown();
});

it("keeps completed steps when a paused plan is discussed again",async()=>{
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("update_plan",{steps:[{content:"first",status:"pending"},{content:"second",status:"pending"}]})]),fauxAssistantMessage("方案")]);
 const t=await invoke("task:create",{});await invoke("task:prompt",{taskId:t.id,text:"规划"});const draft=await settled(t.id);
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("update_plan",{steps:[{content:"first",status:"completed"},{content:"second",status:"pending"}]})]),fauxAssistantMessage("第一步完成")]);
 await invoke("task:approvePlan",{taskId:t.id,revision:draft.task.planState.revision});await settled(t.id);
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("update_plan",{steps:[{content:"first",status:"completed"},{content:"second",status:"completed"}]})]),fauxAssistantMessage("讨论")]);
 await invoke("task:prompt",{taskId:t.id,text:"讨论计划"});const got=await settled(t.id);
 expect(got.task.plan.map((s:{status:string})=>s.status)).toEqual(["completed","pending"]);
});

it("recovers durable crash state without replay and clears the notice after an explicit successful turn",async()=>{
 const got=await draft(),id=got.task.id;
 await core.shutdown();
 const db=HarnessDatabase.open(join(dir,"harness.db"));
 db.prepare("UPDATE tasks SET status='running',plan=? WHERE id=?").run(JSON.stringify([{content:"first",status:"completed"},{content:"second",status:"in_progress"}]),id);
 db.prepare("UPDATE task_events SET payload=? WHERE task_id=? AND type='plan_state'").run(JSON.stringify({...got.task.planState,status:"approved"}),id);
 db.close();
 core=await createHarnessCore({dataDir:dir,enableFaux:true});
 const restored=await invoke("task:get",{taskId:id});
 expect(restored.task.status).toBe("cancelled");
 expect(restored.task.recovery).toMatchObject({previousStatus:"running"});
 expect(restored.task.planState.status).toBe("paused");
 expect(restored.task.plan.map((s:{status:string})=>s.status)).toEqual(["completed","in_progress"]);
 expect(restored.pendingApprovals).toEqual([]);
 const target=join(dir,"no-crash-replay.txt");
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("write",{path:target,content:"bad"})]),fauxAssistantMessage("依据记录回顾")]);
 await invoke("task:prompt",{taskId:id,text:"之前做了什么"});
 const done=await settled(id);
 expect(existsSync(target)).toBe(false);
 expect(done.task.recovery).toBeNull();
 expect(done.task.planState.status).toBe("paused");
});
