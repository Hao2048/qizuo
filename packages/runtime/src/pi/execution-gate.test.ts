import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHarnessCore, type HarnessCore } from "../core/harness-core.js";
import { createAgent, type CreatedAgent } from "./agent-factory.js";
import { ensureFauxRegistered, fauxModelRef } from "./faux-provider.js";
let dir:string, core:HarnessCore, agent:CreatedAgent|undefined;
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-gate-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});});
afterEach(()=>{agent?.setExecutionEnabled(false);agent?.session.dispose();agent=undefined;core.dispose();rmSync(dir,{recursive:true,force:true});});
async function create(allowed?:()=>boolean, extraExtensionPaths?:string[]){
 const ref=fauxModelRef();
 agent=await createAgent({taskId:"gate",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:core.pi.getModel(ref.provider,ref.modelId)!,systemPrompt:"test",tools:["read"],resolveToolPermission:()=>"allow",requestApproval:async()=>({approved:true}),sessionDir:null,deferExecution:true,executionAllowed:allowed,extraExtensionPaths});
 return agent;
}
it("blocks startup and post-stop extension turns before calling the provider, then permits a new request",async()=>{
 let calls=0;
 ensureFauxRegistered().setResponses([()=>{calls++;return fauxAssistantMessage("first");},()=>{calls++;return fauxAssistantMessage("second");}]);
 const a=await create();
 await a.session.sendCustomMessage({customType:"extension_followup",content:"old task",display:false},{triggerTurn:true});
 expect(calls).toBe(0);
 expect(a.session.messages.at(-1)).toMatchObject({stopReason:"aborted"});
 a.setExecutionEnabled(true);await a.session.prompt("new request");expect(calls).toBe(1);
 a.setExecutionEnabled(false);
 await a.session.sendCustomMessage({customType:"extension_followup",content:"continue old task",display:false},{triggerTurn:true});
 expect(calls).toBe(1);
 a.setExecutionEnabled(true);await a.session.prompt("another explicit request");expect(calls).toBe(2);
});
it("revokes member requests when the orchestrator is stopped even if its local switch is open",async()=>{
 let allowed=true,calls=0;
 ensureFauxRegistered().setResponses([()=>{calls++;return fauxAssistantMessage("ok");}]);
 const a=await create(()=>allowed);a.setExecutionEnabled(true);allowed=false;
 await a.session.prompt("queued continuation");expect(calls).toBe(0);
 expect(a.session.messages.at(-1)).toMatchObject({stopReason:"aborted"});
});

it("pauses only an explicitly focused goal and emits shutdown hooks once before disposal",async()=>{
 const extension=join(dir,"goal-adapter.ts");
 writeFileSync(extension,`export default function(pi){
 pi.registerCommand("goal-pause",{description:"pause",handler:async()=>{pi.appendEntry("test_paused",{value:true});}});
 pi.on("session_shutdown",async()=>{pi.appendEntry("test_shutdown",{value:true});});
 }`);
 const a=await create(undefined,[extension]);
 await a.pauseGoals();expect(a.session.sessionManager.getBranch().some(e=>e.type==="custom" && e.customType==="test_paused")).toBe(false);
 a.session.sessionManager.appendCustomEntry("pi-goal-focus",{version:1,focusedGoalId:"owned-goal"});
 await a.pauseGoals();expect(a.session.sessionManager.getBranch().filter(e=>e.type==="custom" && e.customType==="test_paused")).toHaveLength(1);
 a.session.sessionManager.appendCustomEntry("harness_fork",{sourceTaskId:"other"});
 await a.pauseGoals();expect(a.session.sessionManager.getBranch().filter(e=>e.type==="custom" && e.customType==="test_paused")).toHaveLength(1);
 await Promise.all([a.shutdown(),a.shutdown()]);
 expect(a.session.sessionManager.getBranch().filter(e=>e.type==="custom" && e.customType==="test_shutdown")).toHaveLength(1);
});
