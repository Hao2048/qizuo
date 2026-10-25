import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import McpStatusPanel from "./components/McpStatusPanel.js";
import { invoke } from "./api.js";
vi.mock("./api.js",()=>({invoke:vi.fn()}));
vi.mock("./components/PluginAuthModal.js",()=>({PluginAuthModal:({source,onDone}:any)=><div role="dialog">{source}<button onClick={onDone}>完成</button></div>}));
let items:any[];
beforeEach(()=>{
 vi.clearAllMocks();items=[{name:"github",kind:"http",state:"required",message:"权限不足",checkedAt:null,toolCount:null},{name:"disabled",kind:"stdio",state:"disabled",message:"已停用",checkedAt:null,toolCount:null}];
 vi.mocked(invoke).mockImplementation(async(name)=>{
  if(name==="mcp:diagnostics")return {items} as any;
  if(name==="mcp:list")return {servers:[{name:"github",kind:"http",enabled:true,description:"来自官方插件 github"},{name:"disabled",kind:"stdio",enabled:false}]} as any;
  return {} as any;
 });
});
afterEach(()=>{cleanup();vi.useRealTimers();});
it("loads only snapshots, distinguishes disabled servers and routes browser authentication",async()=>{
 render(<McpStatusPanel/>);expect(await screen.findByText("权限不足")).toBeTruthy();
 expect(vi.mocked(invoke).mock.calls.some(([name])=>name==="mcp:check")).toBe(false);
 expect(screen.getByRole("button",{name:"检测连接 disabled"}).hasAttribute("disabled")).toBe(true);
 fireEvent.click(screen.getByRole("button",{name:"认证 github"}));expect(await screen.findByRole("dialog")).toHaveProperty("textContent", "claude:github完成");
 fireEvent.click(screen.getByText("完成"));expect(screen.queryByRole("dialog")).toBeNull();
});
it("checks explicitly, blocks duplicates and displays the new result",async()=>{
 let finish!:(result:any)=>void;
 vi.mocked(invoke).mockImplementation(async(name)=>name==="mcp:diagnostics" ? {items} as any : name==="mcp:list" ? {servers:[]} as any : new Promise(resolve=>{finish=resolve;}));
 render(<McpStatusPanel/>);const button=await screen.findByRole("button",{name:"检测连接 github"});fireEvent.click(button);
 expect(button.hasAttribute("disabled")).toBe(true);
 items=[{...items[0],state:"ready",message:"连接成功",toolCount:7,checkedAt:Date.now()}];await act(async()=>finish({}));
 expect(await screen.findByText("可连接")).toBeTruthy();expect(screen.getByText(/7 个工具/)).toBeTruthy();
 expect(invoke).toHaveBeenCalledWith("mcp:check",{name:"github"});
});
it("retains rows after refresh failure, ignores stale snapshots and clears polling on unmount",async()=>{
 vi.useFakeTimers();const view=render(<McpStatusPanel/>);await act(async()=>{});
 vi.mocked(invoke).mockRejectedValue(new Error("private details"));
 fireEvent.click(screen.getByText("刷新状态"));await act(async()=>{});
 expect(screen.getByRole("alert").textContent).toBe("状态读取失败，请刷新重试。");expect(screen.getByText("权限不足")).toBeTruthy();
 view.unmount();const count=vi.mocked(invoke).mock.calls.length;await act(async()=>vi.advanceTimersByTimeAsync(20_000));
 expect(vi.mocked(invoke).mock.calls.length).toBe(count);expect(vi.getTimerCount()).toBe(0);
});

it("discards an earlier snapshot that completes after a newer refresh",async()=>{
 let resolveOld!:(value:any)=>void, reads=0;
 vi.mocked(invoke).mockImplementation(async(name)=>{
  if(name==="mcp:diagnostics")return ++reads===1 ? new Promise(resolve=>{resolveOld=resolve;}) : {items:[{...items[0],state:"ready",message:"最新连接",toolCount:1}]} as any;
  return {servers:[]} as any;
 });
 render(<McpStatusPanel/>);fireEvent.click(screen.getByText("刷新状态"));
 expect(await screen.findByText("最新连接")).toBeTruthy();
 await act(async()=>resolveOld({items}));expect(screen.queryByText("权限不足")).toBeNull();
});
