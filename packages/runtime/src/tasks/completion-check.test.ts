import { expect, it } from "vitest";
import { CompletionCheck } from "./completion-check.js";
import type { AgentRun } from "@pi-harness/contracts";
const reply = (check: CompletionCheck, stopReason = "stop", text = "完成") => check.event({type:"message_end",message:{role:"assistant",stopReason,content:[{type:"text",text}]}});
const start = (check: CompletionCheck, id: string, args: unknown) => check.event({type:"tool_execution_start",toolCallId:id,toolName:"read",args});
const end = (check: CompletionCheck, id: string, isError: boolean) => check.event({type:"tool_execution_end",toolCallId:id,isError});
it("does not certify semantic task success and ignores earlier plans until touched or approved",()=>{
 const check = new CompletionCheck(false); reply(check);
 expect(check.finish([{content:"old",status:"pending"}],undefined,[])).toMatchObject({outcome:"reply_ended",issues:[]});
 check.planTouched=true;
 expect(check.finish([{content:"old",status:"pending"}],undefined,[]).issues[0]?.code).toBe("plan_pending");
});
it("an approved execution that never updates its plan still requires review",()=>{
 const check = new CompletionCheck(true); reply(check);
 expect(check.finish([{content:"approved",status:"pending"}],{revision:"r",requiresApproval:true,status:"approved"},[]).issues[0]?.code).toBe("plan_pending");
 expect(check.finish([{content:"approved",status:"pending"}],{revision:"r",requiresApproval:true,status:"draft"},[]).issues[0]?.code).toBe("plan_approval");
});
it("only a successful identical operation resolves a failure, without leaking arguments",()=>{
 const check = new CompletionCheck(false); start(check,"1",{path:"secret",options:{a:1,b:2}}); end(check,"1",true);
 start(check,"2",{path:"other"});end(check,"2",false);reply(check);
 const receipt=check.finish([],undefined,[]);expect(receipt.issues[0]?.code).toBe("tool_failed");expect(JSON.stringify(receipt)).not.toMatch(/secret|other/);
 start(check,"3",{options:{b:2,a:1},path:"secret"});end(check,"3",false);reply(check);
 expect(check.finish([],undefined,[]).issues).toEqual([]);
});
it("a later failure is not cleared by an earlier success",()=>{
 const check=new CompletionCheck(false);start(check,"1",{path:"a"});end(check,"1",false);start(check,"2",{path:"a"});end(check,"2",true);reply(check);
 expect(check.finish([],undefined,[]).issues[0]?.code).toBe("tool_failed");
});
it("detects truncated, empty and unfinished tool replies instead of accepting tool-only output",()=>{
 for(const reason of ["length","aborted","error","toolUse"]){const check=new CompletionCheck(false);reply(check,reason);expect(check.finish([],undefined,[]).issues[0]?.code).toBe("response_incomplete");}
 const check=new CompletionCheck(false);reply(check,"stop","");expect(check.finish([],undefined,[]).outcome).toBe("needs_attention");
 start(check,"pending",{path:"a"});reply(check);expect(check.finish([],undefined,[]).issues.map(i=>i.code)).toEqual(["tool_pending"]);
});
it("checks only new child tasks, and never borrows another invocation's state",()=>{
 const child={id:"old",status:"error"} as AgentRun;
 const check=new CompletionCheck(false,["old"]);reply(check);
 expect(check.finish([],undefined,[child]).outcome).toBe("reply_ended");
 expect(check.finish([],undefined,[child,{...child,id:"new",status:"running"}]).issues[0]?.code).toBe("agent_unresolved");
 const other=new CompletionCheck(false);reply(other);expect(other.finish([],undefined,[]).issues).toEqual([]);
});
