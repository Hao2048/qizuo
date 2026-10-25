import { useCollaboration } from "./workbench-data.js";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import type { Workbench } from "@pi-harness/contracts";
import {
  WorkbenchPermissions,
  WorkbenchVerification,
} from "./panels/WorkbenchExecution.js";
import { invoke } from "./api.js";
vi.mock("./api.js", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  useCollaboration.setState({ views: {} });
  vi.resetAllMocks();
});
const w: Workbench = {
  id: "wb",
  title: "任务",
  projectId: null,
  phase: "ready_verify",
  revision: 1,
  participants: [
    {
      roleId: "front",
      name: "前端",
      enabled: true,
      status: "applied",
      taskId: "task-front",
      responsibility: "界面",
    },
  ],
  messages: [],
  recommendations: [],
  contracts: [],
  proposals: [],
  createdAt: 0,
  updatedAt: 0,
};
const action = async (fn: () => Promise<unknown>) => {
  await fn();
};
it("authorizes one role without exposing local or disabled plugin processes", async () => {
  vi.mocked(invoke).mockResolvedValue({
    servers: [
      {
        name: "github",
        enabled: true,
        kind: "http",
        url: "https://fixture.example/mcp",
      },
      { name: "local", enabled: true, kind: "stdio" },
      {
        name: "disabled",
        enabled: false,
        kind: "http",
        url: "https://disabled.example",
      },
    ],
  } as never);
  render(<WorkbenchPermissions w={w} disabled={false} action={action} />);
  await screen.findByLabelText("允许使用 github");
  expect(screen.queryByText(/允许使用 local/)).toBeNull();
  expect(screen.queryByText(/允许使用 disabled/)).toBeNull();
  expect(
    (screen.getByLabelText(/允许命令联网/) as HTMLInputElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByLabelText("允许使用 github"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("workbench:setAccess", {
      id: "wb",
      roleId: "front",
      commands: false,
      network: false,
      servers: ["github"],
    }),
  );
});
it("requires reviewing detected commands before starting acceptance and displays failed evidence", async () => {
  vi.mocked(invoke).mockResolvedValue({
    commands: ["npm run test", "npm run build"],
    network: false,
  } as never);
  render(
    <WorkbenchVerification
      w={{
        ...w,
        verification: {
          status: "failed",
          fingerprint: "old",
          at: 0,
          steps: [
            {
              command: "npm run test",
              code: 2,
              output: "test failed",
              cancelled: false,
              durationMs: 120,
            },
          ],
        },
      }}
      disabled={false}
      action={action}
    />,
  );
  expect(
    (screen.getByText("批准步骤并开始联调") as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByText("识别项目检查步骤"));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("验收命令") as HTMLTextAreaElement).value,
    ).toBe("npm run test\nnpm run build"),
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "workbench:verify",
    expect.anything(),
  );
  fireEvent.click(screen.getByText("批准步骤并开始联调"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("workbench:verify", {
      id: "wb",
      commands: ["npm run test", "npm run build"],
      network: false,
    }),
  );
  expect(screen.getByText("自动检查失败，请查看日志")).toBeTruthy();
  expect(screen.getByText("test failed")).toBeTruthy();
});
it("keeps old roles on ask and allows changing only approval mode while execution grants are locked", async()=>{
 vi.mocked(invoke).mockResolvedValue({servers:[]} as never);
 render(<WorkbenchPermissions w={w} disabled={true} approvalDisabled={false} action={action}/>);
 const mode=screen.getByRole('combobox',{name:'前端审批模式'}) as HTMLSelectElement;
 expect(mode.value).toBe('ask');expect(mode.disabled).toBe(false);
 expect((screen.getByLabelText('允许在职责范围内运行命令') as HTMLInputElement).disabled).toBe(true);
 fireEvent.change(mode,{target:{value:'auto'}});
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('workbench:setApprovalMode',{id:'wb',roleId:'front',approvalMode:'auto'}));
 expect(invoke).not.toHaveBeenCalledWith('workbench:setAccess',expect.anything());
});
it("shows saved full allowance without treating it as a capability grant",()=>{
 vi.mocked(invoke).mockResolvedValue({servers:[]} as never);
 render(<WorkbenchPermissions w={{...w,access:[{roleId:'front',commands:false,network:false,servers:[],approvalMode:'allow'}]}} disabled={false} action={action}/>);
 expect((screen.getByRole('combobox',{name:'前端审批模式'}) as HTMLSelectElement).value).toBe('allow');
 expect((screen.getByLabelText('允许在职责范围内运行命令') as HTMLInputElement).checked).toBe(false);
});
