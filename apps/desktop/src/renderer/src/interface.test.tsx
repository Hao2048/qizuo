import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { MemoryInfo, RoleInfo } from "@pi-harness/contracts";
import RoleDetail from "./panels/RoleDetail.js";
import MemoryDetail from "./panels/MemoryDetail.js";
import MemoryContext from "./panels/MemoryContext.js";
import { useStore } from "./store.js";
import { invoke } from "./api.js";
import { setAppearance, useAppearance } from "./appearance.js";
vi.mock("./api.js", () => ({ invoke: vi.fn() }));
vi.mock("./data.js", () => ({
  refreshRoles: vi.fn().mockResolvedValue(undefined),
  refreshBindable: vi.fn().mockResolvedValue(undefined),
  refreshMemories: vi.fn().mockResolvedValue(undefined),
  openTask: vi.fn().mockResolvedValue(undefined),
}));
const role = (id: string, name: string, isDefault = false): RoleInfo => ({
  id,
  name,
  isDefault,
  intro: "负责本角色的工作",
  systemPrompt: "角色自己的方法",
  status: "active",
  boundSkills: [],
  boundPlugins: [],
  memoryCount: 0,
  createdAt: 1,
  updatedAt: 1,
});
const memory = (id: string, owner: string): MemoryInfo => ({
  id,
  scopeType: "role",
  scopeId: owner,
  scopeLabel: owner,
  title: id,
  content: "独立角色经验",
  summary: "",
  tags: [],
  status: "active",
  version: 2,
  createdAt: 1,
  updatedAt: 1,
});
beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    selectedRoleId: "front",
    roles: [
      role("assistant", "任务助手", true),
      role("front", "前端工程师"),
      role("back", "后端工程师"),
    ],
    providers: [],
    bindable: [{ kind: "skill", name: "页面检查" }],
    memoryScope: "role",
    memoryRoleId: "front",
    memories: [memory("前端记忆", "front"), memory("后端记忆", "back")],
    selectedMemoryId: "前端记忆",
    memoryQuery: "",
    memoryStatus: "active",
    notice: null,
  });
  vi.mocked(invoke).mockImplementation(async (name) => {
    if(name==='role:impact')return {tasks:[{id:'t',title:'页面调整',status:'done'}],workbenches:[],total:1} as never;
    if (name === "memory:history")
      return {
        versions: [
          { ver: 1, title: "旧标题", content: "旧方法", createdAt: 1 },
        ],
      } as never;
    return {} as never;
  });
});
afterEach(() => {
  cleanup();
  setAppearance("system");
});
it("角色页切换配置标签后保存仍使用同一角色身份和完整草稿", async () => {
  render(<RoleDetail />);
  fireEvent.change(screen.getByPlaceholderText("如：代码评审员"), {
    target: { value: "页面工程师" },
  });
  fireEvent.click(screen.getByRole("button", { name: "技能与插件" }));
  fireEvent.click(screen.getByRole("button", { name: /绑定 Skill/ }));
  fireEvent.click(screen.getByLabelText("页面检查"));
  fireEvent.click(screen.getByRole("button", { name: "模型与思考" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "role:update",
      expect.objectContaining({
        roleId: "front",
        name: "页面工程师",
        systemPrompt: "角色自己的方法",
        boundSkills: ["页面检查"],
      }),
    ),
  );
});
it("默认助手的身份只读且仍可克隆，不暴露归档操作", () => {
  useStore.setState({ selectedRoleId: "assistant" });
  render(<RoleDetail />);
  expect(screen.getByPlaceholderText("如：代码评审员")).toHaveProperty(
    "readOnly",
    true,
  );
  expect(screen.queryByRole("button", { name: "归档" })).toBeNull();
  expect(screen.getByRole("button", { name: "克隆角色" })).toBeTruthy();
});
it("切换记忆所属角色时立即隐藏上一角色的过期列表和详情", () => {
  render(<MemoryDetail />);
  expect(screen.queryByText("后端记忆")).toBeNull();
  act(() =>
    useStore.setState({ memoryRoleId: "back", selectedMemoryId: null }),
  );
  expect(screen.queryByText("前端记忆")).toBeNull();
  expect(screen.getByRole("heading", { name: "后端记忆" })).toBeTruthy();
});
it("恢复记忆历史用原记忆 id 创建新版本，不写入其他角色", async () => {
  render(<MemoryDetail />);
  fireEvent.click(screen.getByRole("button", { name: "版本记录" }));
  fireEvent.click(await screen.findByRole("button", { name: "恢复为新版本" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("memory:revise", {
      memoryId: "前端记忆",
      title: "旧标题",
      content: "旧方法",
      reason: "恢复历史版本 v1",
      expectedVersion:2,
    }),
  );
  expect(invoke).not.toHaveBeenCalledWith("memory:write", expect.anything());
});
it("新记忆必须有明确归属，创建请求只发送选中的角色", async () => {
  render(<MemoryDetail />);
  fireEvent.click(screen.getByRole("button", { name: "新增记忆" }));
  fireEvent.change(screen.getByLabelText("标题"), {
    target: { value: "新方法" },
  });
  fireEvent.change(screen.getByLabelText("内容"), {
    target: { value: "只供前端使用" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存记忆" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("memory:write", {
      scopeType: "role",
      scopeId: "front",
      title: "新方法",
      content: "只供前端使用",
    }),
  );
});
it("角色导航不会把筛选切换为全部角色", () => {
  render(<MemoryContext />);
  fireEvent.click(screen.getByRole("button", { name: /后端工程师/ }));
  expect(useStore.getState()).toMatchObject({
    memoryScope: "role",
    memoryRoleId: "back",
    selectedMemoryId: null,
  });
});
it("外观选择同步整个文档并在组件切换后保留", () => {
  function Theme() {
    return <span>{useAppearance()}</span>;
  }
  const result = render(<Theme />);
  act(() => setAppearance("dark"));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("pih:appearance")).toBe("dark");
  result.unmount();
  render(<Theme />);
  expect(screen.getByText("dark")).toBeTruthy();
  act(() => setAppearance("light"));
  expect(document.documentElement.dataset.theme).toBe("light");
});
it("新增记忆不提供用户或项目范围",()=>{render(<MemoryDetail/>);fireEvent.click(screen.getByRole("button",{name:"新增记忆"}));expect(screen.queryByLabelText("适用范围")).toBeNull();expect(screen.getByLabelText("归属角色")).toBeTruthy();expect(screen.queryByRole("option",{name:"项目"})).toBeNull()});
it("已忘记的记忆有可达的恢复入口，恢复只提交该条记忆", async () => {
  useStore.setState({
    memoryStatus: "forgotten",
    memories: [{ ...memory("前端记忆", "front"), status: "forgotten" }],
  });
  render(<MemoryDetail />);
  fireEvent.click(screen.getByRole("button", { name: "撤销忘记" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("memory:restore", {
      memoryId: "前端记忆",
    }),
  );
});
it("归档角色后离开编辑器，避免把已归档角色误当新角色保存", async () => {
  render(<RoleDetail />);
  fireEvent.click(screen.getByRole("button", { name: "归档" }));
  await screen.findByRole('dialog',{name:'确认归档角色'});
  expect(invoke).not.toHaveBeenCalledWith('role:archive',expect.anything());
  fireEvent.click(screen.getByRole('button',{name:'确认归档并停止相关任务'}));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("role:archive", {
      roleId: "front",
      archived: true,
    }),
  );
  await waitFor(() => expect(useStore.getState().selectedRoleId).toBeNull());
  expect(invoke).not.toHaveBeenCalledWith("role:create", expect.anything());
});
