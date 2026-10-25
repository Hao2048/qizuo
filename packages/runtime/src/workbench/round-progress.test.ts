import {afterEach,beforeEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {createHarnessCore,type HarnessCore} from "../core/harness-core.js";
import {ensureFauxRegistered,fauxModelRef} from "../pi/faux-provider.js";
import {setRoundStage,interruptRoundProgress} from "./round-progress.js";
import type {Workbench} from "@pi-harness/contracts";
let core:HarnessCore,dir:string,a:string,b:string;
const json=(v:unknown)=>fauxAssistantMessage(JSON.stringify(v));
const tool=(name:string,args:Parameters<typeof fauxToolCall>[1])=>fauxAssistantMessage([fauxToolCall(name,args)]);
async function invoke(name:string,input:unknown={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result;}
async function until(id:string,phase:string){for(let i=0;i<500;i++){const w=core.workbench.get(id);if(w.phase===phase)return w;if(w.phase==="error"&&phase!=="error")throw Error(w.messages.at(-1)?.text);await new Promise(r=>setTimeout(r,10));}throw Error("timeout");}
beforeEach(async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-round-progress-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});
 await invoke("settings:set",{defaultModel:fauxModelRef(),permissionMode:"bypass",agentLimits:{maxConcurrent:1},autoApproveTools:[]});
 a=(await invoke("role:create",{name:"上游",systemPrompt:"PRIVATE_A",preferredModel:fauxModelRef("a")})).id;
 b=(await invoke("role:create",{name:"下游",systemPrompt:"PRIVATE_B",preferredModel:fauxModelRef("b")})).id;
});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
function route(roles:string[],dependency=false){ensureFauxRegistered().setResponses([json({reply:"按职责完成",action:"dispatch",roleIds:roles,assignments:roles.map(roleId=>({roleId,instructions:"完成自身职责",files:[roleId===a?"up.txt":"down.txt"],dependsOn:dependency&&roleId===b?[a]:[]}))})]);}
it("真实SDK阶段快照记录规划与依赖，结束和重启保留；下一轮不复用旧角色进度",async()=>{
 const w=await invoke("workbench:create",{title:"阶段观测",roleIds:[a,b]});route([a,b],true);
 ensureFauxRegistered("a").setResponses([
  ()=>{expect(core.workbench.get(w.id).roundProgress?.roles.map(r=>r.stage)).toEqual(["planning","queued"]);return json({plan:"上游",contracts:[]});},
  ()=>{expect(core.workbench.get(w.id).roundProgress?.roles.map(r=>r.stage)).toEqual(["running","ready"]);return tool("write",{path:"up.txt",content:"真实产出"});},fauxAssistantMessage("上游完成")]);
 ensureFauxRegistered("b").setResponses([
  ()=>{expect(core.workbench.get(w.id).roundProgress?.roles.map(r=>r.stage)).toEqual(["ready","planning"]);return json({plan:"下游",contracts:[]});},
  ()=>{expect(core.workbench.get(w.id).roundProgress?.roles.map(r=>r.stage)).toEqual(["finished","running"]);return tool("write",{path:"down.txt",content:"完成"});},fauxAssistantMessage("下游完成")]);
 await invoke("workbench:send",{id:w.id,text:"先上游交付，再处理下游",requestId:"q"});let done=await until(w.id,"awaiting_review");
 expect(done.roundProgress).toMatchObject({requestId:"q",roles:[{roleId:a,summary:"完成自身职责",dependsOn:[],stage:"finished"},{roleId:b,summary:"完成自身职责",dependsOn:[a],stage:"finished"}]});
 expect(JSON.stringify(done.roundProgress)).not.toContain("PRIVATE");const oldTask=done.participants[1]!.taskId;
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});expect(core.workbench.get(w.id).roundProgress).toEqual(done.roundProgress);
 route([a]);ensureFauxRegistered("a").setResponses([()=>{expect(core.workbench.get(w.id).roundProgress?.roles).toMatchObject([{roleId:a,summary:"完成自身职责",dependsOn:[],stage:"planning"}]);return json({plan:"只改上游",contracts:[]});},fauxAssistantMessage("结束")]);
 await invoke("workbench:send",{id:w.id,text:"本轮只处理上游",requestId:"next"});done=await until(w.id,"awaiting_review");
 expect(done.roundProgress?.requestId).toBe("next");expect(done.participants[1]!.taskId).toBe(oldTask);
});
it("中断恢复冻结未完成阶段，元数据不能修改角色权限、启停或伪造其他轮次完成",async()=>{
 const w=await invoke("workbench:create",{title:"恢复显示",roleIds:[a,b]}) as Workbench;
 w.phase="running";w.roundProgress={requestId:"q",roles:[{roleId:a,dependsOn:[],stage:"running"},{roleId:b,dependsOn:[a],stage:"ready"}]};
 const participants=JSON.stringify(w.participants);
 setRoundStage(w,"old",b,"finished");expect(w.roundProgress.roles[1]!.stage).toBe("ready");
 interruptRoundProgress(w);expect(w.roundProgress.roles.every(r=>r.stage==="interrupted")).toBe(true);
 expect(JSON.stringify(w.participants)).toBe(participants);
 w.roundProgress.roles[0]!.stage="running";
 core.db.prepare("UPDATE workbenches SET body=? WHERE id=?").run(JSON.stringify(w),w.id);
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 const recovered=core.workbench.get(w.id);expect(recovered.phase).toBe("stopped");expect(recovered.roundProgress?.roles.every(r=>r.stage==="interrupted")).toBe(true);
 expect(recovered.participants.every(p=>p.taskId===null)).toBe(true);
});
