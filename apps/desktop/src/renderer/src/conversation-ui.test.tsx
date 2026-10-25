import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import TranscriptView from "./components/TranscriptView.js";
import InputBar from "./components/InputBar.js";
import { Markdownish } from "./components/Markdown.js";
import { conversationTurns, turnAnchor } from "./components/conversation.js";
import { dispatchAppEvent } from "./events.js";
import { useStore } from "./store.js";
import type { TranscriptMessage } from "@pi-harness/contracts";
const history: TranscriptMessage[] = [
  { id: "u1", role: "user", text: "检查项目结构" },
  {
    id: "a1",
    role: "assistant",
    thinking: "先读取目录，再核验配置。",
    toolCalls: [{ id: "c1", name: "read", args: { path: "package.json" } }],
  },
  { id: "u2", role: "user", text: "再补充测试" },
  {
    id: "r1",
    role: "toolResult",
    toolCallId: "c1",
    toolName: "read",
    text: "真实返回内容",
  },
  {
    id: "a2",
    role: "assistant",
    text: "## 验证结果\n\n**已完成**，见 `app.ts`。",
  },
];
beforeEach(() => {
  useStore.getState().resetConversation();
  useStore.setState({
    currentTaskId: "t",
    tasks: [],
    projects: [],
    roles: [],
    providers: [],
    settings: null,
    prompts: [],
  });
  window.pih = {
    invoke: vi.fn(async () => ({ ok: true, result: { prompts: [] } })),
    onEvent: () => () => {},
    platform: "darwin",
    versions: { electron: "", chrome: "" },
  };
});
afterEach(() => {
  cleanup();
  useStore.getState().resetConversation();
  useStore.setState({ currentTaskId: null });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.pih;
});
it("associates interleaved tool results with the original request turn", () => {
  const turns = conversationTurns(history, [
    { toolCallId: "c1", toolName: "read", status: "done", turnId: "u2" },
  ]);
  expect(turns[0]!.messages.map((m) => m.id)).toEqual(["a1", "r1"]);
  expect(turns[0]!.tools).toHaveLength(1);
  expect(turns[1]!.messages.map((m) => m.id)).toEqual(["a2"]);
});
it("renders a tool once across live and persisted results, with expandable output", () => {
  useStore.setState({
    transcript: history,
    toolCards: [
      {
        toolCallId: "c1",
        toolName: "read",
        status: "done",
        resultPreview: "真实返回内容",
      },
    ],
  });
  const view = render(<TranscriptView />);
  fireEvent.click(within(document.getElementById(turnAnchor("u1"))!).getByRole("button",{name:/已完成/}));
  expect(view.container.querySelectorAll(".tool-card")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /read.*完成/ }));
  expect(screen.getByText("真实返回内容")).toBeTruthy();
  expect(
    document.getElementById(turnAnchor("u1"))?.querySelector(".tool-card"),
  ).toBeTruthy();
});
it("keeps missing historical tool results unknown instead of reporting completion", () => {
  useStore.setState({ transcript: history.slice(0, 2), taskStatus: "done" });
  render(<TranscriptView />);
  fireEvent.click(screen.getByRole("button",{name:/已完成/}));
  expect(screen.getByText("暂无结果")).toBeTruthy();
  expect(screen.queryByText("完成")).toBeNull();
});
it("navigates to the chosen turn and respects reduced motion", () => {
  useStore.setState({ transcript: history });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  render(<TranscriptView />);
  const nav = screen.getByRole("navigation", { name: "对话轮次导航" });
  fireEvent.click(within(nav).getByRole("button", { name: /跳转到第 1 轮/ }));
  expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  expect(
    within(nav)
      .getByRole("button", { name: /跳转到第 1 轮/ })
      .getAttribute("aria-current"),
  ).toBe("location");
});
it("does not pull a reader away from history when new output arrives", async () => {
  useStore.setState({ transcript: history });
  const view = render(<TranscriptView />);
  const root = view.container.querySelector(".transcript")! as HTMLElement;
  Object.defineProperties(root, {
    scrollHeight: { configurable: true, value: 1400 },
    clientHeight: { configurable: true, value: 400 },
  });
  root.scrollTop = 100;
  fireEvent.scroll(root);
  act(() => useStore.getState().appendStreamText("新增回复"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "回到最新" })).toBeTruthy(),
  );
  await new Promise((r) => setTimeout(r, 40));
  expect(root.scrollTop).toBe(100);
  const scroll = vi.fn();
  Object.defineProperty(root, "scrollTo", {
    configurable: true,
    value: scroll,
  });
  fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
  expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ top: 1400 }));
});
it("clears navigation when switching to an empty conversation", () => {
  useStore.setState({ transcript: history });
  render(<TranscriptView />);
  expect(screen.getByRole("navigation", { name: "对话轮次导航" })).toBeTruthy();
  act(() => {
    useStore.getState().resetConversation();
    useStore.getState().selectTask("next");
  });
  expect(screen.queryByRole("navigation", { name: "对话轮次导航" })).toBeNull();
});
it("attributes a live tool to the user turn active when it started", () => {
  useStore.setState({ transcript: [history[0]!] });
  dispatchAppEvent({
    type: "task:stream",
    ts: 1,
    payload: {
      taskId: "t",
      kind: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
    },
  });
  expect(useStore.getState().toolCards[0]?.turnId).toBe("u1");
});
it("composes a welcome suggestion without submitting a task", () => {
  render(
    <>
      <TranscriptView />
      <InputBar />
    </>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "梳理项目结构并找出可优化的地方" }),
  );
  expect(
    (screen.getByPlaceholderText(/描述任务/) as HTMLTextAreaElement).value,
  ).toBe("梳理项目结构并找出可优化的地方");
  expect(window.pih!.invoke).not.toHaveBeenCalledWith(
    "task:create",
    expect.anything(),
  );
});
it("renders readable Markdown and keeps HTML inert", () => {
  const view = render(
    <Markdownish
      text={
        "## 结果\n\n**安全** `config.ts`\n\n- 一项\n- 二项\n\n<script>alert(1)</script>\n\n```ts\nconst done = true;\n```"
      }
    />,
  );
  expect(screen.getByRole("heading", { name: "结果" })).toBeTruthy();
  expect(view.container.querySelectorAll("li")).toHaveLength(2);
  expect(view.container.querySelector("script")).toBeNull();
  expect(screen.getByText("const done = true;")).toBeTruthy();
});
it("reads full output in pages without re-running the original tool", async()=>{
 useStore.setState({transcript:[{id:"u",role:"user",text:"读取"},{id:"r",role:"toolResult",toolName:"read",toolCallId:"call",text:"preview",outputId:"saved-output"}]});
 const invoke=vi.fn(async(name:string,input:any)=>({ok:true,result:name==="task:readOutput" ? {text:input.offset ? "second page" : "first page",offset:input.offset,nextOffset:input.offset ? null : 12000,totalChars:15000} : {prompts:[]}}));window.pih!.invoke=invoke;
 render(<TranscriptView/>);fireEvent.click(screen.getByRole("button",{name:/已完成/}));fireEvent.click(screen.getByRole("button",{name:/read.*完成/}));fireEvent.click(screen.getByRole("button",{name:"查看完整输出"}));
 await screen.findByText("first page");fireEvent.click(screen.getByRole("button",{name:"下一页"}));await screen.findByText("second page");
 expect(invoke.mock.calls.filter(([name])=>name==="task:readOutput").map(([,input])=>input.offset)).toEqual([0,12000]);
 expect(invoke.mock.calls.some(([name])=>name==="task:prompt")).toBe(false);
});
it("sends immutable session references and shows their provenance", async()=>{
 const ref={id:"ref",sourceTaskId:"source",title:"之前的工作",capturedAt:100,text:"助手：已完成",omittedMessages:0,truncated:false};
 useStore.setState({tasks:[{id:"source",title:"之前的工作",mode:"single",status:"done",createdAt:100,updatedAt:100} as any]});
 const invoke=vi.fn(async(name:string)=>({ok:true,result:name==="task:captureReference" ? ref : name==="task:prompt" ? {accepted:true} : {prompts:[]}}));window.pih!.invoke=invoke;
 render(<InputBar/>);fireEvent.click(screen.getByRole("button",{name:"引用会话"}));fireEvent.click(screen.getByRole("button",{name:"之前的工作"}));await screen.findByRole("button",{name:"移除引用 之前的工作"});
 const textbox=screen.getByRole("textbox");fireEvent.change(textbox,{target:{value:"对比一下"}});fireEvent.keyDown(textbox,{key:"Enter"});
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith("task:prompt",expect.objectContaining({taskId:"t",text:"对比一下",referenceIds:["ref"]})));
 expect(useStore.getState().transcript[0]?.references).toEqual([ref]);
});
it("shows compaction activity and clears the old percentage after successful compaction",async()=>{
 useStore.setState({taskStatus:"done",contextInfo:{source:"estimate",currentTokens:8000,percent:80,lastRequestTokens:12000,cacheRead:1000}});
 expect(useStore.getState().contextInfo?.percent).toBe(80);
 act(()=>dispatchAppEvent({type:"task:phase",ts:1,payload:{taskId:"t",phase:"compaction_start",detail:"上下文压缩开始"}}));
 expect(useStore.getState().contextInfo?.compacting).toBe(true);
 window.pih!.invoke=vi.fn(async()=>({ok:true,result:{source:"unknown",currentTokens:null,percent:null,lastRequestTokens:12000,lastCompactedAt:100,compacting:false}}));
 act(()=>dispatchAppEvent({type:"task:phase",ts:2,payload:{taskId:"t",phase:"compaction_end",detail:"上下文压缩完成"}}));
 await waitFor(()=>expect(useStore.getState().contextInfo?.percent).toBeNull());
 expect(useStore.getState().contextInfo?.lastCompactedAt).toBe(100);
});

it("creates a branch directly at the chosen AI reply beside copy",async()=>{
 useStore.setState({transcript:[{id:"u",role:"user",text:"请求"},{id:"a",entryId:"reply-node",role:"assistant",text:"回答"}],taskStatus:"done"});
 const bridge=vi.mocked(window.pih!.invoke);
 bridge.mockImplementation(async(name,input)=>({ok:true,result:name === "task:fork" ? {id:"fork"} : name === "task:list" ? {tasks:[]} : name === "task:get" ? {task:{id:"fork",status:"draft"},transcript:[]} : {prompts:[]}}));
 render(<TranscriptView/>);
 const button=screen.getByRole("button",{name:"创建分支"});
 expect(button.parentElement?.textContent).toContain("复制");
 fireEvent.click(button);
 await waitFor(()=>expect(bridge).toHaveBeenCalledWith("task:fork",{taskId:"t",entryId:"reply-node"}));
 await waitFor(()=>expect(useStore.getState().currentTaskId).toBe("fork"));
});
it("uses a single file picker for both text and image attachments",async()=>{
 const {container}=render(<InputBar/>);
 expect(screen.queryByRole("button",{name:/图片/})).toBeNull();
 expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
 const file=new File(["hello"],"note.txt",{type:"text/plain"});
 Object.defineProperty(file,"text",{value:async()=>"hello"});
 const image=new File(["picture"],"photo.png",{type:"image/png"});
 fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[file,image]}});
 await waitFor(()=>expect(screen.getByText("note.txt")).toBeTruthy());
 expect(screen.getByText("photo.png")).toBeTruthy();
});

it("shows real compaction activity instead of generic model waiting and exposes stop even after a completed turn",async()=>{
 useStore.setState({taskStatus:"done",contextInfo:{compacting:true,compactionStartedAt:Date.now()-32000}});
 render(<><TranscriptView/><InputBar/></>);
 expect(screen.getByText("正在整理上下文")).toBeTruthy();
 expect(screen.getByText("摘要模型仍在处理，可点击停止取消")).toBeTruthy();
 expect(screen.queryByText("等待模型响应")).toBeNull();
 fireEvent.click(screen.getByText("停止"));
 await waitFor(()=>expect(window.pih!.invoke).toHaveBeenCalledWith("task:abort",{taskId:"t"}));
 act(()=>useStore.setState({contextInfo:{compacting:false}}));
 expect(screen.queryByText("正在整理上下文")).toBeNull();
});

it("collapses all thinking and tools into one duration row, keeps the answer visible and automatically closes on completion",()=>{
 useStore.setState({taskStatus:"running",transcript:[{id:"u",role:"user",text:"检查",timestamp:1000},{id:"a",role:"assistant",thinking:"先检查",toolCalls:[{id:"c",name:"read",args:{path:"a"}}]},{id:"r",role:"toolResult",toolCallId:"c",toolName:"read",text:"结果"},{id:"b",role:"assistant",thinking:"再核验",text:"最终结论"}],runProgress:{taskId:"t",runId:"r",stage:"response",startedAt:1000,updatedAt:13000,elapsedMs:12000,stages:[]}});
 render(<TranscriptView/>);
 expect(screen.getByText("先检查")).toBeTruthy();expect(screen.getByText("再核验")).toBeTruthy();
 act(()=>useStore.setState({taskStatus:"done",runProgress:{...useStore.getState().runProgress!,stage:"complete",elapsedMs:12000}}));
 expect(screen.getByRole("button",{name:"已完成，用时 12 秒"}).getAttribute("aria-expanded")).toBe("false");
 expect(screen.queryByText("先检查")).toBeNull();expect(screen.queryByText("再核验")).toBeNull();expect(screen.getByText("最终结论")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"已完成，用时 12 秒"}));expect(screen.getByText("先检查")).toBeTruthy();expect(screen.getByText("再核验")).toBeTruthy();
});
