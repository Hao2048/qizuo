import { beforeEach, it, expect, vi } from "vitest";
import { invoke } from "./api.js";
import {
  useCollaboration,
  refreshWorkbenches,
  searchWorkbenches,
  pageWorkbenches,
  selectWorkbench,
  updateWorkbenchView,
  rememberWorkbenchScroll,
  workbenchScroll,
  clearWorkbenchView,
} from "./workbench-data.js";
vi.mock("./api.js", () => ({ invoke: vi.fn() }));
const w = (id: string, revision = 1) =>
  ({
    id,
    title: id,
    revision,
    messages: [],
    participants: [],
    phase: "draft",
    updatedAt: 1,
  }) as any;
const deferred = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((r) => (resolve = r));
  return { promise, resolve };
};
beforeEach(() => {
  vi.resetAllMocks();
  useCollaboration.setState({
    items: [w("active")],
    selected: "active",
    views: {},
    pageIds: null,
    query: "",
    cursor: null,
    nextCursor: null,
    previous: [],
    loading: false,
    listError: null,
  });
});
it("keeps active task, draft and reading position when paging or searching older records", async () => {
  updateWorkbenchView("active", { text: "未发送要求" });
  rememberWorkbenchScroll("active", "conversation", 123);
  vi.mocked(invoke).mockImplementation(async (name, input: any) =>
    name === "workbench:get"
      ? w(input.id)
      : ({
          items: [w(input.cursor ? "old" : "recent")],
          nextCursor: input.cursor ? null : "next",
        } as any),
  );
  await refreshWorkbenches();
  await pageWorkbenches("next");
  const s = useCollaboration.getState();
  expect(s.pageIds).toEqual(["old"]);
  expect(s.selected).toBe("active");
  expect(s.items.map((w) => w.id)).toEqual(["old", "active"]);
  expect(s.views.active?.text).toBe("未发送要求");
  expect(workbenchScroll("active", "conversation")).toBe(123);
  await searchWorkbenches("旧项目");
  expect(useCollaboration.getState().cursor).toBeNull();
  expect(useCollaboration.getState().previous).toEqual([]);
  expect(invoke).toHaveBeenCalledWith("workbench:list", {
    query: "旧项目",
    cursor: undefined,
    limit: 50,
  });
  await selectWorkbench("old");
  expect(useCollaboration.getState().selected).toBe("old");
  expect(useCollaboration.getState().items.some((w) => w.id === "old")).toBe(
    true,
  );
});
it("ignores old search results arriving after a newer search", async () => {
  const old = deferred();
  vi.mocked(invoke).mockImplementation(async (name, input: any) =>
    name === "workbench:get"
      ? w(input.id)
      : input.query === "old"
        ? old.promise
        : ({ items: [w("new")], nextCursor: null } as any),
  );
  const pending = searchWorkbenches("old");
  await searchWorkbenches("new");
  old.resolve({ items: [w("old")], nextCursor: "bad" });
  await pending;
  expect(useCollaboration.getState().pageIds).toEqual(["new"]);
  expect(useCollaboration.getState().nextCursor).toBeNull();
  expect(useCollaboration.getState().loading).toBe(false);
});
it("does not replace a task selected while an older detail request is in flight", async () => {
  const detail = deferred();
  vi.mocked(invoke).mockImplementation(async (name, input: any) =>
    name === "workbench:list"
      ? ({ items: [w("new")], nextCursor: null } as any)
      : input.id === "active"
        ? detail.promise
        : w(input.id, 2),
  );
  const pending = refreshWorkbenches();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("workbench:get", { id: "active" }),
  );
  await selectWorkbench("new");
  detail.resolve(w("active"));
  await pending;
  expect(useCollaboration.getState().selected).toBe("new");
  expect(
    useCollaboration.getState().items.find((w) => w.id === "new")?.revision,
  ).toBe(2);
});
it("shows a retryable list failure without clearing task or draft", async () => {
  updateWorkbenchView("active", { text: "保留" });
  vi.mocked(invoke).mockRejectedValue(Error("offline"));
  await expect(refreshWorkbenches()).rejects.toThrow("offline");
  expect(useCollaboration.getState().loading).toBe(false);
  expect(useCollaboration.getState().listError).toContain("offline");
  expect(useCollaboration.getState().views.active?.text).toBe("保留");
  expect(useCollaboration.getState().selected).toBe("active");
});
it("bounds draft and scroll caches and deletes only the requested task", () => {
  for (let i = 0; i < 105; i++) {
    updateWorkbenchView("cache-" + i, { tab: "results" });
    rememberWorkbenchScroll("cache-" + i, "conversation", i);
  }
  expect(Object.keys(useCollaboration.getState().views)).toHaveLength(100);
  expect(workbenchScroll("cache-0", "conversation")).toBeUndefined();
  rememberWorkbenchScroll("cache-104", "results", 7);
  expect(workbenchScroll("cache-104", "conversation")).toBe(104);
  clearWorkbenchView("cache-104");
  expect(useCollaboration.getState().views["cache-104"]).toBeUndefined();
  expect(workbenchScroll("cache-104", "results")).toBeUndefined();
  expect(useCollaboration.getState().selected).toBe("active");
});

it("never evicts unsent drafts when browsing more than the view cache limit", () => {
  for (let i = 0; i < 105; i++)
    updateWorkbenchView("dirty-" + i, { text: "未发送 " + i });
  expect(useCollaboration.getState().views["dirty-0"]?.text).toBe("未发送 0");
});
it("rolls back failed navigation so retry cannot skip an older page", async () => {
  useCollaboration.setState({ nextCursor: "older" });
  vi.mocked(invoke).mockRejectedValue(Error("offline"));
  await expect(pageWorkbenches("next")).rejects.toThrow("offline");
  expect(useCollaboration.getState().cursor).toBeNull();
  expect(useCollaboration.getState().previous).toEqual([]);
  expect(useCollaboration.getState().nextCursor).toBe("older");
});
it("keeps the previous task visible when selecting an unavailable task fails", async () => {
  vi.mocked(invoke).mockRejectedValue(Error("missing"));
  await expect(selectWorkbench("missing")).rejects.toThrow("missing");
  expect(useCollaboration.getState().selected).toBe("active");
});

it("retains summaries instead of previously opened full conversations", async () => {
  useCollaboration.setState({
    items: [
      { ...w("active"), messages: [{ text: "private history" }] },
      w("next"),
    ],
    pageIds: ["active", "next"],
  });
  vi.mocked(invoke).mockResolvedValue({
    ...w("next"),
    messages: [{ text: "selected history" }],
  });
  await selectWorkbench("next");
  expect(
    useCollaboration.getState().items.find((w) => w.id === "active")?.messages,
  ).toEqual([]);
  expect(
    useCollaboration.getState().items.find((w) => w.id === "next")?.messages,
  ).toEqual([{ text: "selected history" }]);
});
