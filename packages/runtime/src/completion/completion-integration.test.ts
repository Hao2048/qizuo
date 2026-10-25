import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {createHarnessCore,type HarnessCore} from "../core/harness-core.js";
import {ensureFauxRegistered,fauxModelRef} from "../pi/faux-provider.js";
let core:HarnessCore,dir:string,project:string,a:string,b:string;
async function call(name:string,input:unknown={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result;}
async function until(check:()=>any){for(let i=0;i<600;i++){const v=await check();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw Error("timeout");}
const json=(v:unknown)=>fauxAssistantMessage(JSON.stringify(v));
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-evidence-"));project=join(dir,"project");mkdirSync(project);core=await createHarnessCore({dataDir:dir,enableFaux:true});await call("settings:set",{defaultModel:fauxModelRef(),permissionMode:"bypass",autoApproveTools:[]});a=(await call("role:create",{name:"A",systemPrompt:"PRIVATE_A",preferredModel:fauxModelRef("a")})).id;b=(await call("role:create",{name:"B",systemPrompt:"PRIVATE_B",preferredModel:fauxModelRef("b")})).id;});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
async function applied(){
 const p=await call("project:add",{dir:project});const w=await call("workbench:create",{projectId:p.id,title:"证据",roleIds:[a,b]});
 ensureFauxRegistered().setResponses([json({reply:"仅 A 工作",action:"dispatch",roleIds:[a],assignments:[{roleId:a,instructions:"写入报告",files:["report.txt"],dependsOn:[],deliverables:[{path:"report.txt",format:"text",includes:["valid"]}]}]})]);
 ensureFauxRegistered("a").setResponses([json({plan:"生成报告",contracts:[]}),fauxAssistantMessage([fauxToolCall("write",{path:"report.txt",content:"valid report"})]),fauxAssistantMessage("完成")]);
 await call("workbench:send",{id:w.id,text:"制作报告",requestId:"q"});await until(()=>{const state=core.workbench.get(w.id);if(state.phase==="error")throw Error(state.messages.at(-1)?.text);if(["needs_roles","proposal","awaiting_confirmation"].includes(state.phase))throw Error(JSON.stringify(state.messages));return state.phase==="awaiting_review";});
 const review=await call("workbench:review",{id:w.id,roleId:a});await call("workbench:apply",{id:w.id,roleId:a,reviewToken:review.token});return core.workbench.get(w.id);
}
it("binds user acceptance to current artifact evidence, restores it without replay, and invalidates external edits",async()=>{
 const w=await applied();const before=core.db.prepare("SELECT body FROM workbenches WHERE id=?").get(w.id);
 const first=await call("completion:get",{scope:"workbench",id:w.id});expect(first.state).toBe("ready_for_acceptance");expect(first.evidence.find((e:any)=>e.kind==="artifact")).toMatchObject({kind:"artifact",status:"current",path:"report.txt",hash:expect.any(String)});
 expect(await call("completion:get",{scope:"workbench",id:w.id})).toMatchObject({token:first.token});expect(core.db.prepare("SELECT body FROM workbenches WHERE id=?").get(w.id)).toEqual(before);expect(JSON.stringify(first)).not.toMatch(/PRIVATE_A|PRIVATE_B/);
 await call("workbench:finish",{id:w.id,evidence:"已检查报告文字",memoryIds:[],completionToken:first.token});expect((await call("completion:get",{scope:"workbench",id:w.id})).state).toBe("accepted");
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});expect((await call("completion:get",{scope:"workbench",id:w.id})).state).toBe("accepted");
 writeFileSync(join(project,"report.txt"),"changed outside");const stale=await call("completion:get",{scope:"workbench",id:w.id});expect(stale.state).toBe("needs_attention");expect(stale.evidence.filter((e:any)=>["artifact","user_confirmation"].includes(e.kind)).every((e:any)=>e.status==="stale")).toBe(true);
 expect(readFileSync(join(project,"report.txt"),"utf8")).toBe("changed outside");
});
it("final gate rejects stale tokens and changed files even for older clients without a token",async()=>{
 const w=await applied(),r=await call("completion:get",{scope:"workbench",id:w.id});writeFileSync(join(project,"report.txt"),"tampered");
 await expect(call("workbench:finish",{id:w.id,evidence:"旧页面",memoryIds:[],completionToken:r.token})).rejects.toThrow("证据已变化");
 await expect(call("workbench:finish",{id:w.id,evidence:"跳过令牌",memoryIds:[]})).rejects.toThrow("交付证据");
 expect(core.workbench.get(w.id).phase).toBe("ready_verify");expect(core.workbench.get(w.id).acceptance).toBeUndefined();
});
it("does not substitute chat checks for workbench role evidence and isolates deleted reports",async()=>{
 const w=await applied();await expect(call("completion:get",{scope:"chat",id:w.participants[0]!.taskId})).rejects.toThrow("工作台");
 await call("workbench:delete",{id:w.id});await expect(call("completion:get",{scope:"workbench",id:w.id})).rejects.toThrow("不存在");
 const t=await call("task:create",{roleId:b});ensureFauxRegistered("b").setResponses([fauxAssistantMessage("正常问答")]);await call("task:prompt",{taskId:t.id,text:"你好"});await until(async()=>(await call("task:get",{taskId:t.id})).task.status==="done");
 expect((await call("completion:get",{scope:"chat",id:t.id})).state).toBe("reply_ended");
 await call("task:delete",{taskId:t.id});await expect(call("completion:get",{scope:"chat",id:t.id})).rejects.toThrow();
});

it("failed or stale real command receipts cannot be replaced by a manual success claim",async()=>{
 const w=await applied();
 await call("workbench:verify",{id:w.id,commands:["node -e 'process.exit(1)'"],network:false});await until(()=>core.workbench.get(w.id).verification?.status!=="running");
 const failed=await call("completion:get",{scope:"workbench",id:w.id});expect(failed.conditions.find((c:any)=>c.id==="verification").status).toBe("failed");
 await expect(call("workbench:finish",{id:w.id,evidence:"模型说完成了",memoryIds:[]})).rejects.toThrow("联调");
 await call("workbench:verify",{id:w.id,commands:["node -e 'process.exit(0)'"],network:false});await until(()=>core.workbench.get(w.id).verification?.status!=="running");
 const passed=await call("completion:get",{scope:"workbench",id:w.id});expect(passed.state).toBe("ready_for_acceptance");expect(passed.evidence.find((e:any)=>e.kind==="verification")).toMatchObject({status:"current",reference:expect.stringContaining("verification:")});
 writeFileSync(join(project,"unrelated.txt"),"new project version");const stale=await call("completion:get",{scope:"workbench",id:w.id});expect(stale.conditions.find((c:any)=>c.id==="verification").status).toBe("failed");
 await expect(call("workbench:finish",{id:w.id,evidence:"先前已通过",memoryIds:[]})).rejects.toThrow("成果已更新");
});

it("a changed contract or missing originating run blocks final confirmation",async()=>{
 const w=await applied(),p=w.participants.find((p:any)=>p.taskId);
 const updated=core.workbench.get(w.id);updated.contracts=[{id:"api",title:"接口约定",roles:[a],content:"版本已更新",version:2}];updated.revision++;
 core.db.prepare("UPDATE workbenches SET body=? WHERE id=?").run(JSON.stringify(updated),w.id);
 const changed=await call("completion:get",{scope:"workbench",id:w.id});expect(changed.conditions.find((c:any)=>c.id==="contracts").status).toBe("failed");
 await expect(call("workbench:finish",{id:w.id,evidence:"跳过版本",memoryIds:[]})).rejects.toThrow("共同约定");
 updated.contracts=[];core.db.prepare("UPDATE workbenches SET body=? WHERE id=?").run(JSON.stringify(updated),w.id);core.db.prepare("DELETE FROM workbench_runs WHERE task_id=?").run(p!.taskId);
 expect((await call("completion:get",{scope:"workbench",id:w.id})).state).toBe("needs_attention");
});

it("confirmation retains the exact checked version if an external process changes files before saving",async()=>{
 const w=await applied(),checked=core.workbench.completionReport(w.id);
 const spy=vi.spyOn(core.workbench,"completionReport").mockImplementationOnce(()=>{writeFileSync(join(project,"report.txt"),"external update between check and save");return checked;});
 try{await call("workbench:finish",{id:w.id,evidence:"只确认刚才检查的版本",memoryIds:[],completionToken:checked.token});}finally{spy.mockRestore();}
 expect(core.workbench.get(w.id).acceptance?.fingerprint).toBe(checked.fingerprint);
 const current=await call("completion:get",{scope:"workbench",id:w.id});expect(current.state).toBe("needs_attention");expect(current.evidence.find((e:any)=>e.kind==="user_confirmation").status).toBe("stale");
});
