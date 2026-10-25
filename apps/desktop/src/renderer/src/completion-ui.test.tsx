import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import type { TaskCompletion } from "@pi-harness/contracts";
import CompletionNotice from "./components/CompletionNotice.js";
import { useStore } from "./store.js";
import { dispatchAppEvent } from "./events.js";
import { openTask } from "./data.js";
const receipt:TaskCompletion={checkedAt:1,outcome:"needs_attention",issues:[{code:"plan_pending",message:"本轮计划仍有 1 项未完成，请核对实际结果。"}]};
let bridge:Mock<(name:string,input?:unknown)=>Promise<unknown>>;
beforeEach(()=>{
 useStore.getState().resetConversation();useStore.setState({currentTaskId:"a"});
 bridge=vi.fn(async(name:string,input?:unknown)=>({ok:true,result:name==="task:get"?{task:{id:(input as {taskId:string})?.taskId,status:"done",completion:receipt},transcript:[]}:{tasks:[]}}));
 window.pih={invoke:bridge,onEvent:()=>()=>{},platform:"darwin",versions:{electron:"",chrome:""}};
});
afterEach(()=>{cleanup();useStore.getState().resetConversation();delete window.pih;vi.restoreAllMocks();});
it("persists a collapsed passive notice and viewing it sends no model or tool request",()=>{
 act(()=>dispatchAppEvent({type:"task:state",ts:1,payload:{taskId:"a",status:"done",completion:receipt}}));
 const {container}=render(<CompletionNotice/>);const details=container.querySelector("details")!;
 expect(details.open).toBe(false);const count=bridge.mock.calls.length;
 fireEvent.click(screen.getByText(/本轮回复已结束/));expect(details.open).toBe(true);expect(screen.getByText(/计划仍有/)).toBeTruthy();expect(bridge.mock.calls.length).toBe(count);
});
it("isolates other tasks, clears old receipts on new turns and never presents stopped/error replies as completed",()=>{
 useStore.setState({taskStatus:"running"});render(<CompletionNotice/>);
 act(()=>dispatchAppEvent({type:"task:state",ts:1,payload:{taskId:"other",status:"done",completion:receipt}}));expect(useStore.getState().completion).toBeNull();
 act(()=>dispatchAppEvent({type:"task:state",ts:2,payload:{taskId:"a",status:"done",completion:receipt}}));expect(screen.getByText(/本轮回复已结束/)).toBeTruthy();
 for(const status of ["running","error","cancelled"] as const){act(()=>dispatchAppEvent({type:"task:state",ts:3,payload:{taskId:"a",status}}));expect(useStore.getState().completion).toBeNull();expect(screen.queryByText(/本轮回复已结束/)).toBeNull();}
});
it("restores receipts when opening a task and does not leak them when switching",async()=>{
 await act(()=>openTask("a"));expect(useStore.getState().completion).toEqual(receipt);
 bridge.mockImplementation(async(name:string,input?:unknown)=>({ok:true,result:name==="task:get"?{task:{id:(input as {taskId:string})?.taskId,status:"done"},transcript:[]}:{tasks:[]}}));
 await act(()=>openTask("legacy"));expect(useStore.getState().completion).toBeNull();
});
it("does not flash a stale persisted receipt if a running event arrives during hydration",async()=>{
 let resolve!:(value:unknown)=>void;
 bridge.mockImplementation(()=>new Promise(r=>{resolve=r;}));
 const loading=openTask("a");act(()=>dispatchAppEvent({type:"task:state",ts:2,payload:{taskId:"a",status:"running"}}));
 resolve({ok:true,result:{task:{id:"a",status:"done",completion:receipt},transcript:[]}});await loading;
 expect(useStore.getState().taskStatus).toBe("running");expect(useStore.getState().completion).toBeNull();
});
it("clean replies show no warning and switching receipts resets expansion",()=>{
 useStore.setState({taskStatus:"done",completion:receipt});const {container}=render(<CompletionNotice/>);
 fireEvent.click(screen.getByText(/本轮回复已结束/));expect(container.querySelector("details")?.open).toBe(true);
 act(()=>useStore.setState({completion:{...receipt,checkedAt:2}}));expect(container.querySelector("details")?.open).toBe(false);
 act(()=>useStore.setState({completion:{checkedAt:3,outcome:"reply_ended",issues:[]}}));expect(container.querySelector("details")).toBeNull();
});
