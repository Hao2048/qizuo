import {act,cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import AgentPanel from "./components/AgentPanel.js";
import {useStore} from "./store.js";
import {invoke,onEvent} from "./api.js";
vi.mock("./api.js",()=>({invoke:vi.fn(),onEvent:vi.fn()}));
const agent={id:"child",taskId:"a",roleId:"r",roleName:"文档助手",title:"整理文档",cwd:"/tmp/child",status:"done" as const,startedAt:1,updatedAt:2,tokens:42,costUSD:0.03,result:"已整理说明文档"};
beforeEach(()=>{vi.clearAllMocks();useStore.setState({currentTaskId:"a",taskStatus:"done"});vi.mocked(onEvent).mockReturnValue(()=>{});vi.mocked(invoke).mockImplementation(async(name)=>name==="task:listAgents" ? {agents:[agent]} : {accepted:true} as any);});
afterEach(cleanup);
it("shows historical details without a retired supervisor resume action",async()=>{
 render(<AgentPanel/>);await screen.findByRole("button",{name:"展开协作任务"});
 expect(screen.queryByText("已整理说明文档")).toBeNull();fireEvent.click(screen.getByRole("button",{name:"展开协作任务"}));
 fireEvent.click(screen.getByRole("button",{name:/文档助手.*整理文档.*已完成/}));expect(screen.getByText("已整理说明文档")).toBeTruthy();
 expect(vi.mocked(invoke).mock.calls.some(([name])=>String(name)==="task:resumeChildren")).toBe(false);
 expect(screen.queryByRole("button",{name:"恢复未完成任务"})).toBeNull();
});
it("does not offer recovery for a task that exhausted its rework allowance",async()=>{
 vi.mocked(invoke).mockImplementation(async(name)=>name==="task:listAgents" ? {agents:[{...agent,status:"error",error:"未通过"}]} : {nodes:[{id:"node",title:"failed",status:"failed",reworkCount:2,acceptance:"ok"}]} as any);
 render(<AgentPanel/>);fireEvent.click(await screen.findByRole("button",{name:"展开协作任务"}));
 expect(screen.queryByRole("button",{name:"恢复未完成任务"})).toBeNull();fireEvent.click(screen.getByRole("button",{name:/文档助手.*整理文档.*失败/}));expect(screen.getByText("未通过")).toBeTruthy();
});
it("ignores responses from a previously selected conversation and unsubscribes on leave",async()=>{
 let resolveOld!:(value:any)=>void;const old=new Promise(resolve=>{resolveOld=resolve;});const unsubscribe=vi.fn();vi.mocked(onEvent).mockReturnValue(unsubscribe);
 vi.mocked(invoke).mockImplementation(async(name,input)=>{if((input as any).taskId==="a")return old as any;return {agents:[{...agent,id:"new",taskId:"b",roleName:"新助手"}]} as any;});
 const view=render(<AgentPanel/>);act(()=>useStore.setState({currentTaskId:"b"}));await screen.findByRole("button",{name:"展开协作任务"});
 await act(async()=>resolveOld({agents:[agent]}));fireEvent.click(screen.getByRole("button",{name:"展开协作任务"}));expect(screen.getByText("新助手")).toBeTruthy();expect(screen.queryByText("文档助手")).toBeNull();
 view.unmount();await waitFor(()=>expect(unsubscribe).toHaveBeenCalledTimes(2));
});
