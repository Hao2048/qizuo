import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import GitPanel from "./panels/GitPanel.js";
import WorkbenchContext from "./panels/WorkbenchContext.js";
import { useStore } from "./store.js";
import { dispatchAppEvent } from "./events.js";
import type { PiHBridge } from "./api.js";
import type { GitStatus } from "@pi-harness/contracts";
const state:GitStatus={available:true,repository:true,root:"/project",branch:"main",head:"a".repeat(40),files:[{path:"agent.ts",status:" M",staged:false,tracked:true,conflicted:false},{path:"user.ts",status:"M ",staged:true,tracked:true,conflicted:false}],branches:["main"],commits:[]};
beforeEach(()=>{useStore.getState().resetConversation();useStore.setState({currentTaskId:"one",taskStatus:"done",tasks:[],projects:[]});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();useStore.getState().resetConversation();useStore.setState({currentTaskId:null});});
function bridge(override?:(name:string,payload:any)=>unknown){
 const listeners=new Set<(e:unknown)=>void>();
 const invoke=vi.fn(async(name:string,payload:any)=>{
 const replacement=override?.(name,payload);if(replacement!==undefined)return {ok:true,result:await replacement};
 const defaults:Record<string,unknown>={"git:status":state,"git:diff":{text:"-before\n+after",version:"v1",truncated:false},"git:mutate":{...state,files:[]},"task:delete":{ok:true},"task:list":{tasks:[]},"project:list":{projects:[]},"role:list":{roles:[]},"model:list":{providers:[]},"settings:get":{autoApproveTools:[]}};
 return {ok:true,result:defaults[name]};
 });window.pih={invoke,onEvent:cb=>{listeners.add(cb);return()=>{listeners.delete(cb);};},platform:"darwin",versions:{electron:"test",chrome:"test"}} satisfies PiHBridge;
 return {invoke,listeners};
}
async function open(){fireEvent.click(await screen.findByRole("button",{name:/Git · main/}));await screen.findByText("+after");}
it("commits only explicitly selected files and keeps errors visible",async()=>{
 const {invoke}=bridge();render(<GitPanel/>);await open();fireEvent.click(screen.getByRole("checkbox",{name:"选择 agent.ts"}));fireEvent.change(screen.getByRole("textbox",{name:"提交说明"}),{target:{value:"Fix task"}});const commit=screen.getByRole("button",{name:"提交选中 (1)"});await waitFor(()=>expect(commit).toHaveProperty("disabled",false));fireEvent.click(commit);await waitFor(()=>expect(invoke).toHaveBeenCalledWith("git:mutate",expect.objectContaining({action:"commit",paths:["agent.ts"],message:"Fix task",version:"v1"})));
 expect(await screen.findByText("工作区没有待提交修改。")).toBeTruthy();
});
it("requires explicit undo confirmation and reports stale edits without claiming success",async()=>{
 const {invoke}=bridge(name=>name==="git:mutate"?Promise.reject(new Error("文件已变化，请刷新差异")):undefined);render(<GitPanel/>);await open();fireEvent.click(screen.getByRole("checkbox",{name:"选择 agent.ts"}));const undo=screen.getByRole("button",{name:"撤销选中修改"});await waitFor(()=>expect(undo).toHaveProperty("disabled",false));fireEvent.click(undo);expect(invoke.mock.calls.some(([name])=>name==="git:mutate")).toBe(false);fireEvent.click(screen.getByRole("button",{name:"确认撤销"}));expect(await screen.findByRole("alert")).toHaveProperty("textContent","文件已变化，请刷新差异");expect(screen.getByRole("checkbox",{name:"选择 agent.ts"})).toHaveProperty("checked",true);
});
it("allows viewing while running but disables destructive version operations",async()=>{
 bridge();useStore.setState({taskStatus:"running"});render(<GitPanel/>);await open();fireEvent.click(screen.getByRole("checkbox",{name:"选择 agent.ts"}));expect(screen.getByRole("button",{name:"撤销选中修改"})).toHaveProperty("disabled",true);expect(screen.getByRole("button",{name:"暂存选中"})).toHaveProperty("disabled",true);expect(screen.getByText(/任务执行中可查看差异/)).toBeTruthy();
});
it("shows the actual unavailable Git state and releases its event listener on unmount",async()=>{
 const {listeners}=bridge(name=>name==="git:status"?{...state,available:false,repository:false,branch:null,files:[],message:"未找到本机 Git"}:undefined);const view=render(<GitPanel/>);fireEvent.click(screen.getByRole("button",{name:"Git"}));expect(await screen.findByText("未找到本机 Git")).toBeTruthy();expect(screen.queryByRole("button",{name:"初始化项目 Git"})).toBeNull();expect(listeners.size).toBe(1);view.unmount();expect(listeners.size).toBe(0);expect(screen.queryByRole("complementary",{name:"Git 项目版本"})).toBeNull();
});
it("deleting a chat removes it from the list and clears current conversation state",async()=>{
 let rows:any[]=[{id:"one",title:"待删除会话",status:"done",mode:"single",projectId:null}];
 const {invoke}=bridge(name=>name==="task:list"?{tasks:rows}:name==="task:delete"?(rows=[],{ok:true}):undefined);useStore.setState({tasks:rows,transcript:[{id:"m",role:"assistant",text:"内容"}]});render(<WorkbenchContext/>);fireEvent.click(await screen.findByRole("button",{name:"删除会话 待删除会话"}));const confirm=screen.getByRole("group",{name:"确认删除 待删除会话"});expect(within(confirm).getByText(/Git 提交和分支会保留/)).toBeTruthy();fireEvent.click(within(confirm).getByRole("button",{name:"确认删除会话"}));await waitFor(()=>expect(invoke).toHaveBeenCalledWith("task:delete",{taskId:"one"}));await waitFor(()=>expect(useStore.getState().currentTaskId).toBeNull());expect(useStore.getState().transcript).toEqual([]);expect(useStore.getState().tasks).toEqual([]);
});
it("deletion events for other chats preserve the active conversation",()=>{
 bridge();useStore.setState({transcript:[{id:"m",role:"assistant",text:"保留"}]});dispatchAppEvent({type:"task:deleted",ts:1,payload:{taskId:"other"}});expect(useStore.getState().currentTaskId).toBe("one");expect(useStore.getState().transcript[0]?.text).toBe("保留");dispatchAppEvent({type:"task:deleted",ts:2,payload:{taskId:"one"}});expect(useStore.getState().currentTaskId).toBeNull();expect(useStore.getState().transcript).toEqual([]);
});
