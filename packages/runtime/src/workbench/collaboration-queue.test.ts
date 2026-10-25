import { expect, it } from "vitest";
import type { Workbench } from "@pi-harness/contracts";
import { enqueueNotification } from "./notifications.js";
import { nextCollaboration, collaborationBlock, interruptCollaborations, SerialConsultations } from "./collaboration-queue.js";
const state=():Workbench=>({id:"w",title:"协作",projectId:null,phase:"running",revision:1,
  participants:["a","b","c"].map(roleId=>({roleId,name:roleId,enabled:true,status:"idle",taskId:null,responsibility:""})),
  messages:[],contracts:[],proposals:[],recommendations:[],createdAt:1,updatedAt:1});
it("信息不进入自动队列；只处理当前人类请求，旧通知不被新一轮重放",()=>{
  const w=state();
  enqueueNotification(w,{taskId:"ta",toolCallId:"info",requestId:"q",sender:"a",roleId:"b",message:"信息"});
  const old=enqueueNotification(w,{taskId:"ta",toolCallId:"old",requestId:"old",sender:"a",roleId:"b",message:"旧协作",purpose:"collaboration"});
  const current=enqueueNotification(w,{taskId:"ta",toolCallId:"current",requestId:"q",sender:"a",roleId:"b",message:"交付就绪",purpose:"delivery"});
  expect(nextCollaboration(w,"q")?.id).toBe(current.id);expect(nextCollaboration(w,"q")?.id).not.toBe(old.id);
});
it("消息用途参与重试去重，不能用同一工具调用偷偷升级普通消息为可执行请求",()=>{
  const w=state(),input={taskId:"ta",toolCallId:"call",requestId:"q",sender:"a",roleId:"b",message:"相同正文"};
  enqueueNotification(w,input);
  expect(()=>enqueueNotification(w,{...input,purpose:"collaboration"})).toThrow("标识");
  expect(enqueueNotification(w,{...input,toolCallId:"next",purpose:"collaboration"}).notification?.automatic?.state).toBe("queued");
});
it("宿主派生协作因果链，三角色回路停止自动唤醒；私有执行记录不进消息",()=>{
  const w=state();const first=enqueueNotification(w,{taskId:"ta",toolCallId:"ab",requestId:"q",sender:"a",roleId:"b",message:"AB",purpose:"collaboration"});
  first.notification!.automatic={state:"completed",taskId:"tb",roleChain:["a","b"]};
  const second=enqueueNotification(w,{taskId:"tb",toolCallId:"bc",requestId:"q",sender:"b",roleId:"c",message:"BC",purpose:"collaboration"});
  second.notification!.automatic={state:"completed",taskId:"tc",roleChain:["a","b","c"]};
  const loop=enqueueNotification(w,{taskId:"tc",toolCallId:"ca",requestId:"q",sender:"c",roleId:"a",message:"CA",purpose:"collaboration"});
  expect(loop.notification?.automatic).toMatchObject({state:"blocked",roleChain:["a","b","c"]});
  expect(nextCollaboration(w,"q")).toBeUndefined();
});
it("暂停、未分工、待裁决分别阻塞，不因消息扩大职责",()=>{
  const w=state(),m=enqueueNotification(w,{taskId:"ta",toolCallId:"ab",requestId:"q",sender:"a",roleId:"b",message:"处理",purpose:"collaboration"});
  expect(collaborationBlock(w,m,new Set(["a"]))).toContain("未获本轮分工");
  w.participants[1]!.enabled=false;expect(collaborationBlock(w,m,new Set(["a","b"]))).toContain("暂停");
  w.participants[1]!.enabled=true;w.proposals.push({id:"p",contractId:"c",roleId:"a",baseVersion:1,content:"变更",reason:"接口",status:"pending"});
  expect(collaborationBlock(w,m,new Set(["a","b"]))).toContain("接口变更");
});
it("中断只冻结待执行请求，保留已处理回执和旧消息并清理等待提示",()=>{
  const w=state();const m=enqueueNotification(w,{taskId:"ta",toolCallId:"ab",requestId:"q",sender:"a",roleId:"b",message:"处理",purpose:"collaboration"});
  w.participants[0]!.collaborationWait="等待答复";interruptCollaborations(w,"程序已退出");
  expect(m.notification?.automatic).toMatchObject({state:"interrupted",reason:"程序已退出"});
  expect(m.notification?.status).toBe("pending");expect(w.participants[0]?.collaborationWait).toBeUndefined();
});
it("同一执行席位的多个问题串行，其他席位可继续；前一问题失败不会堵住后续清理",async()=>{
  const queue=new SerialConsultations(),events:string[]=[];
  let release!:()=>void;
  const gate=new Promise<void>(r=>{release=r;});
  const first=queue.run("ta",async()=>{events.push("first");await gate;throw Error("问答失败");});
  const failed=expect(first).rejects.toThrow("问答失败");
  const second=queue.run("ta",async()=>{events.push("second");return "继续";});
  await queue.run("tb",async()=>{events.push("other");});
  expect(events).toEqual(["first","other"]);
  release();await failed;expect(await second).toBe("继续");expect(events).toEqual(["first","other","second"]);
  expect(await queue.run("ta",async()=>"再次提问")).toBe("再次提问");
});
