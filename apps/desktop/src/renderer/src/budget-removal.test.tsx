import {afterEach,expect,it,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor} from "@testing-library/react";
import SettingsDetail from "./panels/SettingsDetail.js";
import {useStore} from "./store.js";
import {invoke} from "./api.js";
vi.mock("./api.js",()=>({invoke:vi.fn().mockResolvedValue({}),bridge:()=>null}));
vi.mock("./data.js",()=>({refreshStaticData:vi.fn().mockResolvedValue(undefined)}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it("only exposes concurrency settings and preserves tool approval settings on save",async()=>{
 useStore.setState({settingsSection:"approval",settings:{autoApproveTools:["read"],permissionMode:"ask",sandboxMode:"off",agentLimits:{maxConcurrent:2,maxMembers:5}},loginEvent:null});
 render(<SettingsDetail/>);
 expect(screen.queryByText(/预算|单轮.*时长|单轮.*调用/)).toBeNull();
 expect(screen.getByRole("heading",{name:"协作并发"})).toBeTruthy();
 fireEvent.change(screen.getByLabelText("同时运行的成员"),{target:{value:"1"}});
 fireEvent.click(screen.getByRole("button",{name:"保存并发设置"}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith("settings:set",expect.objectContaining({autoApproveTools:["read"],permissionMode:"ask",agentLimits:{maxConcurrent:1,maxMembers:5}})));
});
