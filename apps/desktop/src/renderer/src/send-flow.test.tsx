import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import InputBar from "./components/InputBar.js";
import TranscriptView from "./components/TranscriptView.js";
import { useStore } from "./store.js";
import { dispatchAppEvent } from "./events.js";
let bridge: Mock<(name:string,payload?:unknown)=>Promise<unknown>>;
beforeEach(()=>{
 useStore.getState().resetConversation();
 useStore.setState({currentTaskId:null,draftRoleId:null,draftProjectId:null,projects:[],roles:[],providers:[],settings:null,prompts:[]});
 bridge=vi.fn(async()=>({ok:true,result:{prompts:[]}}));
 window.pih={invoke:bridge,onEvent:()=>()=>{},platform:"darwin",versions:{electron:"",chrome:""}};
});
afterEach(()=>{cleanup();useStore.getState().resetConversation();delete window.pih;vi.restoreAllMocks();});
function send(){const textarea=screen.getByPlaceholderText(/描述任务/);fireEvent.change(textarea,{target:{value:"检查项目"}});fireEvent.keyDown(textarea,{key:"Enter"});}
it("shows a new message before task creation resolves and permits stopping preparation",async()=>{
 let created!:(value:unknown)=>void;
 bridge.mockImplementation(async(name:string)=>name==="task:create" ? new Promise(resolve=>{created=resolve;}) : {ok:true,result:{prompts:[]}});
 render(<><TranscriptView/><InputBar/></>);send();
 expect(screen.getByText("检查项目")).toBeTruthy();expect(screen.getByText("正在准备会话")).toBeTruthy();
 await waitFor(()=>expect(created).toBeTypeOf("function"));
 fireEvent.click(screen.getByText("停止"));
 await act(async()=>created({ok:true,result:{id:"t"}}));
 expect(bridge.mock.calls.some(call=>call[0]==="task:prompt")).toBe(false);
 expect(screen.getByText(/发送未成功/)).toBeTruthy();expect(useStore.getState().preparingMessage).toBe(false);
});
it("preserves failed messages for editing and does not leave preparation running",async()=>{
 bridge.mockImplementation(async(name:string)=>name==="task:create" ? {ok:false,error:{message:"创建失败"}} : {ok:true,result:{prompts:[]}});
 render(<><TranscriptView/><InputBar/></>);send();
 await waitFor(()=>expect(screen.getByText(/发送未成功/)).toBeTruthy());
 fireEvent.click(screen.getByText("重新编辑"));expect((screen.getByPlaceholderText(/描述任务/) as HTMLTextAreaElement).value).toBe("检查项目");
 expect(useStore.getState().preparingMessage).toBe(false);
});
it("keeps background preparation out of the selected conversation",()=>{
 useStore.setState({currentTaskId:"selected"});
 dispatchAppEvent({type:"task:progress",ts:1,payload:{taskId:"other",runId:"r",stage:"resources",startedAt:0,updatedAt:1,elapsedMs:1,stages:[]}});
 expect(useStore.getState().runProgress).toBeNull();
});
it("loads interruption state for the selected task and clears it when switching or finishing",async()=>{
 const recovery={interruptedAt:100,previousStatus:"running" as const,stage:"response"};
 bridge.mockImplementation(async(name:string,input?:unknown)=>({ok:true,result:name==="task:get" ? {task:{id:(input as {taskId:string}).taskId,status:"cancelled",recovery},transcript:[]} : {prompts:[]}}));
 const {openTask}=await import("./data.js");
 await openTask("recovered");
 expect(useStore.getState().recovery).toEqual(recovery);
 useStore.getState().resetConversation();
 expect(useStore.getState().recovery).toBeNull();
 await openTask("recovered");
 dispatchAppEvent({type:"task:state",ts:110,payload:{taskId:"other",status:"done"}});
 expect(useStore.getState().recovery).toEqual(recovery);
 dispatchAppEvent({type:"task:state",ts:120,payload:{taskId:"recovered",status:"done"}});
 expect(useStore.getState().recovery).toBeNull();
});
it("clears the recovered model error banner when the SDK retries",()=>{
 useStore.setState({currentTaskId:"t",notice:null});
 dispatchAppEvent({type:"task:state",ts:1,payload:{taskId:"t",status:"error",detail:'502 "acp-proxy failure"'}});
 expect(useStore.getState().notice?.message).toContain("502");
 dispatchAppEvent({type:"task:state",ts:2,payload:{taskId:"t",status:"running",detail:"模型正在重试"}});
 dispatchAppEvent({type:"task:state",ts:3,payload:{taskId:"t",status:"done"}});
 expect(useStore.getState().notice).toBeNull();
 dispatchAppEvent({type:"task:state",ts:4,payload:{taskId:"t",status:"error",detail:"最终连接失败"}});
 expect(useStore.getState().notice?.message).toContain("最终连接失败");
});
