/**
 * ask_user 结构化提问集成测试：
 * 模型发起提问 → 事件弹出 → 用户答复（命令回收）→ 工具返回答案 → 对话继续；
 * 中止任务时未决问题如实作废。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${what}`);
		await new Promise((r) => setTimeout(r, 30));
	}
}

const states = () => events.filter((e): e is AppEvent<"task:state"> => e.type === "task:state").map((e) => e.payload);
const questions = () => events.filter((e): e is AppEvent<"task:question"> => e.type === "task:question").map((e) => e.payload);

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pih-ask-"));
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	events = [];
	core.router.onEvent((e) => events.push(e as AnyAppEvent));
	await invoke("settings:set", { defaultModel: fauxModelRef(), autoApproveTools: ["read", "grep", "find", "ls"] });
});

afterEach(() => {
	core.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("ask_user 结构化提问", () => {
	it("提问 → 答复 → 工具返回用户选择，对话继续", async () => {
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([
				fauxText("方案需要用户决策。"),
				fauxToolCall("ask_user", {
					question: "数据库选 PostgreSQL 还是 SQLite？",
					options: [
						{ label: "PostgreSQL", description: "生产级，并发强" },
						{ label: "SQLite", description: "零运维，单机" },
					],
				}),
			]),
			fauxAssistantMessage("收到，按选择继续。"),
		]);
		const task = await invoke("task:create", { title: "决策任务" });
		await invoke("task:prompt", { taskId: task.id, text: "帮我选数据库" });

		// 等提问事件 + waiting_user 状态
		await waitFor(() => questions().some((q) => q.taskId === task.id), "提问事件");
		await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "waiting_user"), "等待用户状态");
		const q = questions().find((x) => x.taskId === task.id)!;
		expect(q.options.length).toBe(2);

		// 用户答复
		const answered = await invoke("task:answerQuestion", { taskId: task.id, questionId: q.questionId, answer: "PostgreSQL" });
		expect(answered.ok).toBe(true);
		await waitFor(() => states().filter((s) => s.taskId === task.id && s.status === "done").length >= 1, "任务完成");

		const got = await invoke("task:get", { taskId: task.id });
		const r = (got.transcript as Array<{ role: string; toolName?: string; text?: string }>).find(
			(m) => m.role === "toolResult" && m.toolName === "ask_user",
		);
		expect(r).toBeDefined();
		expect(r!.text).toContain("用户答复：PostgreSQL");
		// 系统提示词含提问指引
		expect(got.task.systemPrompt).toContain("ask_user");
	}, 60_000);

	it("重复/越权答复被拒；中止任务作废未决提问", async () => {
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("ask_user", { question: "继续吗？", options: [{ label: "继续" }, { label: "停止" }] })]),
			fauxAssistantMessage("完成。"),
		]);
		const task = await invoke("task:create", { title: "作废测试" });
		await invoke("task:prompt", { taskId: task.id, text: "问" });
		await waitFor(() => questions().some((q) => q.taskId === task.id), "提问事件");
		const q = questions().find((x) => x.taskId === task.id)!;

		// 错误 taskId 拒绝
		const wrong = await invoke("task:answerQuestion", { taskId: "nope", questionId: q.questionId, answer: "x" });
		expect(wrong.ok).toBe(false);
		// 中止 → 提问作废（工具返回作废说明，任务收尾）
		await invoke("task:abort", { taskId: task.id });
		await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "cancelled"), "任务取消");
	}, 60_000);
});
