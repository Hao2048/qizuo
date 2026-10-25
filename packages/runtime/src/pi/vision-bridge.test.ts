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
it("a text-only conversation can understand a read image through a vision bridge instead of dropping it",async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-vision-repro-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});const ref=fauxModelRef();
 const png="iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";writeFileSync(join(dir,"preview.png"),Buffer.from(png,"base64"));
 let inspected=false,captured="";
 agent=await createAgent({taskId:"test",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:{...core.pi.getModel(ref.provider,ref.modelId)!,input:["text"]},systemPrompt:"test",tools:["read"],resolveToolPermission:()=>"allow",requestApproval:async()=>({approved:true}),sessionDir:null,visionAnalyze:async()=>{inspected=true;return "视觉检查：红色像素";}});
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("read",{path:"preview.png"})]),ctx=>{captured=JSON.stringify(ctx.messages);return fauxAssistantMessage("done");}]);
 await agent.session.prompt("检查预览图");expect(inspected).toBe(true);expect(captured).toContain("视觉检查：红色像素");
});
it("analyzes imported images once across follow-ups and preserves the original attachment",async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-vision-upload-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});const ref=fauxModelRef();let calls=0,captured="";
 agent=await createAgent({taskId:"test",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:{...core.pi.getModel(ref.provider,ref.modelId)!,input:["text"]},systemPrompt:"test",tools:["read"],resolveToolPermission:()=>"allow",requestApproval:async()=>({approved:true}),sessionDir:null,visionAnalyze:async()=>{calls++;return "图中有红色方块";}});
 const image={type:"image" as const,mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=="};
 ensureFauxRegistered().setResponses([ctx=>{captured=JSON.stringify(ctx.messages);return fauxAssistantMessage("seen");},ctx=>{captured=JSON.stringify(ctx.messages);return fauxAssistantMessage("followup");}]);
 await agent.session.prompt("看这张图",{images:[image]});await agent.session.prompt("继续说明");expect(calls).toBe(1);expect(captured).toContain("图中有红色方块");
 expect(agent.session.messages.some(message=>message.role==="user" && Array.isArray(message.content) && message.content.some(block=>block.type==="image"))).toBe(true);
});
it("reports unavailable vision honestly and cancellation reaches the bridge",async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-vision-cancel-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});const ref=fauxModelRef();let cancelled=false,started:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
 agent=await createAgent({taskId:"test",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:{...core.pi.getModel(ref.provider,ref.modelId)!,input:["text"]},systemPrompt:"test",tools:["read"],resolveToolPermission:()=>"allow",requestApproval:async()=>({approved:true}),sessionDir:null,visionAnalyze:async(_image,_prompt,signal)=>{started();return new Promise((_,reject)=>signal!.addEventListener("abort",()=>{cancelled=true;reject(new Error("cancelled"));},{once:true}));}});
 ensureFauxRegistered().setResponses([fauxAssistantMessage("must not send after stop")]);
 const work=agent.session.prompt("检查",{images:[{type:"image",data:"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==",mimeType:"image/png"}]});await ready;agent.setExecutionEnabled(false);await work;expect(cancelled).toBe(true);expect(agent.session.messages.at(-1)).toMatchObject({stopReason:"aborted"});
});

it("does not reconnect failed vision on every tool turn, but retries on a new human request",async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-vision-unavailable-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});const ref=fauxModelRef();let calls=0,captured="";
 agent=await createAgent({taskId:"test",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:{...core.pi.getModel(ref.provider,ref.modelId)!,input:["text"]},systemPrompt:"test",tools:["ls"],resolveToolPermission:()=>"allow",requestApproval:async()=>({approved:true}),sessionDir:null,visionAnalyze:async()=>{calls++;throw new Error("service unavailable");}});
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("ls",{path:dir})]),ctx=>{captured=JSON.stringify(ctx.messages);return fauxAssistantMessage("unavailable");},fauxAssistantMessage("retry report")]);
 const image={type:"image" as const,data:"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==",mimeType:"image/png"};
 await agent.session.prompt("检查图片",{images:[image]});expect(calls).toBe(1);expect(captured).toContain("视觉分析不可用");expect(captured).toContain("不要声称看到了图片");
 await agent.session.prompt("重试分析图片");expect(calls).toBe(2);
});
