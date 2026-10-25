import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createHarnessCore, type HarnessCore } from "../core/harness-core.js";
import { ensureFauxRegistered, fauxModelRef } from "../pi/faux-provider.js";
import type { ConversationReference, TranscriptMessage } from "@pi-harness/contracts";
let core:HarnessCore,dir:string;
async function invoke(name:string,input:unknown):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw new Error(r.error.message);return r.result;}
async function settled(id:string){for(let i=0;i<600;i++){const got=await invoke("task:get",{taskId:id});if(["done","error","cancelled"].includes(got.task.status))return got;await new Promise(r=>setTimeout(r,25));}throw new Error("timeout");}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-context-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});await invoke("settings:set",{defaultModel:fauxModelRef(),permissionMode:"bypass",autoApproveTools:[]});});
afterEach(()=>{core.dispose();rmSync(dir,{recursive:true,force:true});});
it("blocks replayed writes on a forked history question, then permits an explicit new request",async()=>{
 const target=join(dir,"must-not-exist.txt");
 ensureFauxRegistered().setResponses([fauxAssistantMessage("已经完成修改")]);
 const source=await invoke("task:create",{title:"source"});await invoke("task:prompt",{taskId:source.id,text:"修改文档"});await settled(source.id);
 const tree=await invoke("task:getTree",{taskId:source.id});
 const user=tree.userMessages[0];
 const fork=await invoke("task:fork",{taskId:source.id,entryId:user.entryId});
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("write",{path:target,content:"replayed"})]),fauxAssistantMessage("只回顾历史")]);
 await invoke("task:prompt",{taskId:fork.id,text:"之前做了什么？"});const got=await settled(fork.id);
 expect(existsSync(target)).toBe(false);expect(got.transcript.some((m:TranscriptMessage)=>m.isError&&m.text?.includes("历史回顾"))).toBe(true);
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("write",{path:target,content:"new request"})]),fauxAssistantMessage("done")]);
 await invoke("task:prompt",{taskId:fork.id,text:"现在创建文件"});await settled(fork.id);expect(existsSync(target)).toBe(true);
},30000);
it("keeps a reference snapshot after deleting its source and marks it on the actual user message",async()=>{
 ensureFauxRegistered().setResponses([fauxAssistantMessage("原会话结果")]);
 const source=await invoke("task:create",{});await invoke("task:prompt",{taskId:source.id,text:"原始请求"});await settled(source.id);
 const ref=await invoke("task:captureReference",{sourceTaskId:source.id}) as ConversationReference;
 await invoke("task:delete",{taskId:source.id});
 let requestContext="", userCount=0;ensureFauxRegistered().setResponses([context=>{requestContext=JSON.stringify(context); userCount=context.messages.filter(m=>m.role==="user").length; return fauxAssistantMessage("参考完成");}]);
 const target=await invoke("task:create",{});await invoke("task:prompt",{taskId:target.id,text:"比较这次结果",referenceIds:[ref.id]});const got=await settled(target.id);
 expect(userCount).toBe(1);expect(requestContext).toContain("原会话结果");expect(requestContext).toContain("不属于当前请求");
 const user=got.transcript.find((m:TranscriptMessage)=>m.role==="user");expect(user.text).toBe("比较这次结果");expect(user.references).toEqual([ref]);
 await invoke("task:delete",{taskId:target.id});expect(core.db.prepare("SELECT * FROM conversation_references WHERE id=?").get(ref.id)).toBeUndefined();
},30000);
it("bounds provider context while preserving full paged output across a fork and source deletion",async()=>{
 const text="START-"+"abcdef".repeat(4000)+"-END",file=join(dir,"large.txt");writeFileSync(file,text);
 let modelResult="";ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("read",{path:file})]),context=>{modelResult=JSON.stringify(context);return fauxAssistantMessage("done");}]);
 const project=await invoke("project:add",{dir});const task=await invoke("task:create",{projectId:project.id});
 await invoke("task:prompt",{taskId:task.id,text:"读取文件"});const got=await settled(task.id);
 const result=got.transcript.find((m:TranscriptMessage)=>m.role==="toolResult");expect(result.outputId).toMatch(/^[a-f0-9]{64}$/);
 expect(modelResult).toContain("read_tool_output");expect(modelResult).not.toContain(text);
 const first=await invoke("task:readOutput",{taskId:task.id,outputId:result.outputId,limit:12000});expect(first.totalChars).toBe(text.length);
 const tree=await invoke("task:getTree",{taskId:task.id});const user=tree.userMessages[0];
 const fork=await invoke("task:fork",{taskId:task.id,entryId:user.entryId});await invoke("task:delete",{taskId:task.id});
 expect((await invoke("task:readOutput",{taskId:fork.id,outputId:result.outputId})).text).toBe(text.slice(0,12000));
 await invoke("task:delete",{taskId:fork.id});expect(core.db.prepare("SELECT * FROM tool_outputs").all()).toHaveLength(0);
},30000);

it("preserves full chat history and a durable task anchor through compaction and restart",async()=>{
 const long="历史结果 "+"x".repeat(90000);
 ensureFauxRegistered().setResponses([
  fauxAssistantMessage([fauxToolCall("update_plan",{steps:[{content:"保留未完成事项",status:"in_progress"},{content:"已经验证",status:"completed"}]})]),
  fauxAssistantMessage(long),fauxAssistantMessage("任务摘要，仍有未完成事项"),
 ]);
 const task=await invoke("task:create",{});await invoke("task:prompt",{taskId:task.id,text:"当前目标：完成登录优化"});await settled(task.id);
 const before=await invoke("task:getContext",{taskId:task.id});expect(before.source).toBe("estimate");
 const result=await invoke("task:compact",{taskId:task.id});expect(result.ok).toBe(true);
 const after=await invoke("task:getContext",{taskId:task.id});expect(after.currentTokens).toBeNull();expect(after.percent).toBeNull();expect(after.lastRequestTokens).toBe(before.lastRequestTokens);expect(after.lastCompactedAt).toBeGreaterThan(0);
 let got=await invoke("task:get",{taskId:task.id});expect(got.transcript.some((m:TranscriptMessage)=>m.text===long)).toBe(true);
 core.dispose();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 got=await invoke("task:get",{taskId:task.id});expect(got.transcript.some((m:TranscriptMessage)=>m.text===long)).toBe(true);
 core.db.prepare("UPDATE tasks SET plan=? WHERE id=?").run(JSON.stringify([{content:"已完成",status:"completed"}]),task.id);
 let context="";ensureFauxRegistered().setResponses([request=>{context=JSON.stringify(request);return fauxAssistantMessage("继续参考状态");}]);
 await invoke("task:prompt",{taskId:task.id,text:"只解释目前进展"});await settled(task.id);
 expect(context).toContain("保留未完成事项");expect(context).toContain("不是新的执行授权");expect(context).toContain("当前目标：完成登录优化");expect(context).toContain("当前计划状态（覆盖压缩时的旧计划）：1 项完成，0 项未完成");
 expect(core.db.prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id=? AND type='context_projection'").get(task.id)).toEqual({count:1});
 expect((await invoke("task:getContext",{taskId:task.id})).currentTokens).toBeGreaterThan(0);
},30000);
it("a failed compaction preserves history, reports failure, and never persists a new protection anchor",async()=>{
 ensureFauxRegistered().setResponses([fauxAssistantMessage("原始结果"),fauxAssistantMessage("failed",{stopReason:"error",errorMessage:"summary unavailable"})]);
 const task=await invoke("task:create",{});await invoke("task:prompt",{taskId:task.id,text:"原始任务"});await settled(task.id);
 const events:any[]=[];core.router.onEvent(event=>events.push(event));
 const result=await invoke("task:compact",{taskId:task.id});expect(result.ok).toBe(false);
 expect((await invoke("task:get",{taskId:task.id})).transcript.some((m:TranscriptMessage)=>m.text==="原始结果")).toBe(true);
 const row=core.db.prepare("SELECT pi_session_id FROM tasks WHERE id=?").get(task.id) as {pi_session_id:string};
 const {SessionManager}=await import("@earendil-works/pi-coding-agent");expect(SessionManager.open(row.pi_session_id).getBranch().some(e=>e.type==="custom"&&e.customType==="harness_compaction_state")).toBe(false);
 expect(events.some(e=>e.type==="task:phase"&&e.payload.detail?.includes("压缩失败"))).toBe(true);
},30000);
it("automatically compacts at an adapted small-window threshold and preserves an anchor",async()=>{
 const config=JSON.parse(readFileSync(core.pi.modelsPath,"utf8"));config.providers["pih-faux"].models[0].contextWindow=8192;
 writeFileSync(core.pi.modelsPath,JSON.stringify(config));core.dispose();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 const phases:any[]=[];core.router.onEvent(event=>{if(event.type==="task:phase")phases.push(event.payload);});
 ensureFauxRegistered().setResponses(Array.from({length:40},()=>context=>fauxAssistantMessage(JSON.stringify(context).includes("The messages above") ? "## Goal\n完成任务，保留剩余事项" : "本轮历史结果 "+"x".repeat(3000))));
 const task=await invoke("task:create",{});
 for(let turn=0;turn<8;turn++){await invoke("task:prompt",{taskId:task.id,text:`第 ${turn} 轮继续检查`});await settled(task.id);}
 const ctx=await invoke("task:getContext",{taskId:task.id});expect(ctx.contextWindow).toBe(8192);expect(ctx.thresholdTokens).toBeLessThan(8192);
 expect(phases.some(p=>p.phase==="compaction_start"&&p.detail.includes("正在整理上下文"))).toBe(true);
 const row=core.db.prepare("SELECT pi_session_id FROM tasks WHERE id=?").get(task.id) as {pi_session_id:string};
 const {SessionManager}=await import("@earendil-works/pi-coding-agent");expect(SessionManager.open(row.pi_session_id).getBranch().some(e=>e.type==="custom"&&e.customType==="harness_compaction_state")).toBe(true);
 expect((await invoke("task:get",{taskId:task.id})).transcript.filter((m:TranscriptMessage)=>m.role==="user")).toHaveLength(8);
},30000);


it("forks at a selected assistant reply and publishes its durable entry ID",async()=>{
 const events:any[]=[];core.router.onEvent(e=>events.push(e));
 const task=await invoke("task:create",{});
 ensureFauxRegistered().setResponses([fauxAssistantMessage("第一条回复")]);
 await invoke("task:prompt",{taskId:task.id,text:"第一轮"});const first=await settled(task.id);
 const reply=first.transcript.find((m:TranscriptMessage)=>m.role === "assistant");
 expect(reply.entryId).toBeTruthy();
 expect(events.find(e=>e.type === "task:stream" && e.payload.kind === "assistant_message_end")?.payload.message.entryId).toBe(reply.entryId);
 ensureFauxRegistered().setResponses([fauxAssistantMessage("后续回复")]);
 await invoke("task:prompt",{taskId:task.id,text:"第二轮"});await settled(task.id);
 const fork=await invoke("task:fork",{taskId:task.id,entryId:reply.entryId});
 const got=await invoke("task:get",{taskId:fork.id});
 expect(got.task.status).toBe("draft");
 expect(got.transcript.filter((m:TranscriptMessage)=>m.role === "assistant").map((m:TranscriptMessage)=>m.text)).toEqual(["第一条回复"]);
 expect(got.transcript.some((m:TranscriptMessage)=>m.text === "第二轮")).toBe(false);
});

it("recovers a transient 502 while sending a reference without reporting a final failure",async()=>{
 ensureFauxRegistered().setResponses([fauxAssistantMessage("已记录引用结果")]);
 const source=await invoke("task:create",{});await invoke("task:prompt",{taskId:source.id,text:"来源"});await settled(source.id);
 const ref=await invoke("task:captureReference",{sourceTaskId:source.id});
 const events:any[]=[];core.router.onEvent(e=>events.push(e));
 ensureFauxRegistered().setResponses([
  fauxAssistantMessage("",{stopReason:"error",errorMessage:'502 "acp-proxy failure"'}),
  fauxAssistantMessage("重试成功，引用回答已完成"),
 ]);
 const task=await invoke("task:create",{});await invoke("task:prompt",{taskId:task.id,text:"回顾引用内容",referenceIds:[ref.id]});
 const got=await settled(task.id);
 expect(got.task.status).toBe("done");
 expect(got.transcript.some((m:TranscriptMessage)=>m.text === "重试成功，引用回答已完成")).toBe(true);
 expect(events.some(e=>e.type === "task:state" && e.payload.taskId === task.id && e.payload.status === "error")).toBe(false);
 expect(events.some(e=>e.type === "task:state" && e.payload.taskId === task.id && e.payload.detail?.includes("正在重试"))).toBe(true);
});

it("publishes bounded input diagnostics with accurate grouping, retains them after restart and clears stale estimates after compaction",async()=>{
 ensureFauxRegistered().setResponses([fauxAssistantMessage("history "+"x".repeat(90000))]);
 const task=await invoke("task:create",{});await invoke("task:prompt",{taskId:task.id,text:"explain briefly"});await settled(task.id);
 const before=await invoke("task:getContext",{taskId:task.id});
 const parts=before.inputBreakdown;expect(parts).toBeTruthy();
 expect(before.currentTokens).toBe(parts.systemTokens+parts.historyTokens+parts.toolResultTokens);
 expect(parts.activeToolCount).toBeGreaterThan(0);expect(parts.toolDefinitionTokens).toBeLessThanOrEqual(parts.systemTokens);
 core.dispose();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 expect((await invoke("task:getContext",{taskId:task.id})).inputBreakdown).toEqual(parts);
 expect((await invoke("task:getRoleContexts",{taskId:task.id})).roles[0].context.inputBreakdown).toEqual(parts);
 ensureFauxRegistered().setResponses([fauxAssistantMessage("summary")]);
 expect((await invoke("task:compact",{taskId:task.id})).ok).toBe(true);
 expect((await invoke("task:getContext",{taskId:task.id})).inputBreakdown).toBeUndefined();
 expect(core.db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id=? AND type='context_projection'").get(task.id)).toEqual({n:1});
});

it("acknowledges long plans without echoing the whole plan into every tool result",async()=>{
 const steps=Array.from({length:30},(_,i)=>({content:`step ${i} `+"details ".repeat(30),status:i===0 ? "in_progress" : "pending"}));
 let receipt="";
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("update_plan",{steps})]),context=>{receipt=context.messages.filter(m=>m.role==="toolResult").map(m=>m.content.filter(c=>c.type==="text").map(c=>c.text).join("\n")).join("\n");return fauxAssistantMessage("done");}]);
 const task=await invoke("task:create",{});await invoke("task:prompt",{taskId:task.id,text:"plan thirty steps"});const got=await settled(task.id);
 expect(got.task.plan).toEqual(steps);
 expect(receipt).toContain("计划已更新");expect(receipt.length).toBeLessThan(120);
});
