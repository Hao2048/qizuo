import {act,cleanup,render,screen} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import ChatPanel from "./panels/ChatPanel.js";
import {useStore} from "./store.js";
vi.mock("./components/MemoryNoticeLink.js",()=>({default:()=>null}));
vi.mock("./components/RoleChangeDialog.js",()=>({TaskRoleControls:()=>null}));
vi.mock("./components/TranscriptView.js",()=>({default:()=> <div>对话内容</div>}));
vi.mock("./components/InputBar.js",()=>({default:()=>null}));
vi.mock("./components/AgentPanel.js",()=>({default:()=>null}));
vi.mock("./components/PlanBar.js",()=>({default:()=>null}));
vi.mock("./components/RoleContextBar.js",()=>({default:()=>null}));
vi.mock("./panels/GitPanel.js",()=>({default:()=>null}));
vi.mock("./panels/MarketDetailHelpers.js",()=>({WorkspacePanel:()=>null}));
afterEach(()=>{cleanup();useStore.getState().resetConversation();});
it("keeps delivery details out of ordinary chat through repeated turns and task switches",()=>{
 useStore.setState({currentTaskId:"a",taskStatus:"done"});render(<ChatPanel/>);
 expect(screen.getByText("对话内容")).toBeTruthy();
 expect(screen.queryAllByText(/^完成条件与交付证据/)).toHaveLength(0);
 for(let round=0;round<6;round++)for(const status of ["running","done"] as const){
  act(()=>useStore.setState({currentTaskId:round%2?"a":"b",taskStatus:status,completion:status==="done"?{checkedAt:round,outcome:"reply_ended",issues:[]}:null}));
  expect(screen.queryAllByText(/^完成条件与交付证据/)).toHaveLength(0);
 }
});
it("never accumulates duplicate panels while the conversation updates",()=>{
 const errors=vi.spyOn(console,"error").mockImplementation(()=>{});
 try {
  useStore.setState({currentTaskId:"a",taskStatus:"done"});render(<ChatPanel/>);
  for(let round=0;round<6;round++){
   act(()=>useStore.setState({currentTaskId:round%2?"a":"b",taskStatus:"running",completion:null}));
   act(()=>useStore.setState({taskStatus:"done",completion:{checkedAt:round,outcome:"reply_ended",issues:[]}}));
  }
  expect(screen.queryAllByText(/^完成条件与交付证据/).length).toBeLessThanOrEqual(1);
  expect(errors.mock.calls.filter(args=>args.some(arg=>String(arg).includes("same key")))).toHaveLength(0);
 } finally {errors.mockRestore();}
});
