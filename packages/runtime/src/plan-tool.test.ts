/**
 * update_plan 工具集成测试：
 * 模型建立/更新任务计划 → 事件广播 → 持久化（重开任务仍可见）→ 系统提示词含计划指引。
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
const planEvents = () => events.filter((e): e is AppEvent<"task:plan"> => e.type === "task:plan").map((e) => e.payload);

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pih-plan-"));
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	events = [];
	core.router.onEvent((e) => events.push(e as AnyAppEvent));
	await invoke("settings:set", { defaultModel: fauxModelRef(), autoApproveTools: ["read", "grep", "find", "ls"] });
});

afterEach(() => {
	core.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("update_plan 工具", () => {
	it("建计划→事件广播→完成态更新→持久化重开可见", async () => {
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([
				fauxText("这是多步任务，我先建计划。"),
				fauxToolCall("update_plan", {
					steps: [
						{ content: "读取配置", status: "in_progress" },
						{ content: "修改代码", status: "pending" },
						{ content: "验证结果", status: "pending" },
					],
				}),
			]),
			fauxAssistantMessage([
				fauxText("第一步完成，更新状态。"),
				fauxToolCall("update_plan", {
					steps: [
						{ content: "读取配置", status: "completed" },
						{ content: "修改代码", status: "in_progress" },
						{ content: "验证结果", status: "pending" },
					],
				}),
			]),
			fauxAssistantMessage("计划执行完毕。"),
		]);

		const task = await invoke("task:create", { title: "多步任务" });
		await invoke("task:prompt", { taskId: task.id, text: "分三步完成" });
		await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "done"), "任务完成");

		// 两次工具调用 → 两次事件广播，终态正确
		const plans = planEvents().filter((p) => p.taskId === task.id);
		expect(plans.length).toBe(2);
		expect(plans[1]!.steps[0]!.status).toBe("completed");
		expect(plans[1]!.steps[1]!.status).toBe("in_progress");

		// 持久化：task:get 返回计划
		const got = await invoke("task:get", { taskId: task.id });
		expect(got.task.plan).toBeTruthy();
		expect(got.task.plan!.map((s: { content: string }) => s.content)).toEqual(["读取配置", "修改代码", "验证结果"]);

		// 系统提示词含计划指引
		expect(got.task.systemPrompt).toContain("update_plan");
	}, 60_000);

	it("空计划（清空）合法：置 null", async () => {
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("update_plan", { steps: [{ content: "临时一步", status: "completed" }] })]),
			fauxAssistantMessage([fauxToolCall("update_plan", { steps: [] })]),
			fauxAssistantMessage("已清空。"),
		]);
		const task = await invoke("task:create", { title: "清空计划" });
		await invoke("task:prompt", { taskId: task.id, text: "做完清掉计划" });
		await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "done"), "任务完成");
		const got = await invoke("task:get", { taskId: task.id });
		expect(got.task.plan).toBeNull();
	}, 60_000);
});
