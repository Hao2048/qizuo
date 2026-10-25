import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import RoleChangeDialog from "./components/RoleChangeDialog.js";
import { useStore } from "./store.js";
import { invoke } from "./api.js";
vi.mock("./api.js", () => ({ invoke: vi.fn() }));
vi.mock("./data.js", () => ({
  refreshTaskList: vi.fn().mockResolvedValue(undefined),
  openTask: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./workbench-data.js", () => ({
  refreshWorkbenches: vi.fn().mockResolvedValue(undefined),
}));
const preview = {
  token: "receipt",
  kind: "sync",
  fromName: "原前端",
  toName: "原前端",
  available: true,
  changed: true,
  changes: [{ label: "角色提示词", before: "旧方式", after: "新方式" }],
  responsibility: "页面",
  ownedPaths: ["src"],
  files: [{ path: "src/home.ts", kind: "modified" }],
  contracts: ["表单接口"],
  blockedReason: null,
};
const role = (id: string, name: string) => ({
  id,
  name,
  status: "active" as const,
  intro: "",
  systemPrompt: "",
  boundSkills: [],
  boundPlugins: [],
  preferredModel: null,
  preferredThinking: null,
  isDefault: false,
  memoryCount: 0,
  createdAt: 1,
  updatedAt: 1,
});
beforeEach(() => {
  vi.resetAllMocks();
  useStore.setState({
    roles: [
      role("front", "原前端"),
      role("new", "新前端"),
      role("back", "后端"),
    ],
  });
  vi.mocked(invoke).mockResolvedValue(preview as any);
});
afterEach(cleanup);
it("requires preview, explanation and explicit confirmation before updating an existing task", async () => {
  render(
    <RoleChangeDialog
      id="wb"
      roleId="front"
      roleName="原前端"
      mode="workbench"
      onClose={() => {}}
    />,
  );
  await screen.findByText("角色提示词");
  expect(invoke).toHaveBeenCalledWith("workbench:roleChangePreview", {
    id: "wb",
    roleId: "front",
    targetRoleId: "front",
  });
  expect(
    (screen.getByRole("button", { name: "确认同步配置" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("角色变更说明"), {
    target: { value: "采用新方式，下轮生效" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认同步配置" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("workbench:applyRoleChange", {
      id: "wb",
      roleId: "front",
      targetRoleId: "front",
      token: "receipt",
      summary: "采用新方式，下轮生效",
      confirmed: true,
    }),
  );
});
it("keeps unavailable and already-participating roles out of the replacement choices", async () => {
  useStore.setState({ roles: [role("new", "新前端"), role("back", "后端")] });
  render(
    <RoleChangeDialog
      id="wb"
      roleId="front"
      roleName="原前端"
      mode="workbench"
      unavailable
      excluded={["back"]}
      onClose={() => {}}
    />,
  );
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.queryByRole("option", { name: "后端" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "new" } });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("workbench:roleChangePreview", {
      id: "wb",
      roleId: "front",
      targetRoleId: "new",
    }),
  );
});
it("rejects stale confirmation without closing or applying again automatically", async () => {
  vi.mocked(invoke).mockImplementation(async (name) => {
    if (name === "workbench:applyRoleChange")
      throw Error("成果已变化，请重新预览");
    return preview as any;
  });
  const close = vi.fn();
  render(
    <RoleChangeDialog
      id="wb"
      roleId="front"
      roleName="原前端"
      mode="workbench"
      onClose={close}
    />,
  );
  await screen.findByText("角色提示词");
  fireEvent.change(screen.getByLabelText("角色变更说明"), {
    target: { value: "确认" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认同步配置" }));
  await screen.findByText("Error: 成果已变化，请重新预览");
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
    false,
  );
  expect(invoke).toHaveBeenCalledTimes(2);
});
it("shows blockers and does not submit when cancelling a role replacement", async () => {
  vi.mocked(invoke).mockResolvedValue({
    ...preview,
    kind: "handover",
    toName: "新前端",
    blockedReason: "请先停止当前执行",
  } as any);
  const close = vi.fn();
  render(
    <RoleChangeDialog
      id="wb"
      roleId="front"
      roleName="原前端"
      mode="workbench"
      onClose={close}
    />,
  );
  await screen.findByText("请先停止当前执行");
  expect(
    (screen.getByRole("button", { name: "确认职责交接" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(close).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalledWith(
    "workbench:applyRoleChange",
    expect.anything(),
  );
});
