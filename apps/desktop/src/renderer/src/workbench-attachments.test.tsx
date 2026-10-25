import { afterEach, beforeEach, it, expect, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import {
  WorkbenchFilePicker,
  WorkbenchMessageFiles,
} from "./components/WorkbenchAttachments.js";
import { CollaborationPanel } from "./panels/Collaboration.js";
import { useCollaboration, updateWorkbenchView } from "./workbench-data.js";
import { useStore } from "./store.js";
import { invoke, onEvent } from "./api.js";
vi.mock("./api.js", () => ({
  invoke: vi.fn(),
  onEvent: vi.fn(() => () => {}),
}));
const file = {
  id: "file",
  name: "需求.md",
  kind: "text" as const,
  mimeType: "text/plain",
  bytes: 9,
};
const w = {
  id: "wb",
  title: "附件任务",
  projectId: null,
  phase: "draft",
  revision: 1,
  participants: [],
  messages: [],
  recommendations: [],
  contracts: [],
  proposals: [],
  createdAt: 1,
  updatedAt: 1,
};
beforeEach(() => {
  vi.resetAllMocks();
  useCollaboration.setState({
    items: [w],
    selected: "wb",
    views: {},
    pageIds: null,
    query: "",
    cursor: null,
    nextCursor: null,
    previous: [],
    loading: false,
    listError: null,
  });
  useStore.setState({ roles: [] });
  vi.mocked(onEvent).mockReturnValue(() => {});
  vi.mocked(invoke).mockImplementation(async (name) =>
    name === "workbench:attach"
      ? (file as any)
      : name === "workbench:list"
        ? ({ items: [w], nextCursor: null } as any)
        : name === "workbench:get"
          ? (w as any)
          : ({ accepted: true } as any),
  );
});
afterEach(cleanup);
it("uploads text through the task-scoped API and removes only that draft attachment", async () => {
  const error = vi.fn(),
    busy = vi.fn();
  render(
    <WorkbenchFilePicker
      id="wb"
      disabled={false}
      onBusy={busy}
      onError={error}
    />,
  );
  fireEvent.change(screen.getByLabelText("选择工作台附件"), {
    target: {
      files: [new File(["需求说明"], "需求.md", { type: "text/markdown" })],
    },
  });
  await waitFor(() => expect(screen.getByText("需求.md")).toBeTruthy());
  expect(invoke).toHaveBeenCalledWith("workbench:attach", {
    id: "wb",
    name: "需求.md",
    kind: "text",
    mimeType: "text/markdown",
    data: expect.any(String),
  });
  expect(busy).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button", { name: "移除附件 需求.md" }));
  await waitFor(() =>
    expect(useCollaboration.getState().views.wb?.attachments).toEqual([]),
  );
  expect(invoke).toHaveBeenCalledWith("workbench:discardAttachment", {
    id: "wb",
    attachmentId: "file",
  });
  expect(error).not.toHaveBeenCalled();
});
it("rejects oversized files without uploading and reports an actionable error", async () => {
  const error = vi.fn();
  render(
    <WorkbenchFilePicker
      id="wb"
      disabled={false}
      onBusy={() => {}}
      onError={error}
    />,
  );
  fireEvent.change(screen.getByLabelText("选择工作台附件"), {
    target: {
      files: [
        new File(["a".repeat(65537)], "large.txt", { type: "text/plain" }),
      ],
    },
  });
  await waitFor(() => expect(error).toHaveBeenCalled());
  expect(invoke).not.toHaveBeenCalledWith(
    "workbench:attach",
    expect.anything(),
  );
});
it("reads sent attachments only when opened and can reuse them without reuploading", async () => {
  vi.mocked(invoke).mockResolvedValue({
    attachment: file,
    data: btoa("safe text"),
  } as any);
  render(
    <WorkbenchMessageFiles
      id="wb"
      files={[{ ...file, roleIds: ["front"] }]}
      roleName={() => "前端"}
    />,
  );
  expect(invoke).not.toHaveBeenCalled();
  expect(screen.getByText("接收：前端")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "需求.md" }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  expect(screen.getByText("safe text")).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("workbench:readAttachment", {
    id: "wb",
    attachmentId: "file",
  });
  fireEvent.click(screen.getByRole("button", { name: "关闭附件预览" }));
  fireEvent.click(screen.getByRole("button", { name: "再次附加 需求.md" }));
  expect(
    useCollaboration.getState().views.wb?.attachments?.map((f) => f.id),
  ).toEqual(["file"]);
});
it("keeps attachment metadata and text on send failure and retries with the same request id", async () => {
  updateWorkbenchView("wb", { text: "参考附件", attachments: [file] });
  const requests: any[] = [];
  vi.mocked(invoke).mockImplementation(async (name, input: any) => {
    if (name === "workbench:send") {
      requests.push(input);
      throw Error("offline");
    }
    return name === "workbench:get"
      ? (w as any)
      : ({ items: [w], nextCursor: null } as any);
  });
  render(<CollaborationPanel />);
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("offline"),
  );
  expect(useCollaboration.getState().views.wb?.attachments).toEqual([file]);
  expect(
    (screen.getByLabelText("任务要求或修改意见") as HTMLTextAreaElement).value,
  ).toBe("参考附件");
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].requestId).toBe(requests[1].requestId);
  expect(requests[0].attachmentIds).toEqual(["file"]);
});
it("allows an attachment-only request and clears only successfully sent attachment ids", async () => {
  updateWorkbenchView("wb", { attachments: [file] });
  render(<CollaborationPanel />);
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("workbench:send", {
      id: "wb",
      text: "请参考附件处理任务。",
      draftRevision: expect.any(Number),
      requestId: expect.any(String),
      roleId: undefined,
      attachmentIds: ["file"],
    }),
  );
  await waitFor(() =>
    expect(useCollaboration.getState().views.wb?.attachments).toEqual([]),
  );
});
