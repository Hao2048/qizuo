/**
 * bash 沙箱（macOS Seatbelt）集成测试：
 * 通过真实 bash 工具执行验证内核级约束——只读档禁写家目录、工作区档允许写 cwd、
 * 关闭档全权限；读取与临时目录写入不受影响。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AnyAppEvent, AppEvent } from "@pi-harness/contracts";
import { createHarnessCore, type HarnessCore } from "./core/harness-core.js";
import { ensureFauxRegistered, fauxModelRef } from "./pi/faux-provider.js";

let dir: string;
let core: HarnessCore;
let events: AnyAppEvent[];

async function invoke(name: string, input: unknown): Promise<any> {
	const env = await core.router.invoke(name, input);
	if (!env.ok) throw new Error(`${name} 失败: ${env.error.message}`);
	return env.result;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${what}`);
		await new Promise((r) => setTimeout(r, 30));
	}
}

const states = () => events.filter((e): e is AppEvent<"task:state"> => e.type === "task:state").map((e) => e.payload);

/** 跑一个 bash 命令并返回工具结果文本。 */
async function runBash(command: string): Promise<{ text: string; isError: boolean }> {
	ensureFauxRegistered().setResponses([
		fauxAssistantMessage([fauxText("执行验证命令。"), fauxToolCall("bash", { command })]),
		fauxAssistantMessage("完成。"),
	]);
	const task = await invoke("task:create", { title: `sbx ${Date.now()}` });
	await invoke("task:prompt", { taskId: task.id, text: "run" });
	await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "done"), "任务完成");
	const got = await invoke("task:get", { taskId: task.id });
	const r = got.transcript.find((m: { role: string; toolName?: string }) => m.role === "toolResult" && m.toolName === "bash");
	if (!r) throw new Error("bash 工具结果缺失");
	return { text: String(r.text ?? ""), isError: Boolean(r.isError) };
}

const HOME_PROBE = join(homedir(), ".pih-sbx-probe");
async function setSandbox(mode: "off" | "read_only" | "workspace_write"): Promise<void> {
	await invoke("settings:set", {
		defaultModel: fauxModelRef(),
		autoApproveTools: ["read", "grep", "find", "ls", "bash"],
		autoMemory: false,
		sandboxMode: mode,
	});
}

const isMac = process.platform === "darwin";

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pih-sbx-"));
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	events = [];
	core.router.onEvent((e) => events.push(e as AnyAppEvent));
	await invoke("settings:set", { defaultModel: fauxModelRef(), autoApproveTools: ["read", "grep", "find", "ls", "bash"] });
});

afterEach(() => {
	core.dispose();
	rmSync(dir, { recursive: true, force: true });
	try {
		if (existsSync(HOME_PROBE)) rmSync(HOME_PROBE, { recursive: true, force: true });
	} catch {
		/* 清理尽力 */
	}
});

describe.skipIf(!isMac)("bash 沙箱（Seatbelt）", () => {
	it("read_only：家目录写入被拒、读取正常、临时目录可写", async () => {
		await setSandbox("read_only");
		const write = await runBash(`touch ${HOME_PROBE} 2>&1; echo "exit=$?"`);
		expect(write.text).toMatch(/Operation not permitted|Read-only file system|denied|exit=[1-9]/);
		expect(existsSync(HOME_PROBE)).toBe(false);
		const read = await runBash(`ls ${homedir()} >/dev/null 2>&1; echo "exit=$?"`);
		expect(read.text).toContain("exit=0");
		const tmp = await runBash(`echo ok > ${join(tmpdir(), "pih-sbx-tmp.txt")} && echo written`);
		expect(tmp.text).toContain("written");
	}, 120_000);

	it("workspace_write：工作区可写、家目录仍被拒", async () => {
		await setSandbox("workspace_write");
		const ws = await runBash(`echo ok > ws-file.txt && echo ws-written`);
		expect(ws.text).toContain("ws-written");
		const home = await runBash(`touch ${HOME_PROBE} 2>&1; echo "exit=$?"`);
		expect(home.text).toMatch(/Operation not permitted|Read-only file system|denied|exit=[1-9]/);
		expect(existsSync(HOME_PROBE)).toBe(false);
	}, 120_000);

	it("off：不设沙箱，家目录可写（回归确认）", async () => {
		const r = await runBash(`mkdir -p ${HOME_PROBE} && echo home-written`);
		expect(r.text).toContain("home-written");
		expect(existsSync(HOME_PROBE)).toBe(true);
	}, 120_000);
});
