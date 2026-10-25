/**
 * harness_resources 工具集成测试：
 * 模型被询问"装了哪些插件和技能"时调用该工具，返回本环境真实清单（预置技能可见），
 * 模型无需也不应扫描文件系统找其他软件的插件。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pih-rt-"));
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	events = [];
	core.router.onEvent((e) => events.push(e as AnyAppEvent));
	await invoke("settings:set", { defaultModel: fauxModelRef(), autoApproveTools: ["read", "grep", "find", "ls"] });
});

afterEach(() => {
	core.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("harness_resources 工具", () => {
	it("模型可查询本环境已装技能（返回预置技能与分类清单）", async () => {
		// 预置一个本地技能（本环境真实已装状态）
		const skillsDir = join(dir, "pi", "skills", "demo-skill");
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: demo-skill\n---\n# 演示技能\n", "utf8");

		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([
				fauxText("我用 harness_resources 查询本环境已装资源。"),
				fauxToolCall("harness_resources", {}),
			]),
			fauxAssistantMessage("查询完成。"),
		]);

		const task = await invoke("task:create", { title: "查询已装资源" });
		await invoke("task:prompt", { taskId: task.id, text: "我装了哪些插件和技能？" });
		await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "done"), "任务完成");

		const got = await invoke("task:get", { taskId: task.id });
		const toolResult = got.transcript.find(
			(m: { role: string; toolName?: string }) => m.role === "toolResult" && m.toolName === "harness_resources",
		);
		expect(toolResult).toBeDefined();
		expect(toolResult.isError).toBe(false);
		expect(toolResult.text).toContain("demo-skill");
		// 清单区分包与技能两类
		expect(toolResult.text).toContain("localSkills");
		// 资源清单同时注入系统提示词（模型不调工具也知道答案）
		expect(got.task.systemPrompt).toContain("本环境已装资源");
		expect(got.task.systemPrompt).toContain("demo-skill");
		expect(got.task.systemPrompt).toContain("禁止用 grep/find/ls 扫描文件系统");
	}, 60_000);

	it("角色自定义提示词不丢资源块（唯一事实源始终注入）", async () => {
		const skillsDir = join(dir, "pi", "skills", "another-skill");
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: another-skill\n---\n# x\n", "utf8");
		const role = await invoke("role:create", {
			name: "自定义角色",
			intro: "测试",
			systemPrompt: "你是专属评审员，只输出结论。",
			boundSkills: [],
			boundPlugins: [],
			preferredModel: null,
			preferredThinking: null,
		});
		ensureFauxRegistered().setResponses([fauxAssistantMessage("收到。")]);
		const task = await invoke("task:create", { title: "角色任务", roleId: role.id });
		await invoke("task:prompt", { taskId: task.id, text: "开始" });
		await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "done"), "任务完成");
		const got = await invoke("task:get", { taskId: task.id });
		expect(got.task.systemPrompt).toContain("你是专属评审员");
		expect(got.task.systemPrompt).toContain("another-skill");
	}, 60_000);

	it("私有资源对未绑定角色不可见（提示词与工具双通道），绑定角色可见，输出无路径", async () => {
		// 预置公开技能 + 私有技能
		for (const name of ["pub-skill", "priv-skill"]) {
			const skillsDir = join(dir, "pi", "skills", name);
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(join(skillsDir, "SKILL.md"), `---\nname: ${name}\n---\n# x\n`, "utf8");
		}
		await invoke("market:setVisibility", { name: "priv-skill", kind: "skill", visibility: "private" });

		const outsider = await invoke("role:create", {
			name: "局外角色",
			intro: "测试",
			systemPrompt: "",
			boundSkills: [],
			boundPlugins: [],
			preferredModel: null,
			preferredThinking: null,
		});
		const owner = await invoke("role:create", {
			name: "绑定角色",
			intro: "测试",
			systemPrompt: "",
			boundSkills: ["priv-skill"],
			boundPlugins: [],
			preferredModel: null,
			preferredThinking: null,
		});

		// 未绑定角色：提示词与工具结果都不得出现 priv-skill
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxText("查询。"), fauxToolCall("harness_resources", {})]),
			fauxAssistantMessage("完成。"),
		]);
		const t1 = await invoke("task:create", { title: "局外查询", roleId: outsider.id });
		await invoke("task:prompt", { taskId: t1.id, text: "我装了哪些技能？" });
		await waitFor(() => states().some((s) => s.taskId === t1.id && s.status === "done"), "局外任务完成");
		const g1 = await invoke("task:get", { taskId: t1.id });
		expect(g1.task.systemPrompt).not.toContain("priv-skill");
		expect(g1.task.systemPrompt).toContain("pub-skill");
		const r1 = g1.transcript.find((m: { role: string; toolName?: string }) => m.role === "toolResult" && m.toolName === "harness_resources");
		expect(r1).toBeDefined();
		expect(r1.text).not.toContain("priv-skill");
		expect(r1.text).toContain("pub-skill");
		// 工具输出不含安装路径（防 read 绕过）
		expect(r1.text).not.toContain("installedPath");
		expect(r1.text).not.toContain(dir);

		// 绑定角色：可见
		ensureFauxRegistered().setResponses([fauxAssistantMessage("收到。")]);
		const t2 = await invoke("task:create", { title: "绑定查询", roleId: owner.id });
		await invoke("task:prompt", { taskId: t2.id, text: "开始" });
		await waitFor(() => states().some((s) => s.taskId === t2.id && s.status === "done"), "绑定任务完成");
		const g2 = await invoke("task:get", { taskId: t2.id });
		expect(g2.task.systemPrompt).toContain("priv-skill");
	}, 90_000);
});
