import {createHash} from "node:crypto";
import type {CompletionReport,TaskInfo,Workbench} from "@pi-harness/contracts";
type Condition=CompletionReport["conditions"][number];
type Evidence=CompletionReport["evidence"][number];
export function report(scope:CompletionReport["scope"],id:string,state:CompletionReport["state"],conditions:Condition[],evidence:Evidence[],version:unknown):CompletionReport {
 return {scope,id,state,conditions,evidence,assessedAt:Date.now(),token:createHash("sha256").update(JSON.stringify({scope,id,state,conditions,evidence,version})).digest("hex")};
}
export function chatCompletion(task:TaskInfo):CompletionReport {
 const receipt=task.completion;
 const busy=["running","waiting_approval","waiting_user","waiting_recommend"].includes(task.status);
 const conditions:Condition[]=[{id:"execution",label:"本轮模型运行已结束",status:task.status==="done"&&receipt ? "passed" : ["error","cancelled"].includes(task.status)?"failed":"pending",evidenceIds:receipt?["receipt"]:[]}];
 const evidence:Evidence[]=receipt?[{id:"receipt",kind:"execution",summary:"本轮 SDK 执行记录检查；不等同于成果验收。",status:"current",at:receipt.checkedAt,taskId:task.id,reference:"completion_check"}]:[];
 for(const issue of receipt?.issues??[])conditions.push({id:issue.code,label:issue.message,status:issue.code==="plan_approval"?"pending":"failed",evidenceIds:["receipt"]});
 conditions.push({id:"acceptance",label:"业务效果或审美验收需另行确认，普通问答不自动宣称交付",status:"not_applicable",evidenceIds:[]});
 return report("chat",task.id,busy?"in_progress":task.status==="done"&&receipt?.outcome==="reply_ended"?"reply_ended":"needs_attention",conditions,evidence,[task.updatedAt,task.status,receipt]);
}

/** Pure projection of existing host facts. Missing legacy evidence never becomes a pass. */
export function workbenchCompletion(w:Workbench, input:{fingerprint:string;files:Record<string,string>;readable:boolean;contractsCurrent:boolean;busy:boolean}):CompletionReport {
 const conditions:Condition[]=[],evidence:Evidence[]=[];
 const add=(id:string,label:string,status:Condition["status"],evidenceIds:string[]=[])=>conditions.push({id,label,status,evidenceIds});
 const participants=w.participants.filter(p=>p.taskId);
 const executionIds=participants.map(p=>{const id="execution:"+p.roleId;evidence.push({id,kind:"execution",summary:`${p.name}：${p.status}`,status:["applied","done","awaiting_review"].includes(p.status)?"current":"unverified",taskId:p.taskId!,roleId:p.roleId});return id;});
 const executed=participants.length>0&&participants.every(p=>["applied","done","awaiting_review"].includes(p.status));
 add("execution","必要角色执行结束（暂停不豁免已有任务）",executed&&!input.busy?"passed":["error","stopped"].includes(w.phase)?"failed":"pending",executionIds);
 add("application","所有已有成果已审阅并应用",participants.length>0&&participants.every(p=>p.status==="applied")?"passed":"pending",executionIds);
 const requestId=w.roundProgress?.requestId;
 const unresolved=w.messages.filter(m=>m.notification&&m.requestId===requestId&&m.notification.purpose&&m.notification.purpose!=="information"&&(m.notification.status!=="handled"||["queued","running","blocked","interrupted"].includes(m.notification.automatic?.state??"")));
 const collaborationIds=unresolved.map(m=>{const id="collaboration:"+m.id;evidence.push({id,kind:"execution",summary:"本轮协作请求尚未确认处理",status:"unverified",at:m.at,reference:m.id});return id;});
 add("collaboration","本轮需要处理的协作请求已闭环",unresolved.length?"pending":"passed",collaborationIds);
 const contractIds=w.contracts.map(c=>{const id="contract:"+c.id;evidence.push({id,kind:"contract",summary:`${c.title} · 版本 ${c.version}`,status:input.contractsCurrent?"current":"stale",reference:c.id});return id;});
 add("contracts","共同约定无待决提案，成果对应当前版本",w.proposals.some(p=>p.status==="pending")?"pending":input.contractsCurrent?"passed":"failed",contractIds);
 let artifactFailed=!input.readable,checked=0;const artifactIds:string[]=[];
 for(const p of participants){
  const check=p.deliveryCheck;
  if(!check){if(p.deliverables?.length)artifactFailed=true;continue;}
  checked++;
  if(check.status!=="passed"||!check.files.length)artifactFailed=true;
  for(const f of check.files){const current=check.status==="passed"&&input.readable&&input.files[f.path]===f.hash;const id=`artifact:${p.roleId}:${f.path}`;artifactIds.push(id);if(!current)artifactFailed=true;
   evidence.push({id,kind:"artifact",summary:`${p.name} · ${f.path}`,path:f.path,hash:f.hash,roleId:p.roleId,taskId:p.taskId!,at:check.at,status:current?"current":"stale"});}
 }
 add("delivery",!input.readable?"无法读取当前项目成果":checked?"已声明交付检查通过且项目文件与证据哈希一致":"旧成果未记录自动交付检查，请人工核对",artifactFailed?"failed":checked?"passed":"not_applicable",artifactIds);
 const v=w.verification;const verificationIds:string[]=[];
 const verified=!!v&&v.status==="passed"&&v.fingerprint===input.fingerprint&&v.steps.length>0&&v.steps.every(s=>s.code===0&&!s.cancelled);
 for(const [i,s] of (v?.steps??[]).entries()){const id="verification:"+i;verificationIds.push(id);evidence.push({id,kind:"verification",summary:`联调步骤 ${i+1} · ${s.cancelled?"已取消":`退出码 ${s.code??"未知"}`}`,at:v!.at,status:verified?"current":"stale",reference:`verification:${v!.at}:${i}`});}
 add("verification",v?"已选联调步骤通过且适用于当前项目版本":"未执行自动联调，仍需人工检查业务效果",!v?"not_applicable":verified?"passed":v.status==="running"?"pending":"failed",verificationIds);
 const technical=conditions.every(c=>["passed","not_applicable"].includes(c.status));
 const accepted=w.phase==="done"&&!!w.acceptance&&w.acceptance.fingerprint===input.fingerprint&&technical;
 if(w.acceptance)evidence.push({id:"acceptance",kind:"user_confirmation",summary:w.acceptance.note,at:w.acceptance.at,status:accepted?"current":"stale",reference:"acceptance"});
 add("acceptance",w.phase==="done"&&!w.acceptance?"旧验收未绑定成果版本，保留历史记录供核对":"用户确认业务效果与交付结果",accepted?"passed":"pending",w.acceptance?["acceptance"]:[]);
 const state=input.busy?"in_progress":accepted?"accepted":technical&&w.phase==="ready_verify"?"ready_for_acceptance":"needs_attention";
 return {...report("workbench",w.id,state,conditions,evidence,[w.revision,input.fingerprint]),fingerprint:input.fingerprint};
}
