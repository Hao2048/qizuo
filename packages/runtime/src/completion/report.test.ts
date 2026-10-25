import {expect,it} from "vitest";
import type {Workbench,TaskInfo} from "@pi-harness/contracts";
import {chatCompletion,workbenchCompletion} from "./report.js";
const base=():Workbench=>({id:"w",title:"任务",projectId:null,phase:"ready_verify",revision:3,participants:[{roleId:"a",name:"A",enabled:true,status:"applied",taskId:"ta",responsibility:"a",deliveryCheck:{status:"passed",at:1,issues:[],files:[{path:"page.txt",hash:"hash"}]}}],messages:[],contracts:[],proposals:[],recommendations:[],createdAt:1,updatedAt:1});
const facts={fingerprint:"fp",files:{"page.txt":"hash"},readable:true,contractsCurrent:true,busy:false};
it("role completion and hash checks do not impersonate manual acceptance",()=>{
 const w=base();const r=workbenchCompletion(w,facts);expect(r.state).toBe("ready_for_acceptance");expect(r.conditions.find(c=>c.id==="acceptance")?.status).toBe("pending");
 w.phase="done";expect(workbenchCompletion(w,facts).state).toBe("needs_attention");
 w.acceptance={fingerprint:"fp",at:2,note:"已检查业务效果"};expect(workbenchCompletion(w,facts).state).toBe("accepted");
 expect(workbenchCompletion(w,{...facts,fingerprint:"other"}).evidence.find(e=>e.id==="acceptance")?.status).toBe("stale");
});
it("file changes, missing evidence and unreadable roots cannot pass declared delivery",()=>{
 const w=base();for(const f of [{...facts,files:{} as Record<string,string>},{...facts,files:{"page.txt":"changed"}},{...facts,readable:false}])expect(workbenchCompletion(w,f).state).toBe("needs_attention");
 delete w.participants[0]!.deliveryCheck;w.participants[0]!.deliverables=[{path:"page.txt",format:"file"}];expect(workbenchCompletion(w,facts).conditions.find(c=>c.id==="delivery")?.status).toBe("failed");
 delete w.participants[0]!.deliverables;expect(workbenchCompletion(w,facts).conditions.find(c=>c.id==="delivery")?.status).toBe("not_applicable");
});
it("failed or empty verification and changed contracts cannot be accepted",()=>{
 const w=base();w.verification={status:"passed",fingerprint:"fp",at:2,steps:[]};expect(workbenchCompletion(w,facts).state).toBe("needs_attention");
 w.verification.steps=[{command:"private command",code:0,output:"PRIVATE_LOG",durationMs:1,cancelled:false}];const good=workbenchCompletion(w,facts);expect(good.state).toBe("ready_for_acceptance");expect(JSON.stringify(good)).not.toMatch(/private command|PRIVATE_LOG/);
 expect(workbenchCompletion(w,{...facts,fingerprint:"other"}).state).toBe("needs_attention");
 expect(workbenchCompletion(w,{...facts,contractsCurrent:false}).state).toBe("needs_attention");
 w.verification.steps[0]!.cancelled=true;expect(workbenchCompletion(w,facts).state).toBe("needs_attention");
});
it("pausing a necessary unfinished role and leaving collaboration unanswered cannot be hidden",()=>{
 const w=base();w.participants[0]!.enabled=false;w.participants[0]!.status="interrupted";expect(workbenchCompletion(w,facts).state).toBe("needs_attention");
 w.participants[0]!.status="applied";w.roundProgress={requestId:"q",roles:[]};w.messages=[{id:"note",requestId:"q",sender:"b",recipients:["a"],kind:"handoff",text:"PRIVATE_MESSAGE",at:1,notification:{sourceTaskId:"tb",sourceToolCallId:"call",status:"delivered",purpose:"question"}}];
 const blocked=workbenchCompletion(w,facts);expect(blocked.state).toBe("needs_attention");expect(JSON.stringify(blocked)).not.toContain("PRIVATE_MESSAGE");
 w.messages[0]!.notification!.purpose="information";expect(workbenchCompletion(w,facts).state).toBe("ready_for_acceptance");
 w.messages[0]!.notification!.purpose="question";w.messages[0]!.requestId="old";expect(workbenchCompletion(w,facts).state).toBe("ready_for_acceptance");
});
it("chat facts remain reply receipts, and deterministic tokens ignore viewing time",()=>{
 const task={id:"t",updatedAt:1,status:"done",completion:{checkedAt:1,outcome:"reply_ended",issues:[]}} as unknown as TaskInfo;
 const a=chatCompletion(task),b=chatCompletion(task);expect(a.state).toBe("reply_ended");expect(a.token).toBe(b.token);expect(a.conditions.find(c=>c.id==="acceptance")?.status).toBe("not_applicable");
 task.completion=null;expect(chatCompletion(task).state).toBe("needs_attention");task.status="cancelled";expect(chatCompletion(task).conditions[0]?.status).toBe("failed");
});
