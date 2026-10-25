import {act,cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import type {AnyAppEvent} from "@pi-harness/contracts";
import RoleContextBar from "./components/RoleContextBar.js";
import WorkbenchContext from "./panels/WorkbenchContext.js";
import {invoke,onEvent} from "./api.js";
import {useStore} from "./store.js";
vi.mock("./api.js",()=>({invoke:vi.fn(),onEvent:vi.fn()}));
vi.mock("./data.js",()=>({openTask:vi.fn(),refreshStaticData:vi.fn(async()=>{}),refreshTaskList:vi.fn(async()=>{})}));
const fixtures=[{roleId:"a",roleName:"任务助手",kind:"single",context:{percent:12.5,currentTokens:1000,contextWindow:8000}},{roleId:"b",roleName:"研究员",kind:"single",context:{percent:50,currentTokens:16000,contextWindow:32000}}];
let emit:(e:AnyAppEvent)=>void;
let unsubscribe:ReturnType<typeof vi.fn<() => void>>;
beforeEach(()=>{
 vi.clearAllMocks();unsubscribe=vi.fn();
 vi.mocked(onEvent).mockImplementation(callback=>{emit=callback;return unsubscribe;});
 vi.mocked(invoke).mockResolvedValue({roles:fixtures} as any);
 useStore.setState({currentTaskId:"one",draftRoleId:null,drilledProjectId:null,roles:[],projects:[],tasks:[]});
});
afterEach(()=>cleanup());
it("shows each role's independent ring without clickable cards and updates compaction",async()=>{
 const view=render(<RoleContextBar/>);
 const supervisor=await screen.findByRole("progressbar",{name:"任务助手上下文使用占比"});
 expect(supervisor.getAttribute("aria-valuenow")).toBe("12.5");
 expect(screen.getByRole("progressbar",{name:"研究员上下文使用占比"}).getAttribute("aria-valuenow")).toBe("50");
 expect(screen.queryByRole("button")).toBeNull();
 vi.mocked(invoke).mockResolvedValue({roles:[{...fixtures[0],context:{percent:null,compacting:true}},fixtures[1]]} as any);
 act(()=>emit({type:"task:roleContext",payload:{taskId:"one"}} as AnyAppEvent));
 await screen.findByText("压缩中");expect(supervisor.hasAttribute("aria-valuenow")).toBe(false);
 view.unmount();expect(unsubscribe).toHaveBeenCalled();
});
it("does not display a previous task's context when its delayed request completes",async()=>{
 let resolveOld!:(r:any)=>void;
 vi.mocked(invoke).mockImplementation(async(_name,input)=>(input as any).taskId==="one" ? new Promise(resolve=>{resolveOld=resolve;}) : {roles:[{...fixtures[1],roleName:"新角色",context:{percent:null}}]} as any);
 render(<RoleContextBar/>);act(()=>useStore.setState({currentTaskId:"two"}));
 await screen.findByText("新角色");await act(async()=>resolveOld({roles:fixtures}));
 expect(screen.queryByText("任务助手")).toBeNull();expect(screen.getByText("—")).toBeTruthy();
});
it("nests tasks under their owning projects and searches without losing the hierarchy",async()=>{
 useStore.setState({projects:[{id:"ai",name:"AI",dir:"/AI"},{id:"docs",name:"文档",dir:"/docs"}] as any,tasks:[{id:"1",title:"整理模型",mode:"single",status:"done",projectId:{id:"ai"}},{id:"2",title:"撰写说明",mode:"single",status:"done",projectId:{id:"docs"}},{id:"3",title:"个人问答",mode:"single",status:"done",projectId:null}] as any});
 render(<WorkbenchContext/>);
 const ai=screen.getByRole("region",{name:"AI项目会话"});
 expect(within(ai).getByText("整理模型")).toBeTruthy();expect(within(ai).queryByText("撰写说明")).toBeNull();
 expect(screen.queryByText("项目对话")).toBeNull();
 fireEvent.click(within(ai).getByRole("button",{name:/AI/}));expect(screen.queryByText("整理模型")).toBeNull();
 fireEvent.change(screen.getByRole("textbox",{name:"搜索会话"}),{target:{value:"整理模型"}});
 await waitFor(()=>expect(within(screen.getByRole("region",{name:"AI项目会话"})).getByText("整理模型")).toBeTruthy());
 expect(screen.queryByRole("region",{name:"文档项目会话"})).toBeNull();
});

it("shows independent cache receipts on each role, including zero and unknown",async()=>{
 vi.mocked(invoke).mockResolvedValue({roles:[{...fixtures[0],context:{percent:12,cacheHitPercent:75}},{...fixtures[1],context:{percent:50,cacheHitPercent:0}}]} as any);
 render(<RoleContextBar/>);expect((await screen.findByLabelText("任务助手缓存命中率")).textContent).toBe("缓存命中 75%");expect(screen.getByLabelText("研究员缓存命中率").textContent).toBe("缓存命中 0%");
 vi.mocked(invoke).mockResolvedValue({roles:[{...fixtures[0],context:{percent:12,cacheHitPercent:null}}]} as any);
 act(()=>emit({type:"task:roleContext",payload:{taskId:"one"}} as AnyAppEvent));await waitFor(()=>expect(screen.getByLabelText("任务助手缓存命中率").textContent).toBe("缓存命中 —"));
});
