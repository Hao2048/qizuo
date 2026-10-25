/**
 * M1 核心集成测试：faux 假模型驱动全链路（零成本、确定性）。
 * 走 createHarnessCore 的 router（契约校验），事件经 router.onEvent 捕获——
 * 与 Electron 场景同一条数据通路。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AppEvent, ApprovalRequest, TaskStatus, TranscriptMessage } from "@pi-harness/contracts";
import { createHarnessCore, type HarnessCore } from "../core/harness-core.js";
import { ensureFauxRegistered, FAUX_MODEL_ID, FAUX_PROVIDER_ID } from "../pi/faux-provider.js";

let dir: string;
let core: HarnessCore;
let events: AppEvent[];

async function invoke<N extends Parameters<HarnessCore["router"]["invoke"]>[0]>(
	name: N,
	input: unknown,
): Promise<unknown> {
	const env = await core.router.invoke(name, input);
	if (!env.ok) throw new Error(`${String(name)} 失败: ${env.error.message}`);
	return env.result;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

function states(): Array<{ taskId: string; status: TaskStatus }> {
	return events
		.filter((e): e is AppEvent<"task:state"> => e.type === "task:state")
		.map((e) => e.payload);
}

function streams() {
	return events.filter((e): e is AppEvent<"task:stream"> => e.type === "task:stream").map((e) => e.payload);
}

function approvals(): ApprovalRequest[] {
	return events
		.filter((e): e is AppEvent<"task:approval"> => e.type === "task:approval")
		.map((e) => e.payload);
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pih-task-"));
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	events = [];
	core.router.onEvent((e) => events.push(e as AppEvent));
	await invoke("settings:set", {
		defaultModel: { provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID },
		autoApproveTools: ["read", "grep", "find", "ls"],
	});
});

afterEach(() => {
	core.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("M1 全链路（faux）", () => {
	it("创建任务→提示→流式文本→工具执行→完成→转录→用量→会话落盘", async () => {
		writeFileSync(join(dir, "hello.txt"), "hello pi harness");
		const project = (await invoke("project:add", { dir })) as { id: string };
		const task = (await invoke("task:create", {
			projectId: project.id,
			title: "faux 集成",
		})) as { id: string };

		await invoke("task:prompt", { taskId: task.id, text: "列出目录" });
		await waitFor(() => states().some((s) => s.status === "done"), "任务完成");

		const textChars = streams()
			.filter((s) => s.kind === "text_delta")
			.map((s) => s.delta ?? "")
			.join("").length;
		expect(textChars).toBeGreaterThan(5);

		const toolStart = streams().find((s) => s.kind === "tool_execution_start");
		expect(toolStart?.toolName).toBe("ls");
		const toolEnd = streams().find((s) => s.kind === "tool_execution_end");
		expect(toolEnd?.isError).toBe(false);

		const got = (await invoke("task:get", { taskId: task.id })) as {
			task: { status: string; model: { provider: string; modelId: string } | null };
			transcript: TranscriptMessage[];
		};
		expect(got.task.status).toBe("done");
		expect(got.task.model).toEqual({ provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID });
		const user = got.transcript.find((m) => m.role === "user");
		expect(user?.text).toContain("列出目录");
		const toolResult = got.transcript.find((m) => m.role === "toolResult");
		expect(toolResult?.toolName).toBe("ls");
		expect(toolResult?.isError).toBe(false);
		const finalAssistant = [...got.transcript].reverse().find((m) => m.role === "assistant" && m.text);
		expect(finalAssistant?.text).toContain("打通");

		// 用量入账（faux usage 为 0，但行必须真实存在）
		const usageRows = core.db
			.prepare("SELECT COUNT(*) AS c FROM usage_ledger WHERE task_id = ?")
			.get(task.id) as { c: number };
		expect(usageRows.c).toBeGreaterThanOrEqual(1);

		// pi 会话文件落盘且路径入库
		const sessionFile = core.db
			.prepare("SELECT pi_session_id AS f FROM tasks WHERE id = ?")
			.get(task.id) as { f: string | null };
		expect(sessionFile.f).toBeTruthy();
		expect(existsSync(sessionFile.f as string)).toBe(true);
	}, 30_000);

	it("审批：白名单外工具触发审批事件，批准后真实执行", async () => {
		const target = join(dir, "approved-out.txt");
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxText("我来创建文件。"), fauxToolCall("write", { path: target, content: "approved" })]),
			fauxAssistantMessage("文件已创建。"),
		]);
		const task = (await invoke("task:create", { title: "审批-批准" })) as { id: string };

		await invoke("task:prompt", { taskId: task.id, text: "创建文件" });
		await waitFor(() => approvals().length > 0, "审批请求出现");
		const req = approvals()[0]!;
		expect(req.toolName).toBe("write");
		expect(states().some((s) => s.status === "waiting_approval")).toBe(true);

		await invoke("approval:decide", { taskId: task.id, toolCallId: req.toolCallId, approved: true });
		await waitFor(() => states().some((s) => s.status === "done"), "批准后完成");

		expect(existsSync(target)).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("approved");
		const blocked = streams().find((s) => s.kind === "tool_execution_end" && s.isError);
		expect(blocked).toBeUndefined();
	}, 30_000);

	it("审批：拒绝后工具被阻止，模型收到拒绝原因并继续", async () => {
		const target = join(dir, "denied-out.txt");
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: target, content: "x" })]),
			fauxAssistantMessage("好的，我不写了。"),
		]);
		const task = (await invoke("task:create", { title: "审批-拒绝" })) as { id: string };

		await invoke("task:prompt", { taskId: task.id, text: "创建文件" });
		await waitFor(() => approvals().length > 0, "审批请求出现");
		await invoke("approval:decide", {
			taskId: task.id,
			toolCallId: approvals()[0]!.toolCallId,
			approved: false,
		});
		await waitFor(() => states().some((s) => s.status === "done"), "拒绝后完成");

		expect(existsSync(target)).toBe(false);
		const got = (await invoke("task:get", { taskId: task.id })) as { transcript: TranscriptMessage[] };
		const denied = got.transcript.find((m) => m.role === "toolResult" && m.isError);
		expect(denied).toBeDefined();
	}, 30_000);

	it("停止：运行中 abort → cancelled，挂起审批被清理", async () => {
		const target = join(dir, "abort-out.txt");
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: target, content: "x" })]),
			fauxAssistantMessage("done"),
		]);
		const task = (await invoke("task:create", { title: "停止" })) as { id: string };
		await invoke("task:prompt", { taskId: task.id, text: "创建文件" });
		await waitFor(() => approvals().length > 0, "审批挂起");

		await invoke("task:abort", { taskId: task.id });
		await waitFor(() => states().some((s) => s.status === "cancelled"), "取消状态");
		expect(existsSync(target)).toBe(false);

		// 之后再决策同一审批应失败（已清理）
		const again = await core.router.invoke("approval:decide", {
			taskId: task.id,
			toolCallId: approvals()[0]!.toolCallId,
			approved: true,
		});
		expect(again.ok).toBe(true);
		if (again.ok) {
			const r = again.result as { ok: boolean };
			expect(r.ok).toBe(false);
		}
	}, 30_000);

	it("图片附件参数链路：多模态消息安全通过全流程", async () => {
		ensureFauxRegistered().setResponses([fauxAssistantMessage("收到图片。")]);
		const task = (await invoke("task:create", { title: "图片" })) as { id: string };
		// 1x1 红色 PNG
		const png =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		await invoke("task:prompt", {
			taskId: task.id,
			text: "看这张图",
			images: [{ data: png, mimeType: "image/png" }],
		});
		await waitFor(() => states().some((s) => s.status === "done"), "带图任务完成");
		const got = (await invoke("task:get", { taskId: task.id })) as { transcript: TranscriptMessage[] };
		expect(got.transcript.some((m) => m.role === "assistant" && m.text?.includes("图片"))).toBe(true);
	}, 30_000);

	it("项目隔离：无项目任务使用个人目录，项目任务使用项目目录", async () => {
		ensureFauxRegistered().setResponses([fauxAssistantMessage("ok")]);
		const project = (await invoke("project:add", { dir })) as { id: string; dir: string };
		const withProject = (await invoke("task:create", { projectId: project.id, title: "p" })) as {
			dir: string | null;
		};
		expect(withProject.dir).toBe(dir);

		const personal = (await invoke("task:create", { title: "个人" })) as { dir: string | null; id: string };
		// 个人任务创建时未绑定目录（首条消息时才分配个人工作区）
		expect(personal.dir).toBeNull();

		await invoke("task:prompt", { taskId: personal.id, text: "hi" });
		await waitFor(() => states().some((s) => s.status === "done"), "个人任务完成");
		const after = (await invoke("task:get", { taskId: personal.id })) as { task: { id: string } };
		expect(after.task.id).toBe(personal.id);
	}, 30_000);
});
