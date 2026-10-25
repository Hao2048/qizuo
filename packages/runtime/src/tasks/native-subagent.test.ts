import {afterEach,beforeEach,expect,it} from "vitest";
import {mkdtempSync,rmSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {createHarnessCore,type HarnessCore} from "../core/harness-core.js";
import {ensureFauxRegistered,fauxModelRef} from "../pi/faux-provider.js";
let core:HarnessCore,dir:string;
async function invoke(name:string,input:unknown):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw new Error(r.error.message);return r.result;}
async function waitFor(id:string,statuses:string[]){for(let i=0;i<300;i++){const got=await invoke("task:get",{taskId:id});if(statuses.includes(got.task.status))return got;await new Promise(r=>setTimeout(r,20));}throw new Error("timeout");}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-native-child-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});await invoke("settings:set",{defaultModel:fauxModelRef(),permissionMode:"bypass",autoApproveTools:[]});});
afterEach(async()=>{await core?.shutdown();rmSync(dir,{recursive:true,force:true});});
it("delegates without an installed plugin, isolates history and persists child results",async()=>{
 const task=await invoke("task:create",{mode:"single"});let parentResult="";
 ensureFauxRegistered().setResponses([fauxAssistantMessage("parent private history"),fauxAssistantMessage([fauxToolCall("tool_search",{query:"harness_subagent",limit:1})]),fauxAssistantMessage([fauxToolCall("harness_subagent",{task:"inspect independent task",model:fauxModelRef("b")})]),ctx=>{parentResult=JSON.stringify(ctx.messages);return fauxAssistantMessage("parent done");}]);
 ensureFauxRegistered("b").setResponses([ctx=>{expect(JSON.stringify(ctx.messages)).not.toContain("parent private history");expect(JSON.stringify(ctx.messages)).not.toContain('"name":"harness_subagent"');return fauxAssistantMessage("verified child result");}]);
 await invoke("task:prompt",{taskId:task.id,text:"say hello"});await waitFor(task.id,["done"]);
 await invoke("task:prompt",{taskId:task.id,text:"delegate inspection"});await waitFor(task.id,["done"]);
 expect(parentResult).toContain("verified child result");expect((await invoke("task:listAgents",{taskId:task.id})).agents).toMatchObject([{status:"done",result:"verified child result"}]);
 expect(core.db.prepare("SELECT input_tokens FROM usage_ledger WHERE task_id=? AND provider='pih-faux-b'").all(task.id)).toHaveLength(1);
 await invoke("task:delete",{taskId:task.id});expect(core.db.prepare("SELECT id FROM task_events WHERE type='agent_run'").all()).toHaveLength(0);expect(existsSync(join(dir,"member-sessions",task.id))).toBe(false);
});
it("blocks child writes by default and forwards explicitly allowed writes to the main approval",async()=>{
 const task=await invoke("task:create",{mode:"single"});let blocked="";
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("tool_search",{query:"harness_subagent",limit:1})]),fauxAssistantMessage([fauxToolCall("harness_subagent",{task:"read only",model:fauxModelRef("b")})]),fauxAssistantMessage("done")]);
 ensureFauxRegistered("b").setResponses([fauxAssistantMessage([fauxToolCall("write",{path:"child.txt",content:"no"})]),ctx=>{blocked=JSON.stringify(ctx.messages);return fauxAssistantMessage("blocked");}]);
 await invoke("task:prompt",{taskId:task.id,text:"inspect"});await waitFor(task.id,["done"]);expect(blocked).toContain("只读");
 await invoke("settings:set",{permissionMode:"auto_edit",autoApproveTools:[]});
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("tool_search",{query:"harness_subagent",limit:1})]),fauxAssistantMessage([fauxToolCall("harness_subagent",{task:"write with approval",allowWrites:true,model:fauxModelRef("b")})]),fauxAssistantMessage("done")]);
 ensureFauxRegistered("b").setResponses([fauxAssistantMessage([fauxToolCall("bash",{command:'rm -rf "missing drafts"'})]),fauxAssistantMessage("removed")]);
 await invoke("task:prompt",{taskId:task.id,text:"delegate approved cleanup"});const first=await waitFor(task.id,["waiting_approval"]);
 await invoke("approval:decide",{taskId:task.id,toolCallId:first.pendingApprovals[0].toolCallId,approved:true});
 let got=first;for(let i=0;i<300;i++){got=await invoke("task:get",{taskId:task.id});if(got.pendingApprovals?.[0]?.toolName==="bash")break;await new Promise(r=>setTimeout(r,20));}
 const approval=got.pendingApprovals?.[0];expect(approval?.summary).toBe("删除文件或文件夹");
 await invoke("approval:decide",{taskId:task.id,toolCallId:approval.toolCallId,approved:false});await waitFor(task.id,["done"]);
});

it("stopping the parent cancels its running child and prevents further tools",async()=>{
 const task=await invoke("task:create",{mode:"single"});let began:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("tool_search",{query:"harness_subagent",limit:1})]),fauxAssistantMessage([fauxToolCall("harness_subagent",{task:"wait",model:fauxModelRef("b")})]),fauxAssistantMessage("must not resume")]);
 ensureFauxRegistered("b").setResponses([(_ctx,options)=>{began();return new Promise(resolve=>options!.signal!.addEventListener("abort",()=>resolve(fauxAssistantMessage("cancelled",{stopReason:"aborted"})),{once:true}));}]);
 await invoke("task:prompt",{taskId:task.id,text:"delegate work"});await started;await invoke("task:abort",{taskId:task.id});
 await waitFor(task.id,["cancelled"]);for(let i=0;i<100;i++){if((await invoke("task:listAgents",{taskId:task.id})).agents[0]?.status==="cancelled")break;await new Promise(r=>setTimeout(r,20));}
 expect((await invoke("task:listAgents",{taskId:task.id})).agents[0]).toMatchObject({status:"cancelled"});
});

it("does not stop a child after 24 model responses",async()=>{
 const task=await invoke("task:create",{mode:"single"});
 ensureFauxRegistered().setResponses([
  fauxAssistantMessage([fauxToolCall("tool_search",{query:"harness_subagent",limit:1})]),
  fauxAssistantMessage([fauxToolCall("harness_subagent",{task:"complete a longer inspection",model:fauxModelRef("b")})]),
  fauxAssistantMessage("parent done"),
 ]);
 ensureFauxRegistered("b").setResponses([
  ...Array.from({length:26},()=>fauxAssistantMessage([fauxToolCall("read",{path:"not-created.txt"})])),
  fauxAssistantMessage("completed all inspection steps"),
 ]);
 await invoke("task:prompt",{taskId:task.id,text:"delegate longer inspection"});
 await waitFor(task.id,["done"]);
 expect((await invoke("task:listAgents",{taskId:task.id})).agents[0]).toMatchObject({status:"done",result:"completed all inspection steps"});
});
