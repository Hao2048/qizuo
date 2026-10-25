import { it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import type { Workbench } from "@pi-harness/contracts";
import { WorkbenchReview, WorkbenchRepair } from "./panels/WorkbenchReview.js";
import { invoke } from "./api.js";
vi.mock("./api.js", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const w: Workbench = {
  id: "wb",
  title: "项目",
  projectId: null,
  phase: "awaiting_review",
  revision: 1,
  participants: [
    {
      roleId: "a",
      name: "前端",
      enabled: true,
      status: "done",
      taskId: "task-a",
      responsibility: "front.txt",
    },
    {
      roleId: "b",
      name: "后端",
      enabled: false,
      status: "paused",
      taskId: "task-b",
      responsibility: "back.txt",
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
it("shows real file contents and requires acknowledgment before applying the reviewed receipt", async () => {
  vi.mocked(invoke).mockImplementation(async (name) =>
    name === "workbench:review"
      ? ({
          token: "receipt",
          taskId: "task-a",
          total: 1,
          conflicts: 0,
          blockedReason: null,
          files: [
            {
              path: "front.txt",
              kind: "modified",
              conflict: false,
              reason: null,
            },
          ],
        } as any)
      : name === "workbench:reviewFile"
        ? ({
            path: "front.txt",
            before: { text: "old", bytes: 3, binary: false, truncated: false },
            after: { text: "new", bytes: 3, binary: false, truncated: false },
          } as any)
        : ({ ok: true, files: ["front.txt"] } as any),
  );
  render(
    <WorkbenchReview
      w={w}
      p={w.participants[0]!}
      disabled={false}
      action={action}
    />,
  );
  expect(screen.queryByText("确认应用成果")).toBeNull();
  fireEvent.click(screen.getByText("刷新成果文件"));
  await screen.findByRole("button", {name:/front.txt/});
  expect((screen.getByText("确认应用成果") as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", {name:/front.txt/}));
  await screen.findByText("old");
  expect(screen.getAllByText("new").length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByText("确认应用成果"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("workbench:apply", {
      id: "wb",
      roleId: "a",
      reviewToken: "receipt",
    }),
  );
});
it("sends failure evidence to an explicitly chosen enabled role and never selects a paused one", async () => {
  vi.mocked(invoke).mockResolvedValue({ accepted: true } as never);
  render(
    <WorkbenchRepair
      w={{
        ...w,
        verification: {
          status: "failed",
          at: 42,
          fingerprint: "fp",
          steps: [
            {
              command: "npm test",
              code: 1,
              output: "failure",
              cancelled: false,
              durationMs: 1,
            },
          ],
        },
      }}
      disabled={false}
      action={action}
    />,
  );
  expect(
    (screen.getByText("发送失败证据并开始修复") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByRole("combobox").textContent).not.toContain("后端");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
  fireEvent.change(screen.getByLabelText("修复补充要求"), {
    target: { value: "只修页面" },
  });
  fireEvent.click(screen.getByText("发送失败证据并开始修复"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("workbench:repair", {
      id: "wb",
      roleId: "a",
      requestId: expect.any(String),
      verificationAt: 42,
      fingerprint: "fp",
      instructions: "只修页面",
    }),
  );
});
it("previews raster output through the same receipt without applying or claiming acceptance", async () => {
  vi.mocked(invoke).mockImplementation(async (name) =>
    name === "workbench:review"
      ? ({
          token: "image-receipt",
          taskId: "task-a",
          total: 1,
          conflicts: 0,
          blockedReason: null,
          files: [
            {
              path: "preview.png",
              kind: "added",
              conflict: false,
              reason: null,
            },
          ],
        } as never)
      : name === "workbench:reviewFile"
        ? ({
            path: "preview.png",
            before: { text: "", bytes: 0, binary: false, truncated: false },
            after: { text: "", bytes: 32, binary: true, truncated: false },
          } as never)
        : ({ data: "AAAA", mimeType: "image/png" } as never),
  );
  render(
    <WorkbenchReview
      w={w}
      p={w.participants[0]!}
      disabled={false}
      action={action}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "刷新成果文件" }));
  await screen.findByText("preview.png");
  fireEvent.click(screen.getByRole("button", { name: /preview.png/ }));
  fireEvent.click(await screen.findByRole("button", { name: "预览成果图片" }));
  await screen.findByAltText("角色成果：preview.png");
  expect(invoke).toHaveBeenCalledWith("workbench:reviewImage", {
    id: "wb",
    roleId: "a",
    token: "image-receipt",
    path: "preview.png",
  });
  expect(invoke).not.toHaveBeenCalledWith("workbench:apply", expect.anything());
  expect(screen.getByText("图片显示不代表联调或人工验收已通过。")).toBeTruthy();
});
