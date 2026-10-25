import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {createHarnessCore,type HarnessCore} from "../core/harness-core.js";
import {ensureFauxRegistered,fauxModelRef} from "../pi/faux-provider.js";
let core:HarnessCore,dir:string;
async function api(name:string,input:unknown):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw new Error(r.error.message);return r.result;}
async function wait(id:string,status:string){for(let n=0;n<200;n++){const got=await api("task:get",{taskId:id});if(got.task.status===status)return got;await new Promise(r=>setTimeout(r,10));}throw new Error("timeout");}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-conservative-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});await api("settings:set",{defaultModel:fauxModelRef(),permissionMode:"bypass",autoApproveTools:[]});});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
it("reads independent files in a single tool round, retaining boundaries, partial errors and read telemetry",async()=>{
 writeFileSync(join(dir,"one.txt"),"one\ntwo\nthree");writeFileSync(join(dir,"two.txt"),"second");const project=await api("project:add",{dir});const task=await api("task:create",{projectId:project.id});let request="",calls=0;
 ensureFauxRegistered().setResponses([()=>{calls++;return fauxAssistantMessage([fauxToolCall("read_many",{files:[{path:"one.txt",offset:2,limit:1},{path:"two.txt"},{path:"missing.txt"}]})]);},ctx=>{calls++;request=JSON.stringify(ctx.messages);return fauxAssistantMessage("done");}]);
 await api("task:prompt",{taskId:task.id,text:"inspect independent files"});const got=await wait(task.id,"done");
 expect(calls).toBe(2);expect(request).toContain("two");expect(request).toContain("second");expect(request).toContain("读取失败");
 const output=got.transcript.find((m:any)=>m.toolName==="read_many");expect(output.isError).toBe(true);expect(output.text).toContain("one.txt");expect(output.text).not.toContain("three");
 expect(got.progress.toolExecutionMs).toBeGreaterThanOrEqual(0);expect(got.progress.requestCount).toBe(2);
});
it("batch reading preserves per-file read approvals and never reveals a rejected file",async()=>{
 writeFileSync(join(dir,"allowed.txt"),"allowed content");writeFileSync(join(dir,"denied.txt"),"must remain private");await api("settings:set",{permissionMode:"ask",autoApproveTools:[]});const project=await api("project:add",{dir});const task=await api("task:create",{projectId:project.id});let received="";
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("read_many",{files:[{path:"allowed.txt"},{path:"denied.txt"}]})]),ctx=>{received=JSON.stringify(ctx.messages);return fauxAssistantMessage("done");}]);
 await api("task:prompt",{taskId:task.id,text:"read both files"});
 for(let n=0;n<2;n++){const got=await wait(task.id,"waiting_approval");const approval=got.pendingApprovals[0];expect(approval.toolName).toBe("read");await api("approval:decide",{taskId:task.id,toolCallId:approval.toolCallId,approved:approval.input.path==="allowed.txt"});await new Promise(r=>setTimeout(r,20));}
 await wait(task.id,"done");expect(received).toContain("allowed content");expect(received).not.toContain("must remain private");
});
it("keeps the fixed prefix stable across user requests while publishing actual cache usage",async()=>{
 const task=await api("task:create",{});ensureFauxRegistered().setResponses([fauxAssistantMessage("first"),fauxAssistantMessage("second")]);
 await api("task:prompt",{taskId:task.id,text:"first question"});await wait(task.id,"done");const first=await api("task:getContext",{taskId:task.id});
 await api("task:prompt",{taskId:task.id,text:"different question"});await wait(task.id,"done");const second=await api("task:getContext",{taskId:task.id});
 expect(first.inputBreakdown.prefixHash).toMatch(/^[a-f0-9]{64}$/);expect(second.inputBreakdown.prefixHash).toBe(first.inputBreakdown.prefixHash);
 core.db.prepare("UPDATE usage_ledger SET input_tokens=20,cache_read=80,cache_write=0 WHERE task_id=?").run(task.id);
 expect((await api("task:getContext",{taskId:task.id})).cacheHitPercent).toBe(80);
});

it("stops a batch waiting for approvals without starting further reads",async()=>{
 writeFileSync(join(dir,"one.txt"),"one");writeFileSync(join(dir,"two.txt"),"two");await api("settings:set",{permissionMode:"ask",autoApproveTools:[]});const project=await api("project:add",{dir});const task=await api("task:create",{projectId:project.id});
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("read_many",{files:[{path:"one.txt"},{path:"two.txt"}]})]),fauxAssistantMessage("should not resume")]);
 await api("task:prompt",{taskId:task.id,text:"read files"});await wait(task.id,"waiting_approval");await api("task:abort",{taskId:task.id});const got=await wait(task.id,"cancelled");
 expect(got.pendingApprovals).toEqual([]);expect(got.transcript.some((m:any)=>m.text==="should not resume")).toBe(false);
});

it("measures an actual HTTP provider request and reads reported cache usage without recording request bodies",async()=>{
 const {createServer}=await import("node:http");const {readFileSync}=await import("node:fs");let requests=0;
 const server=createServer((_req,res)=>{requests++;res.writeHead(200,{"Content-Type":"text/event-stream"});res.flushHeaders();setTimeout(()=>{
  res.write('data: '+JSON.stringify({id:"fixture",object:"chat.completion.chunk",model:"fixture",choices:[{index:0,delta:{role:"assistant",content:"hello"},finish_reason:null}]})+'\n\n');
  res.end('data: '+JSON.stringify({id:"fixture",object:"chat.completion.chunk",model:"fixture",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:100,completion_tokens:5,total_tokens:105,prompt_tokens_details:{cached_tokens:80}}})+'\n\ndata: [DONE]\n\n');
 },15);});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{
  const config=JSON.parse(readFileSync(core.pi.modelsPath,"utf8"));config.providers["fixture-http"]={api:"openai-completions",apiKey:"dummy",baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,models:[{id:"fixture",name:"fixture",contextWindow:128000,maxTokens:200,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]};
  writeFileSync(core.pi.modelsPath,JSON.stringify(config));await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});const task=await api("task:create",{model:{provider:"fixture-http",modelId:"fixture"}});
  await api("task:prompt",{taskId:task.id,text:"say hello"});const got=await wait(task.id,"done");const context=await api("task:getContext",{taskId:task.id});
  expect(requests).toBe(1);expect(got.progress.requestCount).toBe(1);expect(got.progress.providerWaitMs).toBeGreaterThanOrEqual(0);expect(got.progress.firstResponseMs).toBeGreaterThanOrEqual(got.progress.providerWaitMs);expect(got.progress.thinkingMs).toBe(0);expect(context.cacheHitPercent).toBe(80);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it("keeps real HTTP instructions stable and replays tool-provider reasoning verbatim across turns",async()=>{
 const {createServer}=await import("node:http");const {readFileSync}=await import("node:fs");const bodies:any[]=[];
 const server=createServer(async(req,res)=>{
  let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);bodies.push(body);const n=bodies.length;
  res.writeHead(200,{"Content-Type":"text/event-stream"});
  const delta=n===1 ? {role:"assistant",reasoning_content:"exact tool reasoning",tool_calls:[{index:0,id:"call-one",type:"function",function:{name:"ls",arguments:JSON.stringify({path:dir})}}]} : {role:"assistant",reasoning_content:`exact final reasoning ${n}`,content:`answer ${n}`};
  res.write('data: '+JSON.stringify({id:"fixture",object:"chat.completion.chunk",model:"fixture",choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  res.end('data: '+JSON.stringify({id:"fixture",object:"chat.completion.chunk",model:"fixture",choices:[{index:0,delta:{},finish_reason:n===1?"tool_calls":"stop"}],usage:{prompt_tokens:100,completion_tokens:5,total_tokens:105}})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{
  const config=JSON.parse(readFileSync(core.pi.modelsPath,"utf8"));config.providers["fixture-reasoning"]={api:"openai-completions",apiKey:"dummy",baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,models:[{id:"fixture",name:"fixture",reasoning:true,contextWindow:1000000,maxTokens:200,compat:{thinkingFormat:"deepseek",requiresReasoningContentOnAssistantMessages:true},cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]};
  writeFileSync(core.pi.modelsPath,JSON.stringify(config));await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});const task=await api("task:create",{model:{provider:"fixture-reasoning",modelId:"fixture"}});
  for(const text of ["inspect files","explain the result","another question"]){await api("task:prompt",{taskId:task.id,text});await wait(task.id,"done");}
  expect(bodies).toHaveLength(4);expect(new Set(bodies.map(b=>JSON.stringify(b.messages[0]))).size).toBe(1);
  expect(bodies[1].messages.find((m:any)=>m.role==="assistant"&&m.tool_calls)?.reasoning_content).toBe("exact tool reasoning");
  expect(bodies[3].messages.filter((m:any)=>m.role==="assistant").map((m:any)=>m.reasoning_content)).toEqual(["exact tool reasoning","exact final reasoning 2","exact final reasoning 3"]);
  expect(bodies[2].messages.slice(0,4)).toEqual(bodies[3].messages.slice(0,4));
  expect(JSON.stringify(bodies[0].messages[0])).not.toContain("inspect files");expect(JSON.stringify(bodies[2].messages[0])).not.toContain("explain the result");
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it("soft-compacts a large-window conversation between turns and retains the complete local transcript",async()=>{
 const {readFileSync}=await import("node:fs");const config=JSON.parse(readFileSync(core.pi.modelsPath,"utf8"));config.providers["pih-faux"].models[0].contextWindow=200000;
 writeFileSync(core.pi.modelsPath,JSON.stringify(config));await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 const longs=Array.from({length:2},(_,i)=>`verified result ${i} `+"x".repeat(340000));const task=await api("task:create",{});ensureFauxRegistered().setResponses(longs.map(text=>fauxAssistantMessage(text)));
 for(let i=0;i<2;i++){await api("task:prompt",{taskId:task.id,text:`task ${i}`});await wait(task.id,"done");}let received="",calls=0;
 ensureFauxRegistered().setResponses(Array.from({length:5},()=>ctx=>{calls++;const isHuman=ctx.messages.some(m=>m.role==="user" && (typeof m.content==="string" ? m.content==="continue task" : m.content.some(b=>b.type==="text" && b.text==="continue task")));if(isHuman){received=JSON.stringify(ctx);return fauxAssistantMessage("continued");}return fauxAssistantMessage("verified result summary, remaining work");}));
 await api("task:prompt",{taskId:task.id,text:"continue task"});const got=await wait(task.id,"done");
 expect(calls).toBeGreaterThanOrEqual(2);expect(received.includes(longs[0]!)).toBe(false);expect(received).toContain("verified result summary");expect(longs.every(text=>got.transcript.some((m:any)=>m.text===text))).toBe(true);
 const context=await api("task:getContext",{taskId:task.id});expect(context.lastCompactedAt).toBeGreaterThan(0);
});

it("continues from original history when soft compaction fails",async()=>{
 const {readFileSync}=await import("node:fs");const config=JSON.parse(readFileSync(core.pi.modelsPath,"utf8"));config.providers["pih-faux"].models[0].contextWindow=200000;
 writeFileSync(core.pi.modelsPath,JSON.stringify(config));await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 const long="original "+"x".repeat(680000);const task=await api("task:create",{});ensureFauxRegistered().setResponses([fauxAssistantMessage(long)]);
 await api("task:prompt",{taskId:task.id,text:"first task"});await wait(task.id,"done");let received="";
 let summaries=0;
 ensureFauxRegistered().setResponses(Array.from({length:6},()=>ctx=>{
  const human=ctx.messages.some(m=>m.role==="user"&&(typeof m.content==="string"?m.content==="continue task":m.content.some(b=>b.type==="text"&&b.text==="continue task")));
  if(human){received=JSON.stringify(ctx);return fauxAssistantMessage("continued safely");}
  summaries++;return fauxAssistantMessage("failed",{stopReason:"error",errorMessage:"summary unavailable"});
 }));
 await api("task:prompt",{taskId:task.id,text:"continue task"});const got=await wait(task.id,"done");expect(received.includes(long)).toBe(true);expect(got.transcript.some((m:any)=>m.text==="continued safely")).toBe(true);expect(summaries).toBe(1);
 let laterSummaries=0;
 ensureFauxRegistered().setResponses(Array.from({length:8},()=>ctx=>{
  const human=ctx.messages.some(m=>m.role==="user"&&(typeof m.content==="string"?m.content==="after fallback":m.content.some(b=>b.type==="text"&&b.text==="after fallback")));
  if(!human)laterSummaries++;
  return fauxAssistantMessage(human?"next turn completed":"retained summary");
 }));
 await api("task:prompt",{taskId:task.id,text:"after fallback"});await wait(task.id,"done");expect(laterSummaries).toBeGreaterThan(0);

});

it("stops during soft compaction without sending the next human request",async()=>{
 const {readFileSync}=await import("node:fs");const config=JSON.parse(readFileSync(core.pi.modelsPath,"utf8"));config.providers["pih-faux"].models[0].contextWindow=200000;
 writeFileSync(core.pi.modelsPath,JSON.stringify(config));await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});const task=await api("task:create",{});
 ensureFauxRegistered().setResponses([fauxAssistantMessage("x".repeat(680000))]);await api("task:prompt",{taskId:task.id,text:"first task"});await wait(task.id,"done");
 let entered!:()=>void,followupCalls=0;const started=new Promise<void>(resolve=>{entered=resolve;});
 ensureFauxRegistered().setResponses([async(_ctx,options)=>{entered();await new Promise<void>(resolve=>{if(options?.signal?.aborted)resolve();else options?.signal?.addEventListener("abort",()=>resolve(),{once:true});});return fauxAssistantMessage("cancelled summary");},()=>{followupCalls++;return fauxAssistantMessage("must not run");}]);
 await api("task:prompt",{taskId:task.id,text:"continue task"});await started;await api("task:abort",{taskId:task.id});const got=await wait(task.id,"cancelled");
 expect(followupCalls).toBe(0);expect(got.transcript.some((m:any)=>m.text==="must not run")).toBe(false);expect((await api("task:getContext",{taskId:task.id})).compacting).toBe(false);
},10000);

it("does not repeatedly summarize an indivisible recent message that compaction keeps",async()=>{
 const {readFileSync}=await import("node:fs");const config=JSON.parse(readFileSync(core.pi.modelsPath,"utf8"));config.providers["pih-faux"].models[0].contextWindow=200000;
 writeFileSync(core.pi.modelsPath,JSON.stringify(config));await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});const task=await api("task:create",{});
 ensureFauxRegistered().setResponses([fauxAssistantMessage("x".repeat(680000))]);await api("task:prompt",{taskId:task.id,text:"first task"});await wait(task.id,"done");let summaries=0;
 ensureFauxRegistered().setResponses(Array.from({length:8},()=>ctx=>{const summary=JSON.stringify(ctx).includes("The messages above");if(summary)summaries++;return fauxAssistantMessage(summary?"compact summary":"short answer");}));
 await api("task:prompt",{taskId:task.id,text:"next"});await wait(task.id,"done");const first=summaries;expect(first).toBeGreaterThan(0);
 await api("task:prompt",{taskId:task.id,text:"another"});await wait(task.id,"done");expect(summaries).toBe(first);
});

 it("does not compact a million-token model at roughly nine percent capacity",async()=>{
 const {readFileSync}=await import("node:fs");const config=JSON.parse(readFileSync(core.pi.modelsPath,"utf8"));config.providers["pih-faux"].models[0].contextWindow=1000000;
 writeFileSync(core.pi.modelsPath,JSON.stringify(config));await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});const task=await api("task:create",{});
 ensureFauxRegistered().setResponses([fauxAssistantMessage("x".repeat(400000))]);await api("task:prompt",{taskId:task.id,text:"first"});await wait(task.id,"done");let calls=0;
 ensureFauxRegistered().setResponses([()=>{calls++;return fauxAssistantMessage("normal answer");}]);await api("task:prompt",{taskId:task.id,text:"next"});await wait(task.id,"done");
 expect(calls).toBe(1);expect((await api("task:getContext",{taskId:task.id})).lastCompactedAt).toBeNull();
 });

it("cancels a stuck summary at its deadline and continues with original history",async()=>{
 const {readFileSync}=await import("node:fs");const config=JSON.parse(readFileSync(core.pi.modelsPath,"utf8"));config.providers["pih-faux"].models[0].contextWindow=200000;
 writeFileSync(core.pi.modelsPath,JSON.stringify(config));await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});const task=await api("task:create",{});
 const long="x".repeat(680000);ensureFauxRegistered().setResponses([fauxAssistantMessage(long)]);await api("task:prompt",{taskId:task.id,text:"first"});await wait(task.id,"done");
 let entered!:()=>void,received="";const started=new Promise<void>(resolve=>{entered=resolve;});
 ensureFauxRegistered().setResponses(Array.from({length:6},()=>async(ctx,options)=>{
  const human=ctx.messages.some(m=>m.role==="user"&&(typeof m.content==="string"?m.content==="next":m.content.some(b=>b.type==="text"&&b.text==="next")));
  if(human){received=JSON.stringify(ctx);return fauxAssistantMessage("resumed");}
  entered();await new Promise<void>(resolve=>{if(options?.signal?.aborted)resolve();else options?.signal?.addEventListener("abort",()=>resolve(),{once:true});});return fauxAssistantMessage("aborted",{stopReason:"aborted"});
 }));
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
 try{await api("task:prompt",{taskId:task.id,text:"next"});await started;expect((await api("task:getContext",{taskId:task.id})).compacting).toBe(true);await vi.advanceTimersByTimeAsync(180000);}finally{vi.useRealTimers();}
 await wait(task.id,"done");expect(received.includes(long)).toBe(true);expect((await api("task:getContext",{taskId:task.id})).compacting).toBe(false);
},10000);

it("persists individual turn durations across subsequent turns, reloads and reply forks",async()=>{
 const task=await api("task:create",{});ensureFauxRegistered().setResponses([fauxAssistantMessage("first result"),fauxAssistantMessage("second result")]);
 await api("task:prompt",{taskId:task.id,text:"first"});await wait(task.id,"done");
 const first=(await api("task:get",{taskId:task.id})).transcript;expect(first[0].turnDurationMs).toBeGreaterThanOrEqual(0);expect(first[0].turnOutcome).toBe("complete");
 await api("task:prompt",{taskId:task.id,text:"second"});await wait(task.id,"done");await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 const full=(await api("task:get",{taskId:task.id})).transcript;expect(full[0].turnDurationMs).toBe(first[0].turnDurationMs);expect(full.filter((m:any)=>m.role==="user").every((m:any)=>m.turnDurationMs!==undefined)).toBe(true);
 const fork=await api("task:fork",{taskId:task.id,entryId:first.find((m:any)=>m.role==="assistant").entryId});expect((await api("task:get",{taskId:fork.id})).transcript[0].turnDurationMs).toBe(first[0].turnDurationMs);
});
