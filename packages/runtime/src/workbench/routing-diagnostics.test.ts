import {afterEach,beforeEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {createHarnessCore,type HarnessCore} from "../core/harness-core.js";
import {ensureFauxRegistered,fauxModelRef} from "../pi/faux-provider.js";
let core:HarnessCore,dir:string,roleId:string;
async function call(name:string,input:unknown={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result;}
async function failed(id:string){for(let i=0;i<200;i++){const w=core.workbench.get(id);if(w.phase==="error")return w;await new Promise(r=>setTimeout(r,5));}throw Error("timeout");}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-route-diagnostic-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});await call("settings:set",{defaultModel:fauxModelRef(),permissionMode:"bypass",autoApproveTools:[]});roleId=(await call("role:create",{name:"产品经理",preferredModel:fauxModelRef("a")})).id;});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
it("names the invalid routing field without exposing model content or starting a worker",async()=>{
 const w=await call("workbench:create",{title:"PRD修改",roleIds:[roleId]});let requests=0;
 ensureFauxRegistered().setResponses([()=>{requests++;return fauxAssistantMessage(JSON.stringify({reply:"PRIVATE_ROUTE_CONTENT",action:"dispatch",roleIds:[roleId],assignments:[{roleId,instructions:"PRIVATE_INSTRUCTIONS",files:["delivery/PRD.md"]}]}));}]);
 await call("workbench:send",{id:w.id,text:"修改PRD",requestId:"invalid-schema"});const result=await failed(w.id),message=result.messages.at(-1)!.text;
 expect(message).toContain("无效分配");expect(message).toContain("/assignments/0");expect(message).toContain("dependsOn");expect(message).not.toMatch(/PRIVATE_ROUTE_CONTENT|PRIVATE_INSTRUCTIONS/);
 expect(result.participants[0]!.taskId).toBeNull();expect(core.db.prepare("SELECT id FROM tasks").all()).toHaveLength(0);expect(requests).toBe(1);
});
it("does not echo invalid JSON through the engine's parser error",async()=>{
 const w=await call("workbench:create",{title:"JSON诊断",roleIds:[roleId]});ensureFauxRegistered().setResponses([fauxAssistantMessage("PRIVATE_JSON_CANARY: malformed provider output")]);
 await call("workbench:send",{id:w.id,text:"修改PRD",requestId:"invalid-json"});const result=await failed(w.id);expect(result.messages.at(-1)!.text).toContain("JSON");expect(result.messages.at(-1)!.text).not.toContain("PRIVATE_JSON_CANARY");expect(result.participants[0]!.taskId).toBeNull();
});

it("does not display arbitrary schema keys or rejected values in diagnostic hints",async()=>{
 const {routingDiagnostic}=await import("./routing-diagnostic.js");
 expect(routingDiagnostic('/assignments/0/deliverables/1/format: must be equal to constant PRIVATE_VALUE')).toBe('字段 /assignments/0/deliverables/1/format 的格式不符合分工约定');
 expect(routingDiagnostic('/assignments/PRIVATE_KEY: must have required properties PRIVATE_FIELD')).toBe('字段 / 的格式不符合分工约定');
 expect(routingDiagnostic('/assignments/0: must have required properties dependsOn, files')).toContain('dependsOn、files');
});

it("names the responsible planner and artifact when format-specific conditions are invalid",async()=>{
 const w=await call("workbench:create",{title:"PRD交付格式",roleIds:[roleId]});
 ensureFauxRegistered().setResponses([fauxAssistantMessage(JSON.stringify({reply:"只改产品文档",action:"dispatch",roleIds:[roleId],assignments:[{roleId,instructions:"写JSON",files:["delivery/result.json"],dependsOn:[]}]}))]);
 ensureFauxRegistered("a").setResponses([fauxAssistantMessage(JSON.stringify({plan:"交付结构",contracts:[],deliverables:[{path:"delivery/result.json",format:"json",includes:["mode"]}]}))]);
 await call("workbench:send",{id:w.id,text:"更新PRD数据",requestId:"invalid-plan"});const result=await failed(w.id);
 expect(result.messages.at(-1)!.text).toContain("产品经理");expect(result.messages.at(-1)!.text).toContain("规划");expect(result.messages.at(-1)!.text).toContain("delivery/result.json");expect(result.participants[0]!.taskId).toBeNull();
});

it("repairs malformed routing JSON once without running tools or exposing rejected content",async()=>{
 const w=await call('workbench:create',{title:'修正路由',roleIds:[roleId]});
 ensureFauxRegistered().setResponses([fauxAssistantMessage('PRIVATE_MALFORMED_OUTPUT'),fauxAssistantMessage(JSON.stringify({reply:'只讨论',action:'clarify',roleIds:[],assignments:[]}))]);
 await call('workbench:send',{id:w.id,text:'请先讨论方案',requestId:'repair'});
 let result=core.workbench.get(w.id);
 for(let i=0;i<200&&['routing','planning'].includes(result.phase);i++){await new Promise(r=>setTimeout(r,5));result=core.workbench.get(w.id);}
 expect(result.phase).toBe('clarify');expect(result.messages.at(-1)!.text).toBe('只讨论');
 expect(JSON.stringify(result.messages)).not.toContain('PRIVATE_MALFORMED_OUTPUT');
 expect(result.participants[0]!.taskId).toBeNull();
});

it("still rejects a repaired decision that dispatches a role outside the task",async()=>{
 const other=(await call('role:create',{name:'无关角色',preferredModel:fauxModelRef('other')})).id;
 const w=await call('workbench:create',{title:'隔离',roleIds:[roleId]});
 ensureFauxRegistered().setResponses([fauxAssistantMessage('broken'),fauxAssistantMessage(JSON.stringify({reply:'执行',action:'dispatch',roleIds:[other],assignments:[{roleId:other,instructions:'工作',files:['result.txt'],dependsOn:[]}]}))]);
 await call('workbench:send',{id:w.id,text:'修改文档',requestId:'outside'});
 const result=await failed(w.id);expect(result.messages.at(-1)!.text).toContain('角色已归档或不存在');
 expect(core.db.prepare('SELECT id FROM tasks').all()).toHaveLength(0);
});
