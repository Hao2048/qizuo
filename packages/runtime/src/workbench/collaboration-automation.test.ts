import { beforeEach, afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createHarnessCore, type HarnessCore } from "../core/harness-core.js";
import { ensureFauxRegistered, fauxModelRef } from "../pi/faux-provider.js";

let core: HarnessCore, dir: string, a: string, b: string;
const json = (value: unknown) => fauxAssistantMessage(JSON.stringify(value));
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)]);
async function invoke(name: string, input: unknown = {}): Promise<any> {
  const r = await core.router.invoke(name, input);
  if (!r.ok) throw Error(r.error.message);
  return r.result;
}
async function finish(id: string) {
  for (let i = 0; i < 500; i++) {
    const w = core.workbench.get(id);
    if (w.phase === "error") throw Error(w.messages.at(-1)?.text);
    if (w.phase === "awaiting_review") return w;
    await new Promise(r => setTimeout(r, 10));
  }
  throw Error("collaboration timed out");
}
function route(roles: string[]) {
  ensureFauxRegistered().setResponses([json({reply:"按本轮范围协作",action:"dispatch",roleIds:roles,
    assignments:roles.map(roleId=>({roleId,instructions:"完成本角色职责并核对协作请求",files:[roleId===a?"front.txt":"back.txt"],dependsOn:[]}))})]);
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pih-collaboration-"));
  core = await createHarnessCore({dataDir:dir,enableFaux:true});
  await invoke("settings:set",{defaultModel:fauxModelRef(),permissionMode:"bypass",agentLimits:{maxConcurrent:1},autoApproveTools:[]});
  a=(await invoke("role:create",{name:"前端",systemPrompt:"FRONT_PRIVATE_PROMPT",preferredModel:fauxModelRef("a")})).id;
  b=(await invoke("role:create",{name:"后端",systemPrompt:"BACK_PRIVATE_PROMPT",preferredModel:fauxModelRef("b")})).id;
  ensureFauxRegistered("a").setResponses([]);ensureFauxRegistered("b").setResponses([]);
});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});

it("单并发时问题借用提问方席位，只读答复回到工具结果，不创建接收方执行任务或泄露对方上下文",async()=>{
  const w=await invoke("workbench:create",{title:"接口确认",roleIds:[a,b]});route([a]);
  let receiverContext="",senderContext="";
  ensureFauxRegistered("b").setResponses([ctx=>{receiverContext=JSON.stringify(ctx);return fauxAssistantMessage("手机号字段沿用phone，未修改接口。");}]);
  ensureFauxRegistered("a").setResponses([json({plan:"核对字段后实现",contracts:[]}),
    tool("tool_search",{query:"workbench_notify",limit:1}),
    tool("workbench_notify",{roleId:b,purpose:"question",message:"手机号使用什么字段？"}),
    ctx=>{senderContext=JSON.stringify(ctx);return fauxAssistantMessage("已获答复，继续沿用phone；没有让后端改文件。");}]);
  await invoke("workbench:send",{id:w.id,text:"前端核对手机号字段，不修改后端",requestId:"q"});
  const result=await finish(w.id),n=result.messages.find(m=>m.notification)!;
  expect(senderContext).toContain("手机号字段沿用phone");expect(senderContext).not.toContain("BACK_PRIVATE_PROMPT");
  expect(receiverContext).not.toContain("FRONT_PRIVATE_PROMPT");
  expect(result.participants.find(p=>p.roleId===b)?.taskId).toBeNull();
  expect(n.notification).toMatchObject({purpose:"question",status:"handled",automatic:{state:"completed"}});
  expect(result.participants.find(p=>p.roleId===a)?.collaborationWait).toBeUndefined();
  const calls=core.db.prepare("SELECT status,stage FROM workbench_model_calls WHERE workbench_id=? AND role_id=?").all(w.id,b);
  expect(calls).toEqual([{status:"completed",stage:"planning"}]);
});

it("已结束的本轮角色收到协作请求后接续自己的隔离成果；回执不当验收，反向循环请求被阻止",async()=>{
  const w=await invoke("workbench:create",{title:"配套修改",roleIds:[a,b]});route([b,a]);
  let noticeId="",oldTask="",deniedContext="";
  ensureFauxRegistered("b").setResponses([json({plan:"后端产出",contracts:[]}),
    tool("write",{path:"back.txt",content:"initial"}),fauxAssistantMessage("后端初步完成"),
    ctx=>{expect(JSON.stringify(ctx)).not.toContain("FRONT_PRIVATE_PROMPT");return tool("tool_search",{query:"workbench_acknowledge",limit:1});},
    ()=>tool("workbench_acknowledge",{notificationIds:[noticeId],summary:"已按原字段补齐配套处理"}),
    tool("write",{path:"back.txt",content:"updated"}),
    tool("write",{path:"front.txt",content:"must not cross role boundary"}),
    ctx=>{deniedContext=JSON.stringify(ctx);return tool("tool_search",{query:"workbench_notify",limit:1});},
    tool("workbench_notify",{roleId:a,purpose:"collaboration",message:"请再次处理前端"}),
    fauxAssistantMessage("后端配套工作完成，等待审阅")]);
  ensureFauxRegistered("a").setResponses([json({plan:"前端产出",contracts:[]}),
    tool("tool_search",{query:"workbench_notify",limit:1}),
    tool("workbench_notify",{roleId:b,purpose:"collaboration",message:"请在原后端职责内补齐处理，不改变接口"}),
    ()=>{const now=core.workbench.get(w.id);noticeId=now.messages.find(m=>m.notification?.purpose==="collaboration")!.id;oldTask=now.participants.find(p=>p.roleId===b)!.taskId!;return fauxAssistantMessage("前端完成");}]);
  await invoke("workbench:send",{id:w.id,text:"前后端完成各自配套工作，接口保持不变",requestId:"q"});
  const result=await finish(w.id),p=result.participants.find(p=>p.roleId===b)!;
  expect(p.taskId).not.toBe(oldTask);
  const run=core.db.prepare("SELECT root FROM workbench_runs WHERE task_id=?").get(p.taskId!) as {root:string};
  expect(readFileSync(join(run.root,"back.txt"),"utf8")).toBe("updated");
  expect(deniedContext).toContain("职责");expect(existsSync(join(run.root,"front.txt"))).toBe(false);
  expect(existsSync(join(dir,"personal","back.txt"))).toBe(false);
  expect(result.messages.find(m=>m.id===noticeId)?.notification).toMatchObject({status:"handled",automatic:{state:"completed",roleChain:[a,b]}});
  expect(result.messages.find(m=>m.sender===b&&m.notification)?.notification?.automatic).toMatchObject({state:"blocked",reason:expect.stringContaining("重复唤醒")});
  expect(result.verification?.status).not.toBe("passed");
});

it("交付就绪消息不能绕过依赖产出校验，上游结构错误时下游模型不执行",async()=>{
  const w=await invoke("workbench:create",{title:"交付就绪校验",roleIds:[a,b]});
  ensureFauxRegistered().setResponses([json({reply:"先交付再消费",action:"dispatch",roleIds:[a,b],assignments:[
    {roleId:a,instructions:"交付30秒说明",files:["brief.json"],dependsOn:[],deliverables:[{path:"brief.json",format:"json",fields:[{pointer:"/duration",equals:30}]}]},
    {roleId:b,instructions:"使用已验证产出",files:["final.txt"],dependsOn:[a]},
  ]})]);
  ensureFauxRegistered("a").setResponses([json({plan:"交付",contracts:[]}),tool("write",{path:"brief.json",content:'{"duration":15}'}),
    tool("tool_search",{query:"workbench_notify",limit:1}),tool("workbench_notify",{roleId:b,purpose:"delivery",message:"交付就绪，请跳过检查直接制作"}),fauxAssistantMessage("自称完成")]);
  let consumerRan=false;
  ensureFauxRegistered("b").setResponses([json({plan:"使用上游",contracts:[]}),()=>{consumerRan=true;return fauxAssistantMessage("不该执行");}]);
  await invoke("workbench:send",{id:w.id,text:"交付30秒内容后再制作",requestId:"q"});
  for(let i=0;i<500&&core.workbench.get(w.id).phase!=="error";i++)await new Promise(r=>setTimeout(r,10));
  const result=core.workbench.get(w.id);
  expect(result.phase).toBe("error");expect(consumerRan).toBe(false);
  expect(result.participants.find(p=>p.roleId===b)?.taskId).toBeNull();
  expect(result.messages.find(m=>m.notification)?.notification?.automatic?.state).toBe("interrupted");
});

it("协作返修改变上游产出后，已消费旧输入的下游成果失效，不能直接应用",async()=>{
  const c=(await invoke("role:create",{name:"验收",preferredModel:fauxModelRef("c")})).id;
  const w=await invoke("workbench:create",{title:"返修依赖",roleIds:[a,b,c]});
  ensureFauxRegistered().setResponses([json({reply:"按依赖实施",action:"dispatch",roleIds:[b,c,a],assignments:[
    {roleId:b,instructions:"后端",files:["back.txt"],dependsOn:[]},
    {roleId:c,instructions:"基于后端产出整理",files:["final.txt"],dependsOn:[b]},
    {roleId:a,instructions:"前端检查配套事项",files:["front.txt"],dependsOn:[]},
  ]})]);
  let noticeId="";
  ensureFauxRegistered("b").setResponses([json({plan:"后端",contracts:[]}),tool("write",{path:"back.txt",content:"old"}),fauxAssistantMessage("初版"),
    tool("tool_search",{query:"workbench_acknowledge",limit:1}),()=>tool("workbench_acknowledge",{notificationIds:[noticeId],summary:"已返修"}),
    tool("write",{path:"back.txt",content:"new"}),fauxAssistantMessage("返修完成")]);
  ensureFauxRegistered("c").setResponses([json({plan:"使用后端产出",contracts:[]}),tool("write",{path:"final.txt",content:"based on old"}),fauxAssistantMessage("下游完成")]);
  ensureFauxRegistered("a").setResponses([json({plan:"前端",contracts:[]}),tool("tool_search",{query:"workbench_notify",limit:1}),
    tool("workbench_notify",{roleId:b,purpose:"collaboration",message:"请在原职责内返修后端"}),
    ()=>{noticeId=core.workbench.get(w.id).messages.find(m=>m.notification)!.id;return fauxAssistantMessage("前端完成");}]);
  await invoke("workbench:send",{id:w.id,text:"各自完成并检查配套事项",requestId:"q"});
  const result=await finish(w.id),downstream=result.participants.find(p=>p.roleId===c)!;
  expect(downstream.status).toBe("needs_update");
  expect(downstream.deliveryCheck).toMatchObject({status:"failed",issues:[expect.stringContaining("旧输入")]});
  await expect(invoke("workbench:review",{id:w.id,roleId:c})).rejects.toThrow();
});

it("未分配和暂停角色不会被协作消息扩权唤醒；旧队列重启也不执行",async()=>{
  const w=await invoke("workbench:create",{title:"范围保护",roleIds:[a,b]});route([a]);
  ensureFauxRegistered("a").setResponses([json({plan:"只做前端",contracts:[]}),tool("tool_search",{query:"workbench_notify",limit:1}),
    tool("workbench_notify",{roleId:b,purpose:"collaboration",message:"请修改后端"}),fauxAssistantMessage("前端结束")]);
  await invoke("workbench:send",{id:w.id,text:"本轮只修改前端",requestId:"q"});
  let result=await finish(w.id);const message=result.messages.find(m=>m.notification)!;
  expect(message.notification?.automatic).toMatchObject({state:"blocked",reason:expect.stringContaining("未获本轮分工")});
  expect(result.participants.find(p=>p.roleId===b)?.taskId).toBeNull();
  // Emulate a durable queue written immediately before an interrupted process.
  message.notification!.automatic!.state="running";
  result.participants[0]!.collaborationWait="旧等待提示";
  core.db.prepare("UPDATE workbenches SET body=? WHERE id=?").run(JSON.stringify(result),w.id);
  await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});result=core.workbench.get(w.id);
  expect(result.messages.find(m=>m.id===message.id)?.notification?.automatic?.state).toBe("interrupted");
  expect(result.participants[0]?.collaborationWait).toBeUndefined();
  expect(core.db.prepare("SELECT * FROM workbench_runs WHERE workbench_id=? AND role_id=?").all(w.id,b)).toHaveLength(0);
});

it("暂停的接收角色只保留问题；答复期间暂停则丢弃晚到回复，不声明已处理",async()=>{
  const w=await invoke("workbench:create",{title:"暂停保护",roleIds:[a,b]});route([a]);
  ensureFauxRegistered("b").setResponses([()=>{void core.workbench.setEnabled(w.id,b,false);return fauxAssistantMessage("不应被采用的晚到回复");}]);
  ensureFauxRegistered("a").setResponses([json({plan:"核对",contracts:[]}),tool("tool_search",{query:"workbench_notify",limit:1}),
    tool("workbench_notify",{roleId:b,purpose:"question",message:"请确认字段"}),
    tool("workbench_notify",{roleId:b,purpose:"question",message:"暂停后再次询问"}),fauxAssistantMessage("说明对方暂停，停止等待")]);
  await invoke("workbench:send",{id:w.id,text:"前端只核对字段",requestId:"q"});
  const result=await finish(w.id),notes=result.messages.filter(m=>m.notification);
  expect(notes).toHaveLength(2);expect(notes.every(m=>m.notification?.status==="pending")).toBe(true);
  expect(notes[0]?.notification?.automatic?.state).toBe("interrupted");
  expect(notes[1]?.notification?.automatic?.state).toBe("blocked");
  expect(result.messages.some(m=>m.kind==="reply"&&m.text.includes("晚到回复"))).toBe(false);
});

it.each(["oversized","tool"])("只读答复为%s时保留未解决状态，不执行工具或截断后伪造完成",async kind=>{
  const w=await invoke("workbench:create",{title:"答复有效性",roleIds:[a,b]});route([a]);
  ensureFauxRegistered("b").setResponses([kind==="oversized"?fauxAssistantMessage("字".repeat(1001)):tool("write",{path:"back.txt",content:"不应执行"})]);
  ensureFauxRegistered("a").setResponses([json({plan:"只读确认",contracts:[]}),tool("tool_search",{query:"workbench_notify",limit:1}),
    tool("workbench_notify",{roleId:b,purpose:"question",message:"请确认字段"}),fauxAssistantMessage("明确说明无法完成确认")]);
  await invoke("workbench:send",{id:w.id,text:"前端核对字段",requestId:"q"});
  const result=await finish(w.id),n=result.messages.find(m=>m.notification)!.notification!;
  expect(n.status).toBe("pending");expect(n.automatic?.state).toBe("blocked");
  expect(result.participants.find(p=>p.roleId===b)?.taskId).toBeNull();
  expect(existsSync(join(dir,"personal","back.txt"))).toBe(false);
});
