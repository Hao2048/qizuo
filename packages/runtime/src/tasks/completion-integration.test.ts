import {afterEach,beforeEach,expect,it} from "vitest";
import {mkdtempSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {createHarnessCore,type HarnessCore} from "../core/harness-core.js";
import {ensureFauxRegistered,fauxModelRef} from "../pi/faux-provider.js";
let core:HarnessCore,dir:string;
async function invoke(name:string,input:unknown={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result;}
async function settled(id:string){for(let i=0;i<500;i++){const r=await invoke("task:get",{taskId:id});if(["done","error","cancelled"].includes(r.task.status)){await new Promise(r=>setTimeout(r,20));return invoke("task:get",{taskId:id});}await new Promise(r=>setTimeout(r,10));}throw Error("timeout");}
const tool=(name:string,args:Parameters<typeof fauxToolCall>[1])=>fauxAssistantMessage([fauxToolCall(name,args)]);
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-completion-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});await invoke("settings:set",{defaultModel:fauxModelRef(),permissionMode:"bypass",autoApproveTools:[]});});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
it("records unfinished current plans, persists the receipt, and never replays or contaminates a historical question",async()=>{
 const task=await invoke("task:create");let calls=0;
 ensureFauxRegistered().setResponses([tool("update_plan",{steps:[{content:"write output",status:"in_progress"}]}),()=>{calls++;return fauxAssistantMessage("全部完成");}]);
 await invoke("task:prompt",{taskId:task.id,text:"处理任务"});let r=await settled(task.id);
 expect(r.task).toMatchObject({status:"done",completion:{outcome:"needs_attention",issues:[{code:"plan_pending"}]}});expect(r.task.plan[0].status).toBe("in_progress");expect(calls).toBe(1);
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 expect((await invoke("task:get",{taskId:task.id})).task.completion).toEqual(r.task.completion);
 ensureFauxRegistered().setResponses([()=>{calls++;return fauxAssistantMessage("仅回顾已有记录");}]);
 await invoke("task:prompt",{taskId:task.id,text:"之前做了什么"});r=await settled(task.id);
 expect(r.task.completion).toMatchObject({outcome:"reply_ended",issues:[]});expect(calls).toBe(2);expect(r.task.plan[0].status).toBe("in_progress");
 expect(core.db.prepare("SELECT id FROM task_events WHERE task_id=? AND type='completion_check'").all(task.id)).toHaveLength(1);
 await invoke("task:delete",{taskId:task.id});expect(core.db.prepare("SELECT id FROM task_events WHERE task_id=?").all(task.id)).toHaveLength(0);
});
it("surfaces failed tools but clears them after an actual successful identical retry",async()=>{
 const t=await invoke("task:create"),path=join(dir,"missing.txt");
 ensureFauxRegistered().setResponses([tool("read",{path}),fauxAssistantMessage("完成")]);
 await invoke("task:prompt",{taskId:t.id,text:"读取文件"});expect((await settled(t.id)).task.completion.issues).toMatchObject([{code:"tool_failed"}]);
 ensureFauxRegistered().setResponses([tool("read",{path}),tool("write",{path,content:"ok"}),tool("read",{path}),fauxAssistantMessage("已重试验证")]);
 await invoke("task:prompt",{taskId:t.id,text:"创建后验证"});expect((await settled(t.id)).task.completion).toMatchObject({outcome:"reply_ended",issues:[]});expect(existsSync(path)).toBe(true);
});
it("detects truncation without adding a model call or automatically continuing",async()=>{
 const t=await invoke("task:create");let calls=0;
 ensureFauxRegistered().setResponses([()=>{calls++;return fauxAssistantMessage("尚未说完",{stopReason:"length"});}]);
 await invoke("task:prompt",{taskId:t.id,text:"回答"});const r=await settled(t.id);
 expect(r.task.status).toBe("done");expect(r.task.completion.issues).toMatchObject([{code:"response_incomplete"}]);expect(calls).toBe(1);
});
it("plan approval and complete execution keep their existing permissions",async()=>{
 await invoke("settings:set",{permissionMode:"plan",autoApproveTools:[]});const t=await invoke("task:create");
 const steps=[{content:"写入报告",status:"pending"}];ensureFauxRegistered().setResponses([tool("update_plan",{steps}),fauxAssistantMessage("等待批准")]);
 await invoke("task:prompt",{taskId:t.id,text:"制定计划"});const draft=await settled(t.id);
 expect(draft.task.completion.issues).toMatchObject([{code:"plan_approval"}]);
 ensureFauxRegistered().setResponses([fauxAssistantMessage("已全部完成")]);await invoke("task:approvePlan",{taskId:t.id,revision:draft.task.planState.revision});
 expect((await settled(t.id)).task.completion.issues).toMatchObject([{code:"plan_pending"}]);
 ensureFauxRegistered().setResponses([tool("update_plan",{steps:[{content:"写入报告",status:"completed"}]}),fauxAssistantMessage("计划执行记录已更新")]);
 await invoke("task:approvePlan",{taskId:t.id,revision:draft.task.planState.revision});
 expect((await settled(t.id)).task.completion.outcome).toBe("reply_ended");expect((await invoke("settings:get")).permissionMode).toBe("plan");
});
it("stopping a blocked approval never certifies completion or executes the denied write",async()=>{
 await invoke("settings:set",{permissionMode:"ask",autoApproveTools:[]});const t=await invoke("task:create"),path=join(dir,"denied.txt");
 ensureFauxRegistered().setResponses([tool("write",{path,content:"no"}),fauxAssistantMessage("done")]);await invoke("task:prompt",{taskId:t.id,text:"写入"});
 for(let i=0;i<300;i++){if((await invoke("task:get",{taskId:t.id})).pendingApprovals.length)break;await new Promise(r=>setTimeout(r,10));}
 await invoke("task:abort",{taskId:t.id});const r=await settled(t.id);expect(r.task.status).toBe("cancelled");expect(r.task.completion).toBeNull();expect(existsSync(path)).toBe(false);
});

it("denied approval remains an observable failed operation, not successful work",async()=>{
 await invoke("settings:set",{permissionMode:"ask",autoApproveTools:[]});const t=await invoke("task:create"),path=join(dir,"refused.txt");
 ensureFauxRegistered().setResponses([tool("write",{path,content:"no"}),fauxAssistantMessage("全部完成")]);await invoke("task:prompt",{taskId:t.id,text:"写文件"});
 let approval;for(let i=0;i<300;i++){approval=(await invoke("task:get",{taskId:t.id})).pendingApprovals[0];if(approval)break;await new Promise(r=>setTimeout(r,10));}
 expect(approval).toBeTruthy();await invoke("approval:decide",{taskId:t.id,toolCallId:approval.toolCallId,approved:false});
 const r=await settled(t.id);expect(r.task.completion.issues).toMatchObject([{code:"tool_failed"}]);expect(existsSync(path)).toBe(false);
 expect((await invoke("task:listActivity")).items.find((item:any)=>item.id===t.id).completion).toEqual(r.task.completion);
});

it("concurrent roles keep completion facts separate and do not inject receipts into prompts",async()=>{
 const a=await invoke("role:create",{name:"A",systemPrompt:"PRIVATE_A",preferredModel:fauxModelRef("a")});
 const b=await invoke("role:create",{name:"B",systemPrompt:"PRIVATE_B",preferredModel:fauxModelRef("b")});
 const ta=await invoke("task:create",{roleId:a.id}),tb=await invoke("task:create",{roleId:b.id});let privateB="";
 ensureFauxRegistered("a").setResponses([tool("read",{path:join(dir,"missing.txt")}),fauxAssistantMessage("完成")]);
 ensureFauxRegistered("b").setResponses([ctx=>{privateB=JSON.stringify(ctx);return fauxAssistantMessage("你好");}]);
 await invoke("task:prompt",{taskId:ta.id,text:"检查"});await invoke("task:prompt",{taskId:tb.id,text:"问好"});
 expect((await settled(ta.id)).task.completion.outcome).toBe("needs_attention");
 expect((await settled(tb.id)).task.completion.outcome).toBe("reply_ended");expect(privateB).not.toMatch(/PRIVATE_A|completion_check|needs_attention/);
});
