import { act,cleanup,fireEvent,render,screen,waitFor } from "@testing-library/react";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import type { AnyAppEvent,TaskActivity } from "@pi-harness/contracts";
import TaskActivityPanel from "./components/TaskActivityPanel.js";
import { invoke,onEvent } from "./api.js";
import { openTask } from "./data.js";
vi.mock("./api.js",()=>({invoke:vi.fn(),onEvent:vi.fn()}));
vi.mock("./data.js",()=>({openTask:vi.fn()}));
let emit:(event:AnyAppEvent)=>void,unsubscribe:ReturnType<typeof vi.fn<() => void>>;
const item:TaskActivity={id:"running",title:"整理报告",status:"waiting_approval",busy:true,mode:"single",projectName:"文档项目",updatedAt:1,progress:null,recovery:null};
let items:TaskActivity[];
beforeEach(()=>{
 vi.clearAllMocks();items=[item,{...item,id:"finished",title:"已完成报告",status:"done",busy:false,mode:"single"}];unsubscribe=vi.fn();
 vi.mocked(onEvent).mockImplementation(callback=>{emit=callback;return unsubscribe;});
 vi.mocked(invoke).mockImplementation(async(name)=>{
  if(name==="task:listActivity")return {items} as any;
  if(name==="task:activityResult")return {text:"报告结果",truncated:false} as any;
  if(name==="task:abort")return {ok:true} as any;
  return {} as any;
 });
});
afterEach(()=>{cleanup();vi.useRealTimers();});
it("shows waiting tasks, reads results on demand and opens the selected conversation",async()=>{
 render(<TaskActivityPanel/>);fireEvent.click(await screen.findByRole("button",{name:"任务 1"}));
 expect(await screen.findByText("待审批")).toBeTruthy();expect(screen.queryByRole("button",{name:"停止任务 已完成报告"})).toBeNull();
 expect(vi.mocked(invoke).mock.calls.some(([name])=>name==="task:activityResult")).toBe(false);
 fireEvent.click(screen.getByRole("button",{name:/已完成报告.*已完成/}));expect(await screen.findByText("报告结果")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"打开会话"}));
 await waitFor(()=>expect(openTask).toHaveBeenCalledWith("finished"));
 await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
});
it("stops the selected task and keeps a failed stop visible after a successful refresh",async()=>{
 vi.mocked(invoke).mockImplementation(async(name)=>{if(name==="task:abort")throw new Error("停止失败");return {items} as any;});
 render(<TaskActivityPanel/>);fireEvent.click(await screen.findByRole("button",{name:"任务 1"}));
 fireEvent.click(await screen.findByRole("button",{name:"停止任务 整理报告"}));
 expect(await screen.findByRole("alert")).toHaveProperty("textContent","停止失败");
 expect(invoke).toHaveBeenCalledWith("task:abort",{taskId:"running"});
 await waitFor(()=>expect(screen.getByRole("button",{name:"停止任务 整理报告"}).hasAttribute("disabled")).toBe(false));
 expect(screen.getByRole("alert").textContent).toBe("停止失败");
});
it("ignores stale result requests and closes on Escape with focus returned",async()=>{
 let resolveOld!:(value:unknown)=>void;
 vi.mocked(invoke).mockImplementation(async(name,input)=>name==="task:listActivity" ? {items} as any : (input as {taskId:string}).taskId==="running" ? new Promise(resolve=>{resolveOld=resolve;}) : {text:"新结果",truncated:false} as any);
 render(<TaskActivityPanel/>);const toggle=await screen.findByRole("button",{name:"任务 1"});fireEvent.click(toggle);
 fireEvent.click(await screen.findByRole("button",{name:/整理报告.*待审批/}));
 fireEvent.click(screen.getByRole("button",{name:/已完成报告.*已完成/}));expect(await screen.findByText("新结果")).toBeTruthy();
 await act(async()=>resolveOld({text:"旧结果",truncated:false}));expect(screen.queryByText("旧结果")).toBeNull();
 fireEvent.keyDown(document,{key:"Escape"});expect(screen.queryByRole("dialog")).toBeNull();expect(document.activeElement).toBe(toggle);
});
it("refreshes background state from events and removes timers and listeners on unmount",async()=>{
 vi.useFakeTimers();const view=render(<TaskActivityPanel/>);
 await act(async()=>{});
 items=[];
 act(()=>emit({type:"task:state",ts:1,payload:{taskId:"running",status:"done"}}));
 await act(async()=>vi.advanceTimersByTimeAsync(110));
 expect(screen.getByRole("button",{name:"任务"})).toBeTruthy();
 view.unmount();expect(unsubscribe).toHaveBeenCalled();const calls=vi.mocked(invoke).mock.calls.length;
 await act(async()=>vi.advanceTimersByTimeAsync(20000));expect(vi.mocked(invoke).mock.calls.length).toBe(calls);
});

function completionReport(id:string){return {scope:"chat",id,assessedAt:1,token:"a".repeat(64),state:"reply_ended",conditions:[{id:"execution",label:`${id} 的执行记录`,status:"passed",evidenceIds:[]}],evidence:[]};}
it("shows a single lazy evidence entry only inside the selected task details",async()=>{
 vi.mocked(invoke).mockImplementation(async(name,input)=>{
  if(name==="task:listActivity")return {items} as any;
  if(name==="completion:get")return completionReport((input as {id:string}).id) as any;
  return {text:"报告结果",truncated:false} as any;
 });
 render(<TaskActivityPanel/>);
 expect(screen.queryByText(/^完成条件与交付证据/)).toBeNull();
 fireEvent.click(await screen.findByRole("button",{name:"任务 1"}));
 expect(screen.queryByText(/^完成条件与交付证据/)).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:/已完成报告.*已完成/}));
 const details=screen.getByRole("region",{name:"任务详情"});
 const entry=screen.getByText(/^完成条件与交付证据/);
 expect(details.contains(entry)).toBe(true);expect(screen.getAllByText(/^完成条件与交付证据/)).toHaveLength(1);
 expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==="completion:get")).toHaveLength(0);
 fireEvent.click(entry);await screen.findByText(/finished 的执行记录/);
 expect(invoke).toHaveBeenCalledWith("completion:get",{scope:"chat",id:"finished"});
 fireEvent.click(screen.getByRole("button",{name:"刷新任务"}));await screen.findByText("报告结果");
 expect(screen.getAllByText(/^完成条件与交付证据/)).toHaveLength(1);
 fireEvent.click(screen.getByRole("button",{name:"关闭任务管理"}));expect(screen.queryByText(/^完成条件与交付证据/)).toBeNull();
});
it("resets evidence when switching tasks and ignores a previous task's pending response",async()=>{
 let resolveOld!:(value:unknown)=>void;
 vi.mocked(invoke).mockImplementation(async(name,input)=>{
  if(name==="task:listActivity")return {items} as any;
  if(name==="completion:get")return (input as {id:string}).id==="running"?new Promise(resolve=>{resolveOld=resolve;}):completionReport("finished") as any;
  return {text:"报告结果",truncated:false} as any;
 });
 render(<TaskActivityPanel/>);fireEvent.click(await screen.findByRole("button",{name:"任务 1"}));
 fireEvent.click(screen.getByRole("button",{name:/整理报告.*待审批/}));fireEvent.click(screen.getByText(/^完成条件与交付证据/));
 await waitFor(()=>expect(resolveOld).toBeTypeOf("function"));
 fireEvent.click(screen.getByRole("button",{name:/已完成报告.*已完成/}));
 expect(screen.getByText(/^完成条件与交付证据/).closest("details")?.open).toBe(false);
 fireEvent.click(screen.getByText(/^完成条件与交付证据/));await screen.findByText(/finished 的执行记录/);
 await act(async()=>resolveOld(completionReport("running")));
 expect(screen.queryByText(/running 的执行记录/)).toBeNull();expect(screen.getAllByText(/^完成条件与交付证据/)).toHaveLength(1);
 expect(vi.mocked(invoke).mock.calls.every(([name])=>["task:listActivity","task:activityResult","completion:get"].includes(name))).toBe(true);
});
