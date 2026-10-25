import {
  act,
  within,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Workbench } from "@pi-harness/contracts";
import {
  CollaborationPanel,
  WorkbenchParticipants,
  CollaborationContext,
} from "./panels/Collaboration.js";
import { useCollaboration } from "./workbench-data.js";
import { useStore } from "./store.js";
import { invoke, onEvent } from "./api.js";
vi.mock("./data.js", () => ({
  refreshStaticData: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./api.js", () => ({ invoke: vi.fn(), onEvent: vi.fn() }));
let w: Workbench;
beforeEach(() => {
  vi.clearAllMocks();
  w = {
    id: "wb",
    title: "网站开发",
    projectId: null,
    phase: "draft",
    revision: 3,
    participants: [
      {
        roleId: "front",
        name: "前端",
        enabled: true,
        status: "idle",
        taskId: null,
        responsibility: "界面",
      },
      {
        roleId: "back",
        name: "后端",
        enabled: false,
        status: "paused",
        taskId: null,
        responsibility: "接口",
      },
    ],
    messages: [],
    recommendations: [],
    contracts: [],
    proposals: [],
    createdAt: 1,
    updatedAt: 1,
  };
  useCollaboration.setState({ items: [w], selected: w.id, views: {},pageIds:null,query:"",cursor:null,nextCursor:null,previous:[],loading:false,listError:null });
  useStore.setState({ roles: [] });
  vi.mocked(onEvent).mockReturnValue(() => {});
  vi.mocked(invoke).mockImplementation(async (name, input:any) =>
    name === "workbench:list"
      ? ({ items: input.query && !w.title.includes(input.query) ? [] : [w], nextCursor:null } as any)
      : name === "workbench:get"
        ? (w as any)
        : ({ accepted: true } as any),
  );
});
afterEach(() => cleanup());
it("shows where the request goes and records the exact recipient in the command", async () => {
  render(<CollaborationPanel />);
  const recipient = screen.getByRole("combobox");
  expect(recipient.textContent).toContain("任务助手");
  expect(recipient.textContent).toContain("前端");
  expect(recipient.textContent).not.toContain("后端");
  fireEvent.change(recipient, { target: { value: "front" } });
  fireEvent.change(
    screen.getByRole("textbox", { name: "任务要求或修改意见" }),
    { target: { value: "把按钮改小" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("workbench:send", {
      id: "wb",
      text: "把按钮改小",
      draftRevision: expect.any(Number),
      requestId: expect.any(String),
      roleId: "front",
    }),
  );
});
it("displays user requirements and task dispatch in the collaboration conversation by default", () => {
  w.messages = [
    {
      id: "u",
      requestId: "r",
      sender: "你",
      recipients: ["任务助手"],
      kind: "request",
      text: "新增登录",
      at: 1,
    },
    {
      id: "a",
      requestId: "r",
      sender: "任务助手",
      recipients: ["front"],
      kind: "dispatch",
      text: "前端负责登录界面",
      at: 2,
    },
  ];
  useCollaboration.setState({ items: [w] });
  render(<CollaborationPanel />);
  expect(screen.getByText("新增登录")).toBeTruthy();
  expect(screen.getByText("前端负责登录界面")).toBeTruthy();
  expect(screen.getByText("发送给 前端")).toBeTruthy();
});
it("pause is a backend operation rather than a decorative switch", async () => {
  render(<WorkbenchParticipants w={w} />);
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("workbench:setEnabled", {
      id: "wb",
      roleId: "front",
      enabled: false,
    }),
  );
});
it("chooses contract proposals with the displayed revision", async () => {
  w.phase = "waiting_decision";
  w.contracts = [
    {
      id: "api",
      title: "登录接口",
      content: "old",
      version: 1,
      roles: ["front", "back"],
    },
  ];
  w.proposals = [
    {
      id: "proposal",
      contractId: "api",
      roleId: "front",
      baseVersion: 1,
      content: "new",
      reason: "字段变更",
      status: "pending",
    },
  ];
  useCollaboration.setState({ items: [w] });
  render(<CollaborationPanel />);
  expect(screen.getByRole("dialog", { name: "选择协作方案" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "采用此方案" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("workbench:choose", {
      id: "wb",
      proposalId: "proposal",
      revision: 3,
    }),
  );
});

it("keeps separate task drafts, recipients and tabs while switching and clearing only the sent draft", async () => {
  const other = {
    ...w,
    id: "other",
    title: "另一个任务",
    participants: w.participants.map((p) => ({ ...p })),
  };
  vi.mocked(invoke).mockImplementation(async (name, input) =>
    name === "workbench:list"
      ? ({ items: [w, other] } as any)
      : name === "workbench:get"
        ? (((input as { id: string }).id === "wb" ? w : other) as any)
        : ({ accepted: true } as any),
  );
  useCollaboration.setState({ items: [w, other] });
  render(<CollaborationPanel />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "任务要求或修改意见" }),
    { target: { value: "任务一草稿" } },
  );
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "front" },
  });
  fireEvent.click(screen.getByRole("button", { name: "共同约定" }));
  const { act } = await import("@testing-library/react");
  act(() => useCollaboration.setState({ selected: "other" }));
  expect(
    (
      screen.getByRole("textbox", {
        name: "任务要求或修改意见",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("");
  fireEvent.change(
    screen.getByRole("textbox", { name: "任务要求或修改意见" }),
    { target: { value: "任务二草稿" } },
  );
  act(() => useCollaboration.setState({ selected: "wb" }));
  expect(
    (
      screen.getByRole("textbox", {
        name: "任务要求或修改意见",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("任务一草稿");
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
    "front",
  );
  expect(screen.getByRole("button", { name: "共同约定" }).className).toContain(
    "selected",
  );
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() =>
    expect(useCollaboration.getState().views.wb?.text).toBe(""),
  );
  expect(useCollaboration.getState().views.other?.text).toBe("任务二草稿");
});

it("places participants in the contextual sidebar, filters tasks and opens creation separately", async () => {
  const { container } = render(
    <>
      <CollaborationContext />
      <CollaborationPanel />
    </>,
  );
  await waitFor(() =>
    expect(container.querySelector(".wb-sidebar-members")).toBeTruthy(),
  );
  expect(container.querySelector(".wb-context .wb-member")).toBeTruthy();
  expect(container.querySelector(".wb-surface .wb-member")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "新任务" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索协作任务" }), {
    target: { value: "no matching task" },
  });
  await waitFor(()=>expect(container.querySelectorAll(".wb-task")).toHaveLength(0));
  expect(screen.getByText("没有匹配的任务")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "新建协作任务" }));
  expect(screen.getByRole("dialog", { name: "新建协作任务" })).toBeTruthy();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭新建任务" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("暂停角色仍显示已有成果已应用，不能把暂停误解为成果丢失", () => {
  w.participants[1]!.status = "applied";
  render(<WorkbenchParticipants w={w} />);
  expect(screen.getByText("已暂停 · 已应用")).toBeTruthy();
  expect(screen.getByRole("button", { name: "恢复" }).getAttribute("aria-pressed")).toBe("true");
  expect(invoke).not.toHaveBeenCalled();
});

it('定向通知在协作对话及执行记录显示真实状态，查看不触发角色或任务',async()=>{
 w.messages=[{id:'notification',requestId:'r',sender:'front',recipients:['back'],kind:'handoff',text:'请核对共享字段',at:1,notification:{sourceTaskId:'ta',sourceToolCallId:'tool',status:'pending'}}];
 vi.mocked(invoke).mockImplementation(async name=>name==='workbench:usage'?{roles:[]} as never:name==='workbench:usageCalls'?{calls:[],nextCursor:null} as never:w as never);
 render(<CollaborationPanel/>);
 expect(screen.getByText('待送达')).toBeTruthy();expect(screen.getByText(/接收角色已暂停/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'执行记录'}));
 expect(screen.getByText('待送达')).toBeTruthy();expect(screen.getByText('请核对共享字段')).toBeTruthy();
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('workbench:usage',{id:w.id}));
 expect(vi.mocked(invoke).mock.calls.some(([name])=>['workbench:send','workbench:setEnabled','task:prompt'].includes(name))).toBe(false);
});
it('shows failed delivery checks separately from role completion and keeps the reason visible',()=>{
 w.participants[0]!.status='awaiting_review';
 w.participants[0]!.deliveryCheck={status:'failed',at:1,issues:['brief/brief.json：缺少字段 /duration'],files:[]};
 render(<WorkbenchParticipants w={w}/>);
 expect(screen.getByText('交付检查未通过：brief/brief.json：缺少字段 /duration')).toBeTruthy();
});
it('shows the exclusive holder and the waiting roles queue position',()=>{
 w.phase='running';
 w.roundProgress={requestId:'q',roles:w.participants.map(p=>({roleId:p.roleId,dependsOn:[],stage:'running'}))};
 for(const p of w.participants){p.enabled=true;p.status='running';}
 w.participants[0]!.pluginResources=[{resource:'computer',status:'using',position:0}];
 w.participants[1]!.pluginResources=[{resource:'computer',status:'waiting',position:1}];
 render(<WorkbenchParticipants w={w}/>);expect(screen.getByText('独占使用 computer')).toBeTruthy();expect(screen.getByText(/^等待插件资源 computer · 队列第 1 位/)).toBeTruthy();
});
it("opens role permissions when the current round is blocked and keeps a visible entry after dismissal", async () => {
  w.phase = "stopped";
  w.participants[0]!.status = "blocked";
  w.messages = [
    {id:"request",kind:"request",sender:"你",recipients:[],text:"制作网页",at:1,requestId:"round"},
    {id:"dispatch",kind:"dispatch",sender:"coordinator",recipients:["front"],text:"实现界面",at:2,requestId:"round"},
    {id:"permission",kind:"notice",sender:"front",recipients:[],text:"等待授权：请先在工作台授权此角色运行命令",at:3,requestId:"round"},
  ];
  vi.mocked(invoke).mockImplementation(async (name,input:any)=> name==="mcp:list"?{servers:[]} as any : name==="workbench:get"?w as any:name==="workbench:list"?{items:[w],nextCursor:null} as any:{accepted:true} as any);
  render(<CollaborationPanel/>);
  const dialog = await screen.findByRole("dialog", {name:"角色执行权限"});
  expect(dialog.textContent).toContain("前端");
  expect(invoke).not.toHaveBeenCalledWith("workbench:setAccess",expect.anything());
  fireEvent.click(within(within(dialog).getByRole("group",{name:"前端"})).getByLabelText("允许在职责范围内运行命令"));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("workbench:setAccess",{id:"wb",roleId:"front",commands:true,network:false,servers:[]}));
  expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==="workbench:setAccess")).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalledWith("workbench:send",expect.anything());
  fireEvent.click(screen.getByRole("button",{name:"关闭权限窗口"}));
  expect(screen.queryByRole("dialog",{name:"角色执行权限"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"角色权限"}));
  expect(screen.getByRole("dialog",{name:"角色执行权限"})).toBeTruthy();
});
it("does not reopen dismissed permissions on a refresh or prompt for a previous round", async () => {
  w.phase="stopped";
  w.participants[0]!.status="blocked";
  w.messages=[
    {id:"request",kind:"request",sender:"你",recipients:[],text:"任务",at:1,requestId:"round"},
    {id:"dispatch",kind:"dispatch",sender:"coordinator",recipients:["front"],text:"执行",at:2,requestId:"round"},
    {id:"notice",kind:"notice",sender:"front",recipients:[],text:"等待授权：需要命令",at:3,requestId:"round"},
  ];
  const {rerender}=render(<CollaborationPanel/>);
  await screen.findByRole("dialog",{name:"角色执行权限"});
  fireEvent.click(screen.getByRole("button",{name:"关闭权限窗口"}));
  w={...w,revision:w.revision+1};
  act(()=>useCollaboration.setState({items:[w]}));
  rerender(<CollaborationPanel/>);
  expect(screen.queryByRole("dialog",{name:"角色执行权限"})).toBeNull();
  cleanup();
  w={...w,messages:[...w.messages,{id:"next",kind:"request",sender:"你",recipients:[],text:"新问题",at:4,requestId:"next"}]};
  useCollaboration.setState({items:[w],views:{}});
  render(<CollaborationPanel/>);
  expect(screen.queryByRole("dialog",{name:"角色执行权限"})).toBeNull();
});
it("continues only the permission-blocked role on explicit click without sending or clearing the composer draft", async () => {
  w.phase="stopped";
  w.participants[0]!.status="blocked";
  w.access=[{roleId:"front",commands:true,network:false,servers:[]}];
  w.messages=[
    {id:"request",kind:"request",sender:"你",recipients:[],text:"任务",at:1,requestId:"round"},
    {id:"dispatch",kind:"dispatch",sender:"coordinator",recipients:["front"],text:"执行",at:2,requestId:"round"},
    {id:"notice",kind:"notice",sender:"front",recipients:[],text:"等待授权：需要命令",at:3,requestId:"round"},
  ];
  vi.mocked(invoke).mockImplementation(async (name)=>name==="mcp:list"?{servers:[]} as any:name==="workbench:get"?w as any:name==="workbench:list"?{items:[w],nextCursor:null} as any:{accepted:true} as any);
  useCollaboration.setState({items:[w]});
  render(<CollaborationPanel/>);
  await screen.findByRole("dialog",{name:"角色执行权限"});
  expect(invoke).not.toHaveBeenCalledWith("workbench:send",expect.anything());
  fireEvent.click(screen.getByRole("button",{name:"继续前端执行"}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("workbench:resume",{id:"wb",roleId:"front",requestId:expect.any(String)}));
  expect(vi.mocked(invoke).mock.calls.filter(([name])=>name==="workbench:resume")).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalledWith("workbench:send",expect.anything());
  expect(invoke).not.toHaveBeenCalledWith("workbench:setAccess",expect.anything());
});
it("offers the same host continuation for interrupted work without changing or sending the composer draft",async()=>{
 w.phase='stopped';w.participants[0]!.status='interrupted';
 useCollaboration.setState({items:[w]});
 render(<CollaborationPanel/>);
 fireEvent.change(screen.getByRole('textbox',{name:'任务要求或修改意见'}),{target:{value:'尚未发送的新想法'}});
 fireEvent.click(screen.getByRole('button',{name:'继续执行'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('workbench:resume',{id:'wb',requestId:expect.any(String)}));
 expect(invoke).not.toHaveBeenCalledWith('workbench:send',expect.anything());
 expect((screen.getByRole('textbox',{name:'任务要求或修改意见'}) as HTMLTextAreaElement).value).toBe('尚未发送的新想法');
});
it('shows precise current role cache receipts and distinguishes unknown from zero',()=>{
 w.usage=[{roleId:'front',percent:0.2,cacheHitPercent:17.3}];
 const view=render(<WorkbenchParticipants w={w}/>);
 expect(screen.getByLabelText('前端缓存命中率').textContent).toBe('缓存 17.3%');expect(screen.getByText('0.2%')).toBeTruthy();
 w={...w,usage:[{roleId:'front',percent:null,cacheHitPercent:null}]};view.rerender(<WorkbenchParticipants w={w}/>);expect(screen.getByLabelText('前端缓存命中率').textContent).toBe('缓存 —');
 w={...w,usage:[{roleId:'front',percent:2.3,cacheHitPercent:0}]};view.rerender(<WorkbenchParticipants w={w}/>);expect(screen.getByLabelText('前端缓存命中率').textContent).toBe('缓存 0%');
});
