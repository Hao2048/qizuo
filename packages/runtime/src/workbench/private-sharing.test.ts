import {afterEach,beforeEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {createHarnessCore,type HarnessCore} from "../core/harness-core.js";
import {ensureFauxRegistered,fauxModelRef} from "../pi/faux-provider.js";
let core:HarnessCore,dir:string,a:string;
const secret="ROLE_INTERNAL_CANARY_7a91";
const json=(v:unknown)=>fauxAssistantMessage(JSON.stringify(v));
async function call(name:string,input:unknown={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result;}
async function settled(id:string){for(let i=0;i<400;i++){const w=core.workbench.get(id);if(w.phase==="error")throw Error(w.messages.at(-1)?.text);if(w.phase==="awaiting_review")return w;await new Promise(r=>setTimeout(r,10));}throw Error("timeout");}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-private-share-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});await call("settings:set",{defaultModel:fauxModelRef(),permissionMode:"bypass",autoApproveTools:[]});a=(await call("role:create",{name:"研究员",intro:"整理公开资料",systemPrompt:`只做研究，私有标记 ${secret} 不得共享`,preferredModel:fauxModelRef("a")})).id;});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
it("keeps the raw private final reply in its task without copying it into shared results or later routing",async()=>{
 const w=await call("workbench:create",{title:"私有回复",roleIds:[a]});
 ensureFauxRegistered().setResponses([json({reply:"开始研究",action:"dispatch",roleIds:[a],assignments:[{roleId:a,instructions:"整理公开资料",files:["research.txt"],dependsOn:[],deliverables:[{path:"research.txt",format:"text",includes:["公开结论"]}]}]})]);
 ensureFauxRegistered("a").setResponses([json({plan:"读取公开材料并写研究",contracts:[]}),fauxAssistantMessage([fauxToolCall("write",{path:"research.txt",content:"公开结论"})]),fauxAssistantMessage(`文件完成，私有标记 ${secret} 没有共享。`)]);
 await call("workbench:send",{id:w.id,text:"开始研究",requestId:"first"});const done=await settled(w.id);
 const own=await call("task:get",{taskId:done.participants[0]!.taskId});expect(JSON.stringify(own.transcript)).toContain(secret);
 expect(JSON.stringify(done.messages)).not.toContain(secret);
 expect(done.messages.findLast(m=>m.sender===a&&m.kind==="result")?.text).toContain("research.txt");
 let request="";ensureFauxRegistered().setResponses([ctx=>{request=JSON.stringify(ctx);return json({reply:"已完成研究，等待审阅",action:"clarify",roleIds:[],assignments:[]});}]);
 await call("workbench:send",{id:w.id,text:"只回顾刚才做了什么，不执行",requestId:"recap"});await settled(w.id);expect(request).not.toContain(secret);expect((await call("task:get",{taskId:done.participants[0]!.taskId})).task.id).toBe(own.task.id);
});
it("does not give private prompts or memories to shared planning and read-only peer answer calls",async()=>{
 const b=(await call("role:create",{name:"产品经理",intro:"依据公开约定答复",systemPrompt:"PEER_PRIVATE_DO_NOT_SHARE",preferredModel:fauxModelRef("b")})).id;
 core.memory.write({scopeType:"role",scopeId:a,title:"公开问题研究",content:"OWN_PRIVATE_MEMORY_74c1"});
 core.memory.write({scopeType:"role",scopeId:b,title:"公开问题约定",content:"PEER_PRIVATE_MEMORY_88f2"});
 const w=await call("workbench:create",{title:"公开协作",roleIds:[a,b]});let planning="",execution="",answer="";
 ensureFauxRegistered().setResponses([json({reply:"研究员执行",action:"dispatch",roleIds:[a],assignments:[{roleId:a,instructions:"向产品经理核对公开问题",files:["research.txt"],dependsOn:[]}]})]);
 ensureFauxRegistered("b").setResponses([ctx=>{answer=JSON.stringify(ctx);return fauxAssistantMessage("按公开约定收集问题，不改变接口。");}]);
 ensureFauxRegistered("a").setResponses([ctx=>{planning=JSON.stringify(ctx);return json({plan:"核对公开问题",contracts:[]});},ctx=>{execution=JSON.stringify(ctx);return fauxAssistantMessage([fauxToolCall("tool_search",{query:"workbench_notify",limit:1})]);},fauxAssistantMessage([fauxToolCall("workbench_notify",{roleId:b,purpose:"question",message:"请说明公开约定"})]),fauxAssistantMessage("已收到答复")]);
 await call("workbench:send",{id:w.id,text:"研究员核对公开问题",requestId:"question"});await settled(w.id);
 expect(planning).not.toContain("OWN_PRIVATE_MEMORY_74c1");expect(planning).not.toContain(secret);expect(planning).toContain("整理公开资料");expect(execution).toContain(secret);expect(execution).toContain("OWN_PRIVATE_MEMORY_74c1");expect(answer).not.toContain("PEER_PRIVATE_DO_NOT_SHARE");expect(answer).not.toContain("PEER_PRIVATE_MEMORY_88f2");expect(answer).toContain("依据公开约定答复");
});
it("projects legacy automatic raw results safely without replaying or deleting the private task transcript",async()=>{
 const w=await call("workbench:create",{title:"旧共享记录",roleIds:[a]});
 w.messages.push({id:"old",requestId:"old",sender:a,recipients:[],kind:"result",text:`旧原始回复 ${secret}`,at:1});
 core.db.prepare("UPDATE workbenches SET body=? WHERE id=?").run(JSON.stringify(w),w.id);
 expect(JSON.stringify(core.workbench.get(w.id).messages)).not.toContain(secret);
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});expect(JSON.stringify(core.workbench.get(w.id).messages)).not.toContain(secret);
 expect(core.db.prepare("SELECT id FROM tasks").all()).toHaveLength(0);
});
