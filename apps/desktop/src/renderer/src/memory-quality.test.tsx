import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { MemoryReview } from "./components/MemoryQuality.js";
import MemoryDetail from "./panels/MemoryDetail.js";
import MemoryNoticeLink from "./components/MemoryNoticeLink.js";
import { useStore } from "./store.js";
import { dispatchAppEvent } from "./events.js";
import { invoke } from "./api.js";
import type { MemoryInfo } from "@pi-harness/contracts";
vi.mock("./api.js", () => ({ invoke: vi.fn() }));
vi.mock("./data.js", () => ({
  refreshRoles: vi.fn().mockResolvedValue(undefined),
  refreshMemories: vi.fn().mockResolvedValue(undefined),
  openTask: vi.fn(),
  refreshContext: vi.fn(),
  refreshTaskList: vi.fn(),
}));
const memory = (
  id: string,
  verification: "pending" | "confirmed" = "pending",
): MemoryInfo => ({
  id,
  scopeType: "role",
  scopeId: "r",
  scopeLabel: "工程师",
  title: id,
  content: "独立的页面操作方法",
  summary: "",
  tags: [],
  status: "active",
  version: 3,
  createdAt: 1,
  updatedAt: 1,
  quality: {
    category: "experience",
    appliesTo: "修改页面前",
    projectId: null,
    verification,
    source: "agent",
    evidence: "模型声明通过",
    note: "尚未核对",
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    roles: [],
    projects: [],
    memories: [],
    memoryScope: "role",
    memoryRoleId: "r",
    memoryStatus: "active",
    memoryVerification: "all",
    memoryQuery: "",
    selectedMemoryId: null,
    notice: null,
    currentTaskId: "t",
  });
  vi.mocked(invoke).mockImplementation(async (name) =>
    name === "memory:history"
      ? ({ versions: [] } as never)
      : name === "memory:conflicts"
        ? ({ items: [] } as never)
        : ({} as never),
  );
});
afterEach(cleanup);
function confirm() {
  fireEvent.change(screen.getByLabelText("核对依据或不采纳原因"), {
    target: { value: "已对照浏览器预览核对" },
  });
  fireEvent.click(screen.getByLabelText("我已核对内容、来源和适用条件"));
}
it("确认前要求加载相关记忆、填写依据并勾选，提交当前候选与版本", async () => {
  const done = vi.fn().mockResolvedValue(undefined);
  render(<MemoryReview memory={memory("candidate")} onChanged={done} />);
  await waitFor(() =>
    expect(screen.queryByText("正在核对相关记录…")).toBeNull(),
  );
  expect(
    (screen.getByRole("button", { name: "确认采用" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  confirm();
  fireEvent.click(screen.getByRole("button", { name: "确认采用" }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledWith("memory:review", {
    memoryId: "candidate",
    expectedVersion: 3,
    decision: "accept",
    conflicts: [],
    evidence: "已对照浏览器预览核对",
  });
});
it("同主题候选并排显示原记录，替换必须绑定所有相关记忆版本", async () => {
  vi.mocked(invoke).mockResolvedValue({
    items: [memory("原方法", "confirmed")],
  } as never);
  render(
    <MemoryReview memory={memory("candidate")} onChanged={async () => {}} />,
  );
  await screen.findByText("原方法");
  expect(screen.queryByRole("button", { name: "确认采用" })).toBeNull();
  confirm();
  fireEvent.click(screen.getByRole("button", { name: "确认替换旧记录" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "memory:review",
      expect.objectContaining({
        decision: "replace",
        conflicts: [{ id: "原方法", version: 3 }],
      }),
    ),
  );
});
it("过期确认报错后不会关闭或自动重试，必须重新核对", async () => {
  vi.mocked(invoke).mockImplementation(async (name) => {
    if (name === "memory:review") throw Error("相关记忆已变更");
    return { items: [] } as never;
  });
  const done = vi.fn();
  render(<MemoryReview memory={memory("candidate")} onChanged={done} />);
  await waitFor(() =>
    expect(screen.queryByText("正在核对相关记录…")).toBeNull(),
  );
  confirm();
  fireEvent.click(screen.getByRole("button", { name: "确认采用" }));
  await screen.findByRole("alert");
  expect(done).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("button", { name: "确认采用" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重新核对" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(
    (screen.getByLabelText("我已核对内容、来源和适用条件") as HTMLInputElement)
      .checked,
  ).toBe(false);
});
it("切换候选时忽略前一条的晚到响应，不能混用别的角色冲突条目", async () => {
  let resolve!: (r: unknown) => void;
  vi.mocked(invoke).mockImplementation(async (_name, payload) => {
    if ((payload as { memoryId: string }).memoryId === "a")
      return (await new Promise<unknown>((r) => {
        resolve = r;
      })) as never;
    return { items: [] } as never;
  });
  const view = render(
    <MemoryReview memory={memory("a")} onChanged={async () => {}} />,
  );
  view.rerender(
    <MemoryReview memory={memory("b")} onChanged={async () => {}} />,
  );
  await waitFor(() =>
    expect(screen.queryByText("正在核对相关记录…")).toBeNull(),
  );
  await act(async () => resolve({ items: [memory("旧角色私有经验")] }));
  expect(screen.queryByText("旧角色私有经验")).toBeNull();
});
it("不采纳只处理候选，传递核对依据而不删除原有效记录", async () => {
  render(
    <MemoryReview memory={memory("candidate")} onChanged={async () => {}} />,
  );
  await waitFor(() =>
    expect(screen.queryByText("正在核对相关记录…")).toBeNull(),
  );
  confirm();
  fireEvent.click(screen.getByRole("button", { name: "不采纳" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "memory:review",
      expect.objectContaining({ memoryId: "candidate", decision: "discard" }),
    ),
  );
});
it("页面可筛选待核对记录，来源删除时显示标识且不开放来源按钮", async () => {
  useStore.setState({
    memories: [
      {
        ...memory("已删来源的候选"),
        sourceTaskId: "gone",
        sourceDeleted: true,
      },
      memory("已确认", "confirmed"),
      { ...memory("其他角色"), scopeId: "other" },
    ],
  });
  render(<MemoryDetail />);
  fireEvent.change(screen.getByLabelText("验证状态筛选"), {
    target: { value: "pending" },
  });
  expect(screen.queryByText("其他角色")).toBeNull();
  expect(screen.queryByRole("heading", { name: "已确认" })).toBeNull();
  expect(screen.getByText("原任务已删除")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /查看来源任务/ })).toBeNull();
  expect(screen.getByText("模型提供的依据（未验证）")).toBeTruthy();
});
it("后台任务的候选通知不覆盖当前对话，当前通知可直达对应角色记忆", () => {
  dispatchAppEvent({
    type: "memory:changed",
    payload: {
      taskId: "other",
      scopeId: "r",
      memoryId: "m",
      message: "已记录候选",
    },
  } as never);
  expect(useStore.getState().notice).toBeNull();
  dispatchAppEvent({
    type: "memory:changed",
    payload: {
      taskId: "t",
      scopeId: "r",
      memoryId: "m",
      message: "已记录候选",
    },
  } as never);
  render(<MemoryNoticeLink />);
  fireEvent.click(screen.getByRole("button", { name: "查看记忆" }));
  expect(useStore.getState()).toMatchObject({
    page: "memory",
    memoryRoleId: "r",
    selectedMemoryId: "m",
    memoryStatus: "active",
    notice: null,
  });
});
