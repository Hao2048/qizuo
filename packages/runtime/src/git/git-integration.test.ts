import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createHarnessCore, type HarnessCore } from "../core/harness-core.js";
import { ensureFauxRegistered, fauxModelRef } from "../pi/faux-provider.js";
let dir:string, projectDir:string, core:HarnessCore;
function git(...args:string[]) {return execFileSync("git",args,{cwd:projectDir,encoding:"utf8"}).trim();}
async function call(name:string,input:unknown={}) {if(name==="settings:set") input={...core.tasks.getSettings(),...(input as object)};const result=await core.router.invoke(name as any,input);if(!result.ok)throw new Error(result.error.message);return result.result as any;}
async function wait(taskId:string) {for(let i=0;i<300;i++){const result=await call("task:get",{taskId});if(["done","error","cancelled"].includes(result.task.status))return result;await new Promise(r=>setTimeout(r,20));}throw new Error("Task did not finish");}
async function task() {const p=await call("project:add",{dir:projectDir});return call("task:create",{projectId:p.id});}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-git-core-"));projectDir=join(dir,"project");mkdirSync(projectDir);git("init","-q","-b","main");git("config","user.name","Fixture");git("config","user.email","fixture@example.invalid");writeFileSync(join(projectDir,"file.txt"),"before\n");git("add","file.txt");git("commit","-qm","initial");core=await createHarnessCore({dataDir:dir,enableFaux:true});await call("settings:set",{defaultModel:fauxModelRef(),permissionMode:"auto_edit"});});
afterEach(()=>{core.dispose();rmSync(dir,{recursive:true,force:true});});
it("models can create a task branch and commit verified changes through the dedicated tool",async()=>{
 const t=await task();ensureFauxRegistered().setResponses([
 fauxAssistantMessage([fauxToolCall("harness_git",{action:"status"})]),
 fauxAssistantMessage([fauxToolCall("harness_git",{action:"create_branch",branch:"feature/task"})]),
 fauxAssistantMessage([fauxToolCall("write",{path:"file.txt",content:"after\n"})]),
 fauxAssistantMessage([fauxToolCall("harness_git",{action:"commit",paths:["file.txt"],message:"Implement task"})]),
 fauxAssistantMessage("完成"),
 ]);await call("task:prompt",{taskId:t.id,text:"改文件并按需要创建分支和提交"});const result=await wait(t.id);
 const tools=result.transcript.filter((m:any)=>m.role==="toolResult");expect(tools.filter((m:any)=>m.isError)).toHaveLength(0);
 expect(git("branch","--show-current")).toBe("feature/task");expect(git("log","-1","--format=%s")).toBe("Implement task");expect(git("show","HEAD:file.txt")).toBe("after");expect(core.checkpoints.list(t.id)).toHaveLength(0);
},15_000);
it("plan mode blocks Git mutations even when a custom tool is exempt from approval",async()=>{
 await call("settings:set",{permissionMode:"plan"});const t=await task();ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("harness_git",{action:"create_branch",branch:"must-not-exist"})]),fauxAssistantMessage("只读完成")]);await call("task:prompt",{taskId:t.id,text:"规划"});const result=await wait(t.id);expect(result.transcript.find((m:any)=>m.toolName==="harness_git"&&m.role==="toolResult")?.isError).toBe(true);expect(git("branch","--show-current")).toBe("main");
});
it("deleting an idle chat removes session files, old backups and task records while retaining project Git",async()=>{
 const t=await task();ensureFauxRegistered().setResponses([fauxAssistantMessage("完成")]);await call("task:prompt",{taskId:t.id,text:"对话"});await wait(t.id);
 const row=core.db.prepare("SELECT pi_session_id FROM tasks WHERE id=?").get(t.id) as {pi_session_id:string};expect(existsSync(row.pi_session_id)).toBe(true);
 const backup=core.checkpoints.backupFiles(t.id,[join(projectDir,"file.txt")]);core.checkpoints.record(t.id,"legacy",{},backup);expect(existsSync(join(dir,"checkpoints",t.id))).toBe(true);
 mkdirSync(join(dir,"workspaces",t.id),{recursive:true});writeFileSync(join(dir,"workspaces",t.id,"old.txt"),"old");
 expect(await call("task:delete",{taskId:t.id})).toEqual({ok:true});for(const name of ["tasks","task_events","checkpoints","usage_ledger","task_graph_nodes"])expect(core.db.prepare(`SELECT COUNT(*) AS n FROM ${name} WHERE ${name==="tasks"?"id":"task_id"}=?`).get(t.id)).toEqual({n:0});
 expect(existsSync(row.pi_session_id)).toBe(false);expect(existsSync(join(dir,"checkpoints",t.id))).toBe(false);expect(existsSync(join(dir,"workspaces",t.id))).toBe(false);expect(git("log","-1","--format=%s")).toBe("initial");expect(readFileSync(join(projectDir,"file.txt"),"utf8")).toBe("before\n");await expect(call("task:get",{taskId:t.id})).rejects.toThrow("任务不存在");
});
it("running chats cannot be deleted or mutated from the Git panel, and abort allows deletion",async()=>{
 await call("settings:set",{permissionMode:"ask"});const t=await task();ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("write",{path:"file.txt",content:"after"})]),fauxAssistantMessage("完成")]);await call("task:prompt",{taskId:t.id,text:"改文件"});
 for(let i=0;i<100;i++){if((await call("task:get",{taskId:t.id})).task.status==="waiting_approval")break;await new Promise(r=>setTimeout(r,20));}
 await expect(call("task:delete",{taskId:t.id})).rejects.toThrow("先停止");await expect(call("git:mutate",{taskId:t.id,action:"create_branch",branch:"blocked"})).rejects.toThrow("先停止");await call("task:abort",{taskId:t.id});expect(await call("task:delete",{taskId:t.id})).toEqual({ok:true});expect(git("branch","--show-current")).toBe("main");
});
it("no installed Git does not prevent ordinary chat or generate fallback snapshots",async()=>{
 core.dispose();core=await createHarnessCore({dataDir:dir,enableFaux:true,gitBinary:null});await call("settings:set",{defaultModel:fauxModelRef(),permissionMode:"auto_edit"});const t=await task();ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("write",{path:"file.txt",content:"normal chat"})]),fauxAssistantMessage("完成")]);await call("task:prompt",{taskId:t.id,text:"改文件"});const result=await wait(t.id);expect(result.task.status).toBe("done");expect(await call("git:status",{taskId:t.id})).toMatchObject({available:false});expect(core.checkpoints.list(t.id)).toHaveLength(0);
});
it("deleting the source conversation keeps a fork's independent session intact",async()=>{
 const t=await task();ensureFauxRegistered().setResponses([fauxAssistantMessage("原会话")]);await call("task:prompt",{taskId:t.id,text:"开始"});await wait(t.id);const tree=await call("task:getTree",{taskId:t.id});const fork=await call("task:fork",{taskId:t.id,entryId:tree.userMessages[0].entryId});const row=core.db.prepare("SELECT pi_session_id FROM tasks WHERE id=?").get(fork.id) as {pi_session_id:string};await call("task:delete",{taskId:t.id});expect(existsSync(row.pi_session_id)).toBe(true);expect((await call("task:get",{taskId:fork.id})).task.id).toBe(fork.id);
});
