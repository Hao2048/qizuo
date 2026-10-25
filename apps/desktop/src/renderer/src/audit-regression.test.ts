import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { useStore } from "./store.js";
import { dispatchAppEvent } from "./events.js";
import { openTask, refreshContext } from "./data.js";

const approval = { taskId: "a", toolCallId: "call", toolName: "write", input: { path: "x" } };
const question = { taskId: "a", questionId: "q", question: "A?", options: [{ label: "Yes" }, { label: "No" }] };
function bridge(handler?: (name: string, input: any) => Promise<unknown>) {
	window.pih = {
		invoke: vi.fn(
			handler ??
				(async (name: string, input: any) => ({
					ok: true,
					result:
						name === "task:get"
							? {
									task: { id: input.taskId, status: "waiting_approval", model:{provider:"provider-a",modelId:"model-a"} },
									transcript: [],
									pendingApprovals: input.taskId === "a" ? [approval] : [],
								}
							: name === "task:list"
								? { tasks: [] }
								: { percent: 77, lastRequestTokens: 100, cacheRead: 0 },
				})),
		),
		onEvent: () => () => {},
		platform: "darwin",
		versions: { electron: "", chrome: "" },
	};
}
beforeEach(() => {
	useStore.getState().resetConversation();
	useStore.setState({ currentTaskId: null });
});
afterEach(() => {
	useStore.getState().resetConversation();
	useStore.setState({ currentTaskId: null });
	delete window.pih;
});
it("switching back restores the pending approval", async () => {
	bridge();
	await openTask("a");
	expect(useStore.getState().pendingApproval).toEqual(approval);
 expect(useStore.getState().draftModel).toEqual({provider:"provider-a",modelId:"model-a"});
	await openTask("b");
	expect(useStore.getState().pendingApproval).toBeNull();
	await openTask("a");
	expect(useStore.getState().pendingApproval).toEqual(approval);
});
it("switching tasks clears questions, recommendations, disputes and context", async () => {
	bridge();
	useStore.setState({
		currentTaskId: "a",
		question,
		contextInfo: { percent: 9, lastRequestTokens: 10, cacheRead: 0 },
	});
	await openTask("b");
	const s = useStore.getState();
	expect(s.question).toBeNull();
	expect(s.contextInfo).toBeNull();
});
it("opening a waiting task restores its question", async () => {
	bridge(async () => ({ ok: true, result: { task: { id: "a", status: "waiting_user" }, transcript: [], question } }));
	await openTask("a");
	expect(useStore.getState().question).toEqual(question);
});
it.each(["cancelled", "done", "error", "running"] as const)("%s clears stale interactions", (status) => {
	bridge();
    useStore.setState({currentTaskId:"a",question});
	dispatchAppEvent({ ts: Date.now(), type: "task:state", payload: { taskId: "a", status } });
	expect(useStore.getState().question).toBeNull();
});
it("a late context response cannot overwrite another task", async () => {
	let finish!: (value: unknown) => void;
	bridge(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	useStore.setState({ currentTaskId: "a" });
	const pending = refreshContext("a");
	useStore.setState({ currentTaskId: "b", contextInfo: null });
	finish({ ok: true, result: { percent: 77, lastRequestTokens: 100, cacheRead: 0 } });
	await pending;
	expect(useStore.getState().contextInfo).toBeNull();
});
it("a late task:get response cannot undo the latest task selection", async () => {
	const finishes = new Map<string, (value: unknown) => void>();
	bridge(
		(_name, input) =>
			new Promise((resolve) => {
				finishes.set(input.taskId, resolve);
			}),
	);
	const a = openTask("a"),
		b = openTask("b");
	finishes.get("b")!({
		ok: true,
		result: { task: { status: "done" }, transcript: [{ id: "b", role: "user", text: "B" }] },
	});
	await b;
	finishes.get("a")!({ ok: true, result: { task: { status: "waiting_user" }, transcript: [], question } });
	await a;
	expect(useStore.getState().currentTaskId).toBe("b");
	expect(useStore.getState().transcript[0]?.text).toBe("B");
	expect(useStore.getState().question).toBeNull();
});
it("multiple concurrent approvals are queued and deciding one preserves the next", () => {
	useStore.setState({ currentTaskId: "a" });
	dispatchAppEvent({ ts: Date.now(), type: "task:approval", payload: approval });
	dispatchAppEvent({ ts: Date.now(), type: "task:approval", payload: { ...approval, toolCallId: "second" } });
	expect(useStore.getState().pendingApproval?.toolCallId).toBe("call");
	useStore.getState().removePendingApproval("call");
	expect(useStore.getState().pendingApproval?.toolCallId).toBe("second");
});
it("new-task view discards a pending task:get response", async () => {
	let finish!: (value: unknown) => void;
	bridge(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const a = openTask("a");
	useStore.getState().selectTask(null);
	useStore.getState().resetConversation();
	finish({ ok: true, result: { task: { status: "waiting_user" }, transcript: [], question } });
	await a;
	expect(useStore.getState().currentTaskId).toBeNull();
	expect(useStore.getState().question).toBeNull();
});
it("a task that settles during loading does not recover an obsolete question", async () => {
	let finish!: (value: unknown) => void;
	bridge((name) =>
		name === "task:list"
			? Promise.resolve({ ok: true, result: { tasks: [] } })
			: new Promise((resolve) => {
					finish = resolve;
				}),
	);
	const a = openTask("a");
	dispatchAppEvent({ ts: Date.now(), type: "task:state", payload: { taskId: "a", status: "done" } });
	finish({ ok: true, result: { task: { status: "waiting_user" }, transcript: [], question } });
	await a;
	expect(useStore.getState().taskStatus).toBe("done");
	expect(useStore.getState().question).toBeNull();
});
