import {act,cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi,type Mock} from "vitest";
import type {CompletionReport} from "@pi-harness/contracts";
import CompletionEvidence from "./components/CompletionEvidence.js";
const receipt:CompletionReport={scope:"workbench",id:"a",assessedAt:1,token:"a".repeat(64),state:"ready_for_acceptance",conditions:[{id:"delivery",label:"文件对应当前版本",status:"passed",evidenceIds:["file"]},{id:"acceptance",label:"业务效果待确认",status:"pending",evidenceIds:[]}],evidence:[{id:"file",kind:"artifact",summary:"前端 · page.txt",path:"page.txt",hash:"f".repeat(64),status:"current"},{id:"other",kind:"execution",summary:"已结束执行",status:"current"}]};
let bridge:Mock<(name:string,input?:unknown)=>Promise<unknown>>;
beforeEach(()=>{bridge=vi.fn(async()=>({ok:true,result:receipt}));window.pih={invoke:bridge,onEvent:()=>()=>{},platform:"darwin",versions:{electron:"",chrome:""}};});
afterEach(()=>{cleanup();delete window.pih;vi.restoreAllMocks();});
async function expand(){fireEvent.click(screen.getByText(/^完成条件与交付证据/));await screen.findByText("文件对应当前版本",{exact:false});}
it("loads only when expanded, links conditions to evidence and does not execute while browsing",async()=>{
 const report=vi.fn();render(<CompletionEvidence scope="workbench" id="a" version={1} onReport={report}/>);expect(bridge).not.toHaveBeenCalled();await expand();
 expect(bridge.mock.calls).toEqual([["completion:get",{scope:"workbench",id:"a"}]]);expect(report).toHaveBeenLastCalledWith(receipt);
 fireEvent.click(screen.getByRole("button",{name:"查看 1 项证据"}));const list=screen.getByRole("list",{name:"交付证据"});expect(within(list).getByText("前端 · page.txt")).toBeTruthy();expect(within(list).queryByText("已结束执行")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"显示全部证据"}));expect(screen.getByText("已结束执行")).toBeTruthy();expect(bridge).toHaveBeenCalledTimes(1);
});
it("explicit refresh marks stale facts and never adds a confirmation or retry action",async()=>{
 const report=vi.fn();render(<CompletionEvidence scope="workbench" id="a" version={1} onReport={report}/>);await expand();
 bridge.mockResolvedValue({ok:true,result:{...receipt,state:"needs_attention",token:"b".repeat(64),evidence:[{...receipt.evidence[0],status:"stale"}]}});
 fireEvent.click(screen.getByRole("button",{name:"刷新证据"}));await waitFor(()=>expect(report.mock.lastCall?.[0].state).toBe("needs_attention"));expect(screen.getByText(/已过期/)).toBeTruthy();
 expect(bridge.mock.calls.every(c=>c[0]==="completion:get")).toBe(true);expect(screen.queryByRole("button",{name:/批准|执行|自动修复/})).toBeNull();
});
it("a late reply from a previous role/task cannot overwrite the newly selected subject",async()=>{
 let resolve!:(v:unknown)=>void;bridge.mockImplementation(()=>new Promise(r=>{resolve=r;}));
 const report=vi.fn(),view=render(<CompletionEvidence scope="workbench" id="a" version={1} onReport={report}/>);
 fireEvent.click(screen.getByText(/^完成条件/));await waitFor(()=>expect(bridge).toHaveBeenCalledTimes(1));const old=resolve;
 bridge.mockResolvedValue({ok:true,result:{...receipt,id:"b",conditions:[{id:"new",label:"B 的独立证据",status:"pending",evidenceIds:[]}]}});
 view.rerender(<CompletionEvidence scope="workbench" id="b" version={2} onReport={report}/>);fireEvent.click(screen.getByRole("button",{name:"刷新证据"}));await screen.findByText(/B 的独立证据/);
 await act(async()=>old({ok:true,result:receipt}));expect(screen.queryByText(/文件对应当前版本/)).toBeNull();expect(report.mock.lastCall?.[0].id).toBe("b");
});
it("load errors remain visible and retry is read only",async()=>{
 bridge.mockResolvedValue({ok:false,error:{message:"项目无法读取"}});render(<CompletionEvidence scope="chat" id="a" version={1}/>);fireEvent.click(screen.getByText(/^完成条件/));expect(await screen.findByRole("alert")).toHaveProperty("textContent","项目无法读取");
 bridge.mockResolvedValue({ok:true,result:receipt});fireEvent.click(screen.getByRole("button",{name:"刷新证据"}));await screen.findByText(/文件对应当前版本/);expect(screen.queryByRole("alert")).toBeNull();expect(bridge.mock.calls.every(c=>c[0]==="completion:get")).toBe(true);
});
