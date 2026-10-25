import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {createHarnessCore,type HarnessCore} from "../core/harness-core.js";
import {createAgent,type CreatedAgent} from "./agent-factory.js";
import {ensureFauxRegistered,fauxModelRef} from "./faux-provider.js";
let core:HarnessCore,agent:CreatedAgent,dir:string;
afterEach(async()=>{await agent?.shutdown();await core?.shutdown();if(dir)rmSync(dir,{recursive:true,force:true});});
it("blocks the third unchanged failed operation and permits a changed diagnostic",async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-failure-guard-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});const ref=fauxModelRef();let actual=0,captured="";
 agent=await createAgent({taskId:"test",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:core.pi.getModel(ref.provider,ref.modelId)!,systemPrompt:"test",tools:["read","ls"],resolveToolPermission:()=>{actual++;return "allow";},requestApproval:async()=>({approved:true}),sessionDir:null});
 ensureFauxRegistered().setResponses([...Array.from({length:3},()=>fauxAssistantMessage([fauxToolCall("read",{path:"missing"})])),fauxAssistantMessage([fauxToolCall("ls",{path:dir})]),ctx=>{captured=JSON.stringify(ctx.messages);return fauxAssistantMessage("diagnosed");}]);
 await agent.session.prompt("检查缺失文件");expect(actual).toBe(3);expect(captured).toContain("同一操作已经连续失败两次");
});

it("reading a document containing error examples is not counted as a failed operation",async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-failure-document-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});const ref=fauxModelRef();let actual=0;
 writeFileSync(join(dir,"guide.txt"),"Traceback (most recent call last)\n🔴 STOP example");
 agent=await createAgent({taskId:"test",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:core.pi.getModel(ref.provider,ref.modelId)!,systemPrompt:"test",tools:["read"],resolveToolPermission:()=>{actual++;return "allow";},requestApproval:async()=>({approved:true}),sessionDir:null});
 ensureFauxRegistered().setResponses([...Array.from({length:3},()=>fauxAssistantMessage([fauxToolCall("read",{path:"guide.txt"})])),fauxAssistantMessage("read")]);
 await agent.session.prompt("核对指南");expect(actual).toBe(3);
});
