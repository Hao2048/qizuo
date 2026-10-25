import InputBar from "./components/InputBar.js";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  fireEvent,
  screen,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import {
  ToWorkbenchButton,
  SingleRoleDialog,
} from "./components/ConversationBridge.js";
import { useStore } from "./store.js";
import { invoke } from "./api.js";
import { openTask } from "./data.js";
import { selectWorkbench } from "./workbench-data.js";
import type { Workbench } from "@pi-harness/contracts";
vi.mock("./api.js", () => ({ invoke: vi.fn() }));
vi.mock("./data.js", () => ({
  openTask: vi.fn().mockResolvedValue(undefined),
  refreshTaskList: vi.fn().mockResolvedValue(undefined),
  refreshPrompts: vi.fn().mockResolvedValue(undefined),
  refreshContext: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./workbench-data.js", () => ({
  selectWorkbench: vi.fn().mockResolvedValue(undefined),
  updateWorkbenchView: vi.fn(),
}));
const w: Workbench = {
  id: "w",
  title: "官网",
  projectId: "project",
  phase: "draft",
  revision: 1,
  participants: [],
  messages: [],
  contracts: [],
  proposals: [],
  recommendations: [],
  createdAt: 1,
  updatedAt: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    currentTaskId: "source",
    pendingCompose: null,
    roles: [
      {
        id: "front",
        name: "前端工程师",
        intro: "页面",
        systemPrompt: "PRIVATE",
        isDefault: false,
        status: "active",
        boundSkills: [],
        boundPlugins: [],
        memoryCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    tasks: [
      {
        id: "source",
        title: "原对话",
        status: "done",
        mode: "single",
        roleId: "front",
      } as any,
    ],
  });
  vi.mocked(invoke).mockResolvedValue({ id: "new" } as never);
});
afterEach(cleanup);
it("回复转入前展示可编辑摘要，确认后只传入明确字段，不发起执行", async () => {
  render(
    <div className="msg-actions">
      <ToWorkbenchButton entryId="reply" text="已完成界面讨论" />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "转入工作台" }));
  expect(
    (
      screen.getByRole("button", {
        name: "创建工作台草稿",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByRole("dialog").closest(".msg-actions")).toBeNull();
  fireEvent.change(screen.getByLabelText("交接摘要"), {
    target: { value: "确认交接的范围" },
  });
  fireEvent.click(screen.getByLabelText("我已核对交接摘要和参与角色"));
  fireEvent.click(screen.getByRole("button", { name: "创建工作台草稿" }));
  await waitFor(() => expect(selectWorkbench).toHaveBeenCalledWith("new"));
  expect(invoke).toHaveBeenCalledWith(
    "workbench:fromConversation",
    expect.objectContaining({
      taskId: "source",
      entryId: "reply",
      summary: "确认交接的范围",
      roleIds: ["front"],
      confirmed: true,
    }),
  );
  expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain("PRIVATE");
  expect(invoke).not.toHaveBeenCalledWith("workbench:send", expect.anything());
});
it("取消转入无副作用，修改摘要会撤去原确认", () => {
  render(<ToWorkbenchButton entryId="reply" text="内容" />);
  fireEvent.click(screen.getByRole("button", { name: "转入工作台" }));
  fireEvent.click(screen.getByLabelText("我已核对交接摘要和参与角色"));
  fireEvent.change(screen.getByLabelText("交接摘要"), {
    target: { value: "changed" },
  });
  expect(
    (
      screen.getByRole("button", {
        name: "创建工作台草稿",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(invoke).not.toHaveBeenCalled();
});
it("单角色入口只带入主动选择的附件与文字，保留源工作台，不自动发送", async () => {
  vi.mocked(invoke).mockImplementation(async (name) =>
    name === "workbench:readAttachment"
      ? ({
          attachment: {
            kind: "text",
            name: "说明.txt",
            mimeType: "text/plain",
          },
          data: btoa("reference"),
        } as never)
      : ({ id: "chat" } as never),
  );
  render(
    <SingleRoleDialog
      w={w}
      roleId="front"
      text="继续制作页面"
      files={[
        {
          id: "f",
          name: "说明.txt",
          kind: "text",
          mimeType: "text/plain",
          bytes: 9,
        },
      ]}
      onClose={() => {}}
    />,
  );
  expect(screen.getByLabelText("说明.txt")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("说明.txt"));
  fireEvent.click(screen.getByLabelText("我已核对要求、角色和附件范围"));
  fireEvent.click(screen.getByRole("button", { name: "打开单角色对话" }));
  await waitFor(() => expect(openTask).toHaveBeenCalledWith("chat"));
  expect(useStore.getState().pendingCompose).toMatchObject({
    taskId: "chat",
    text: "继续制作页面",
    attachments: [{ name: "说明.txt", data: "reference" }],
  });
  expect(invoke).not.toHaveBeenCalledWith("task:prompt", expect.anything());
  expect(invoke).not.toHaveBeenCalledWith(
    "workbench:delete",
    expect.anything(),
  );
});
it("附件读取失败不创建空会话，保留弹窗和输入可重试", async () => {
  vi.mocked(invoke).mockRejectedValue(Error("附件读取失败"));
  render(
    <SingleRoleDialog
      w={w}
      roleId="front"
      text="原要求"
      files={[
        {
          id: "f",
          name: "参考.txt",
          kind: "text",
          mimeType: "text/plain",
          bytes: 1,
        },
      ]}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByLabelText("参考.txt"));
  fireEvent.click(screen.getByLabelText("我已核对要求、角色和附件范围"));
  fireEvent.click(screen.getByRole("button", { name: "打开单角色对话" }));
  await screen.findByRole("alert");
  expect(invoke).not.toHaveBeenCalledWith("task:create", expect.anything());
  expect(
    (screen.getByLabelText("带入的要求") as HTMLTextAreaElement).value,
  ).toBe("原要求");
});
it("源界面离开后晚到创建结果不会抢走当前任务", async () => {
  let resolve!: (v: unknown) => void;
  vi.mocked(invoke).mockImplementation(
    async () =>
      (await new Promise<unknown>((r) => {
        resolve = r;
      })) as never,
  );
  const view = render(<ToWorkbenchButton entryId="reply" text="内容" />);
  fireEvent.click(screen.getByRole("button", { name: "转入工作台" }));
  fireEvent.click(screen.getByLabelText("我已核对交接摘要和参与角色"));
  fireEvent.click(screen.getByRole("button", { name: "创建工作台草稿" }));
  expect(
    (screen.getByLabelText("交接摘要") as HTMLTextAreaElement).disabled,
  ).toBe(true);
  view.unmount();
  await act(async () => resolve({ id: "created" }));
  expect(selectWorkbench).not.toHaveBeenCalled();
});

it("转入草稿只在目标会话消费，切换到其他角色不会带入内容或自动发送", async () => {
  useStore.setState({
    pendingCompose: {
      taskId: "target",
      text: "仅给前端的确认要求",
      attachments: [],
    },
    currentTaskId: "source",
    taskStatus: "draft",
    prompts: [],
  });
  render(<InputBar />);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  expect(useStore.getState().pendingCompose).not.toBeNull();
  act(() => useStore.setState({ currentTaskId: "target" }));
  await waitFor(() =>
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "仅给前端的确认要求",
    ),
  );
  expect(useStore.getState().pendingCompose).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("task:prompt", expect.anything());
});
