import {afterEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import type {Workbench} from "@pi-harness/contracts";
import {roleProgress,workbenchProgress} from "./workbench-progress.js";
import WorkbenchProgress from "./components/WorkbenchProgress.js";
afterEach(cleanup);
function state():Workbench {
  return {id:"w",title:"网站",projectId:null,phase:"running",revision:1,createdAt:1,updatedAt:1,
    participants:["a","b","c"].map((roleId,i)=>({roleId,name:["后端","前端","设计"][i]!,enabled:true,status:"idle",taskId:null,responsibility:"仅本角色职责"})),
    roundProgress:{requestId:"q",roles:[{roleId:"a",dependsOn:[],stage:"running"},{roleId:"b",dependsOn:["a"],stage:"ready"}]},
    messages:[{id:"request",requestId:"q",sender:"你",recipients:[],kind:"request",text:"制作网站",at:1}],contracts:[],proposals:[],recommendations:[]};
}
it("只依据宿主快照展示依赖，不把等待角色称为工作中，不为无关角色分工",()=>{
  const w=state();w.participants[0]!.status="running";
  expect(roleProgress(w,w.participants[1]!)).toMatchObject({label:"等待上游交付",detail:expect.stringContaining("后端")});
  expect(roleProgress(w,w.participants[2]!).label).toBe("本轮无需参与");
  expect(workbenchProgress(w)).toMatchObject({finished:0,assignedCount:2});
});
it("规划、席位和准备隔离副本分别说明，旧一轮的完成不算本轮已完成",()=>{
  const w=state();w.phase="planning";w.roundProgress!.roles[0]!.stage="planning";
  w.participants[0]!.status="awaiting_review";
  expect(roleProgress(w,w.participants[0]!).label).toBe("正在规划");
  expect(roleProgress(w,w.participants[1]!).label).toBe("规划已就绪");
  w.phase="running";w.roundProgress!.roles[0]!.stage="finished";
  expect(roleProgress(w,w.participants[1]!).label).toBe("等待执行席位");
  w.roundProgress!.roles[1]!.stage="preparing";
  expect(roleProgress(w,w.participants[1]!).label).toBe("准备执行");
});
it("暂停上游、交付检查失败及失败后停止仍显示具体依赖原因",()=>{
  const w=state();w.participants[0]!.enabled=false;
  expect(roleProgress(w,w.participants[1]!).detail).toContain("已暂停");
  w.participants[0]!.enabled=true;w.roundProgress!.roles[0]!.stage="finished";
  w.participants[0]!.deliveryCheck={status:"failed",at:1,files:[],issues:["字段缺失"]};
  w.phase="error";w.participants[1]!.status="blocked";w.roundProgress!.roles[1]!.stage="interrupted";
  expect(roleProgress(w,w.participants[1]!)).toMatchObject({label:"等待上游交付",detail:expect.stringContaining("交付检查未通过"),tone:"attention"});
});
it.each(["waiting_approval","waiting_user"])("%s提供用户处理入口，不泄露审批原始命令",status=>{
  const w=state();w.participants[0]!.status=status;
  expect(roleProgress(w,w.participants[0]!)).toMatchObject({tone:"attention",tab:"records"});
});
it("等待授权与等待上游不同，插件队列展示真实位置而不推测完成时间",()=>{
  const w=state();w.participants[0]!.status="blocked";w.roundProgress!.roles[0]!.stage="interrupted";w.phase="stopped";
  w.messages.push({id:"n",requestId:"q",sender:"a",recipients:[],kind:"notice",text:"等待授权：原始命令详情",at:2});
  expect(roleProgress(w,w.participants[0]!)).toMatchObject({label:"等待授权",tab:"records"});
  expect(roleProgress(w,w.participants[0]!).detail).not.toContain("原始命令");
  w.phase="running";w.participants[0]!.status="running";w.roundProgress!.roles[0]!.stage="running";
  w.participants[0]!.pluginResources=[{resource:"computer",status:"waiting",position:2}];
  expect(roleProgress(w,w.participants[0]!).detail).toContain("队列第 2 位");
});
it("提问方和只读答复方分别展示，不把未分工的答复方计入执行任务总数",()=>{
  const w=state();w.participants[0]!.collaborationWait="等待设计答复：配色问题";
  w.messages.push({id:"question",requestId:"q",sender:"a",recipients:["c"],kind:"handoff",text:"配色",at:2,
    notification:{sourceTaskId:"ta",sourceToolCallId:"call",purpose:"question",status:"pending",automatic:{state:"running",roleChain:["a"]}}});
  expect(roleProgress(w,w.participants[0]!).label).toBe("等待角色答复");
  expect(roleProgress(w,w.participants[2]!).label).toBe("正在只读答复");
  expect(workbenchProgress(w)).toMatchObject({assignedCount:2,finished:0});
  expect(workbenchProgress(w).roles).toHaveLength(3);
});
it("执行结束、需配套更新、已应用与用户验收分别表达",()=>{
  const w=state();w.phase="awaiting_review";w.roundProgress!.roles[0]!.stage="finished";w.participants[0]!.status="awaiting_review";
  expect(roleProgress(w,w.participants[0]!).label).toBe("待审阅成果");
  w.participants[0]!.status="needs_update";expect(roleProgress(w,w.participants[0]!).label).toBe("需配套更新");
  w.participants[0]!.status="applied";expect(roleProgress(w,w.participants[0]!).label).toBe("已应用成果");
  w.phase="done";expect(roleProgress(w,w.participants[0]!).label).toBe("已验收");
});
it("新一轮回顾不复用旧进度，旧记录没有依赖快照时不猜测等待谁",()=>{
  const w=state();w.messages.push({id:"new",requestId:"new",sender:"你",recipients:[],kind:"request",text:"之前做了什么",at:3});w.phase="clarify";
  expect(workbenchProgress(w).roles).toHaveLength(0);expect(roleProgress(w,w.participants[0]!).label).toBe("本轮无需参与");
  delete w.roundProgress;w.phase="running";
  w.messages.push({id:"d",requestId:"new",sender:"任务助手",recipients:["b"],kind:"dispatch",text:"等待后端，不是真实依赖凭据",at:4});
  expect(roleProgress(w,w.participants[1]!).label).toBe("等待执行席位");
  expect(roleProgress(w,w.participants[1]!).detail).not.toContain("后端");
});
it("停止与恢复后的陈旧运行状态不能产生仍在工作的提示，暂停保留已应用状态",()=>{
  const w=state();w.phase="stopped";w.participants[0]!.status="running";w.participants[0]!.collaborationWait="旧答复";
  expect(roleProgress(w,w.participants[0]!).label).toBe("本轮已停止");
  w.participants[0]!.enabled=false;w.participants[0]!.status="applied";
  expect(roleProgress(w,w.participants[0]!).label).toBe("已暂停 · 已应用");
});
it("进度默认收起、展开后可跳转已有记录，不触发模型或恢复角色",()=>{
  const w=state();w.participants[0]!.status="waiting_approval";const onTab=vi.fn();
  const {container}=render(<WorkbenchProgress w={w} onTab={onTab}/>);
  const details=screen.getByLabelText("本轮协作进度");expect(details.hasAttribute("open")).toBe(false);
  fireEvent.click(screen.getByText("0/2 项执行结束"));
  fireEvent.click(screen.getAllByRole("button",{name:"查看记录",hidden:true})[0]!);
  expect(onTab).toHaveBeenCalledWith("records");expect(container.querySelector('[role="progressbar"]')).toBeNull();
});
it("暂停角色未执行时显示暂停数量，不把安静状态描述为全部执行结束",()=>{
 const w=state();w.participants[0]!.enabled=false;w.participants[1]!.enabled=false;
 render(<WorkbenchProgress w={w} onTab={vi.fn()}/>);
 expect(screen.getByText("2 位已暂停")).toBeTruthy();expect(screen.queryByText("执行结束后仍需审阅与验收")).toBeNull();
});
it("旧任务没有依赖快照时仍可依据本轮公开通知显示等待授权",()=>{
 const w=state();delete w.roundProgress;w.phase="stopped";w.participants[0]!.status="blocked";
 w.messages.push({id:"dispatch",requestId:"q",sender:"任务助手",recipients:["a"],kind:"dispatch",text:"职责",at:2},
  {id:"permission",requestId:"q",sender:"a",recipients:[],kind:"notice",text:"等待授权：缺少命令权限",at:3});
 expect(roleProgress(w,w.participants[0]!).label).toBe("等待授权");
});
it("结束与停止的收尾间隙不会误显示为重新排队",()=>{
 const w=state();w.participants[0]!.status="done";
 expect(roleProgress(w,w.participants[0]!).label).toBe("整理执行结果");
 w.participants[0]!.status="cancelled";expect(roleProgress(w,w.participants[0]!).label).toBe("正在停止");
 w.participants[0]!.status="error";expect(roleProgress(w,w.participants[0]!).label).toBe("执行失败");
});
