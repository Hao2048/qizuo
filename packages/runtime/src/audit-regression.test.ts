/** 上一轮审计的实际复现场景：使用真实 SDK/工具与 SQLite 验证修复后的行为。 */
import { it, expect, beforeEach, afterEach } from "vitest";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	rmSync,
	existsSync,
	symlinkSync,
	readdirSync,
	renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createHarnessCore, type HarnessCore } from "./core/harness-core.js";
import { ensureFauxRegistered, fauxModelRef } from "./pi/faux-provider.js";
import { BackupService } from "./market/backup-service.js";
import { isHighRiskBash } from "./tasks/bash-risk.js";
import { SessionEventMapper } from "./pi/agent-events.js";

let core: HarnessCore, dir: string, events: any[];
const extraDirs: string[] = [];
async function call(name: string, input: any = {}): Promise<any> {
	if (name === "settings:set") input = { autoApproveTools: ["read", "grep", "find", "ls"], ...input };
	const r = await core.router.invoke(name, input);
	if (!r.ok) throw new Error(r.error.message);
	return r.result;
}
async function wait(f: () => boolean) {
	const deadline = Date.now() + 15000;
	while (!f()) {
		if (Date.now() > deadline) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 10));
	}
}
function completed(id: string, n = 1) {
	return (
		events.filter((e) => e.type === "task:state" && e.payload.taskId === id && e.payload.status === "done").length >= n
	);
}
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pih-audit-"));
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	events = [];
	core.router.onEvent((e) => events.push(e));
	await call("settings:set", { defaultModel: fauxModelRef() });
});
afterEach(() => {
	core.dispose();
	rmSync(dir, { recursive: true, force: true });
	for (const path of extraDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function run(script: Parameters<ReturnType<typeof ensureFauxRegistered>["setResponses"]>[0], input: any = {}) {
	ensureFauxRegistered().setResponses(script);
	const t = await call("task:create", input);
	await call("task:prompt", { taskId: t.id, text: "audit" });
	await wait(() => completed(t.id));
	return t;
}
it("quoted executables, adjacent separators and wrapper operands still require approval", () => {
	for (const command of [
		"'rm' -f file",
		"'r'm -f file",
		"echo ok|rm -f file",
		"echo ok;rm file",
		"echo ok&rm file",
		"/bin/sh -c 'rm -f file'",
		"xargs -n 1 rm",
		"nice -n 5 rm file",
		"env -u PATH /bin/rm file",
		"git 'push' --force origin main",
	])
		expect(isHighRiskBash(command), command).toBe(true);
	for (const command of [
		"echo 'a && rm b'",
		"echo 'git push --force'",
		"xargs -n 1 cat",
		"nice -n 5 ls",
		"printf 'rm'",
	])
		expect(isHighRiskBash(command), command).toBe(false);
});
it("model failure stays error after agent settles and permits a retry", async () => {
	ensureFauxRegistered().setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "injected failure" }),
		fauxAssistantMessage("retry succeeded"),
	]);
	const t = await call("task:create");
	await call("task:prompt", { taskId: t.id, text: "first" });
	await wait(() => events.some((e) => e.type === "task:state" && e.payload.status === "error"));
	await new Promise((r) => setTimeout(r, 20));
	expect((await call("task:get", { taskId: t.id })).task.status).toBe("error");
	expect(completed(t.id)).toBe(false);
	await call("task:prompt", { taskId: t.id, text: "retry" });
	await wait(() => completed(t.id));
});
it("simultaneous first prompts allow only one session", async () => {
	ensureFauxRegistered().setResponses([fauxAssistantMessage("one")]);
	const t = await call("task:create");
	const results = await Promise.allSettled([
		call("task:prompt", { taskId: t.id, text: "one" }),
		call("task:prompt", { taskId: t.id, text: "two" }),
	]);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	await wait(() => completed(t.id));
	expect(events.filter((e) => e.type === "task:state" && e.payload.status === "running")).toHaveLength(1);
	expect(readdirSync(join(dir, "sessions")).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
});
it("stop while a session is initializing prevents the prompt", async () => {
	ensureFauxRegistered().setResponses([fauxAssistantMessage("must not run")]);
	const t = await call("task:create");
	const pending = call("task:prompt", { taskId: t.id, text: "one" });
	expect((await call("task:abort", { taskId: t.id })).ok).toBe(true);
	expect((await pending).accepted).toBe(false);
	expect((await call("task:get", { taskId: t.id })).task.status).toBe("cancelled");
	expect(ensureFauxRegistered().getPendingResponseCount()).toBe(1);
});
it("fork persists its branch before first continuation and rejects invalid nodes", async () => {
	const t = await run([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	await call("task:prompt", { taskId: t.id, text: "SECOND_QUESTION" });
	await wait(() => completed(t.id, 2));
	const tree = await call("task:getTree", { taskId: t.id });
	await expect(call("task:fork", { taskId: t.id, entryId: "missing" })).rejects.toThrow(/节点不存在/);
	const fork = await call("task:fork", { taskId: t.id, entryId: tree.userMessages[0].entryId });
	core.dispose();
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	events = [];
	core.router.onEvent((e) => events.push(e));
	ensureFauxRegistered().setResponses([fauxAssistantMessage("fork")]);
	await call("task:prompt", { taskId: fork.id, text: "fork prompt" });
	await wait(() => completed(fork.id));
	const transcript = (await call("task:get", { taskId: fork.id })).transcript;
	expect(transcript.some((m: any) => m.text === "SECOND_QUESTION")).toBe(false);
	expect(transcript.some((m: any) => m.text === "audit")).toBe(true);
});
it("task:get restores pending approvals and decisions remain usable", async () => {
	ensureFauxRegistered().setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: join(dir, "approved.txt"), content: "ok" })]),
		fauxAssistantMessage("done"),
	]);
	const t = await call("task:create");
	await call("task:prompt", { taskId: t.id, text: "audit" });
	await wait(() => events.some((e) => e.type === "task:approval"));
	const got = await call("task:get", { taskId: t.id });
	expect(got.task.status).toBe("waiting_approval");
	expect(got.pendingApprovals).toHaveLength(1);
	await call("approval:decide", { taskId: t.id, toolCallId: got.pendingApprovals[0].toolCallId, approved: true });
	await wait(() => completed(t.id));
	expect((await call("task:get", { taskId: t.id })).pendingApprovals).toEqual([]);
});
it("task:get restores questions, stopping clears them without returning to running", async () => {
	ensureFauxRegistered().setResponses([
		fauxAssistantMessage([fauxToolCall("ask_user", { question: "choose", options: [{ label: "A" }, { label: "B" }] })]),
		fauxAssistantMessage("done"),
	]);
	const t = await call("task:create");
	await call("task:prompt", { taskId: t.id, text: "audit" });
	await wait(() => events.some((e) => e.type === "task:question"));
	const got = await call("task:get", { taskId: t.id });
	expect(got.task.status).toBe("waiting_user");
	expect(got.question.question).toBe("choose");
	await call("task:abort", { taskId: t.id });
	await new Promise((r) => setTimeout(r, 20));
	const stopped = await call("task:get", { taskId: t.id });
	expect(stopped.question).toBeNull();
	expect(stopped.task.status).toBe("cancelled");
});
it("backup preserves checkpoints and current model/MCP credentials", async () => {
	const target = join(dir, "original.txt");
	writeFileSync(target, "old");
	const task = await call("task:create");
	const files = core.checkpoints.backupFiles(task.id, [target]);
	const cp = core.checkpoints.record(task.id, "write", {}, files);
	const b = core.backup.create();
	expect(existsSync(join(b.path, "harness.db-wal"))).toBe(false);
	expect(core.backup.requestRestore(b.id).ok).toBe(true);
	core.dispose();
	writeFileSync(join(dir, "pi", "auth.json"), '{"current":"auth"}');
	writeFileSync(join(dir, "pi", "mcp-credentials.json"), '{"current":"mcp"}', { mode: 0o600 });
	expect(BackupService.executePendingRestore(dir)).toBe(true);
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	expect(existsSync(files[0]!.backupPath)).toBe(true);
	writeFileSync(target, "changed");
	expect(core.checkpoints.restore(task.id, cp.id)).toEqual([target]);
	expect(readFileSync(target, "utf8")).toBe("old");
	expect(readFileSync(join(dir, "pi", "auth.json"), "utf8")).toContain("current");
	expect(readFileSync(join(dir, "pi", "mcp-credentials.json"), "utf8")).toContain("current");
	delete process.env.current;
});
it("corrupted backup is rejected before replacing current data", async () => {
	const b = core.backup.create();
	expect(core.backup.requestRestore(b.id).ok).toBe(true);
	core.dispose();
	const original = readFileSync(join(dir, "harness.db"));
	writeFileSync(join(b.path, "harness.db"), "corrupted");
	expect(BackupService.executePendingRestore(dir)).toBe(false);
	expect(readFileSync(join(dir, "harness.db"))).toEqual(original);
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	expect(core.backup.requestRestore(b.id).ok).toBe(false);
});
it("interrupted restore rolls original files back on next startup", () => {
	core.dispose();
	const original = readFileSync(join(dir, "harness.db"));
	mkdirSync(join(dir, ".restore-previous"));
	renameSync(join(dir, "harness.db"), join(dir, ".restore-previous", "harness.db"));
	writeFileSync(join(dir, "harness.db"), "half-restored");
	writeFileSync(join(dir, "new-from-backup"), "partial");
	writeFileSync(
		join(dir, ".restore-journal.json"),
		JSON.stringify({
			committed: false,
			originalNames: ["harness.db"],
			restoreNames: ["harness.db", "new-from-backup"],
		}),
	);
	expect(BackupService.executePendingRestore(dir)).toBe(false);
	expect(readFileSync(join(dir, "harness.db"))).toEqual(original);
	expect(existsSync(join(dir, "new-from-backup"))).toBe(false);
});
it("旧主管写回接口已退役",async()=>{const result=await core.router.invoke("task:writeBack",{taskId:"retired",relPath:"file.txt"});expect(result.ok).toBe(false);});

it("private installed package stays manageable and bindable and can be removed", async () => {
	const pkg = join(dir, "audit-package");
	mkdirSync(join(pkg, "extensions"), { recursive: true });
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({ name: "audit-package", version: "1.0.0", pi: { extensions: ["extensions"] } }),
	);
	writeFileSync(join(pkg, "extensions", "index.ts"), "export default function(pi:any) {}");
	expect((await call("market:installLocal", { path: pkg })).ok).toBe(true);
	const source = (await call("market:list")).packages[0].source;
	expect((await call("market:setVisibility", { name: source, kind: "package", visibility: "private" })).ok).toBe(true);
	expect((await call("market:list")).packages.find((p: any) => p.source === source).visibility).toBe("private");
	expect((await call("resource:listBindable")).items.some((p: any) => p.name === source)).toBe(true);
	expect((await call("market:setVisibility", { name: source, kind: "package", visibility: "public" })).ok).toBe(true);
	expect((await call("market:list")).packages).toHaveLength(1);
	await call("market:setVisibility", { name: source, kind: "package", visibility: "private" });
	expect((await call("market:remove", { source })).ok).toBe(true);
	expect((await call("market:list")).packages).toHaveLength(0);
});
it("live assistant messages have distinct keys", () => {
	const mapper = new SessionEventMapper("task");
	const a = mapper.map({ type: "message_end", message: fauxAssistantMessage("one") })!.stream!.message!;
	const b = mapper.map({ type: "message_end", message: fauxAssistantMessage("two") })!.stream!.message!;
	expect(a.id).not.toBe(b.id);
	const resumed = new SessionEventMapper("task").map({ type: "message_end", message: fauxAssistantMessage("resumed") })!
		.stream!.message!;
	expect(resumed.id).not.toBe(a.id);
});

it("keeps a recovered 502 retry running until the final answer settles",()=>{
 const mapper=new SessionEventMapper("retry");
 expect(mapper.map({type:"message_end",message:fauxAssistantMessage("",{stopReason:"error",errorMessage:'502 "acp-proxy failure"'})})).toBeNull();
 expect(mapper.map({type:"agent_end",messages:[],willRetry:true})).toBeNull();
 expect(mapper.map({type:"auto_retry_start",attempt:1,maxAttempts:3,delayMs:100,errorMessage:'502 "acp-proxy failure"'})?.state?.status).toBe("running");
 expect(mapper.map({type:"auto_retry_end",success:true,attempt:1})?.state?.status).toBe("running");
 expect(mapper.map({type:"agent_settled"})?.state?.status).toBe("done");
});
