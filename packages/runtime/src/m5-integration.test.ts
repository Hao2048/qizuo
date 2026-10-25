/**
 * M5 集成测试：
 * - MCP：原生 stdio JSON-RPC 最小服务器 → pi createMcpExtension 真实通路 → 模型调用 mcp 工具
 * - 上下文：真实回执口径 / 压缩入口
 * - 会话内切模型
 * - 团队/主管断点续跑（黑板恢复 + 子任务图续执行）
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const states = () =>
	events.filter((e): e is AppEvent<"task:state"> => e.type === "task:state").map((e) => e.payload);
const phases = () =>
	events.filter((e): e is AppEvent<"task:phase"> => e.type === "task:phase").map((e) => e.payload);

/** 原生 stdio MCP 服务器（JSON-RPC，零依赖）：initialize/tools-list/tools-call */
const MCP_ECHO_SERVER = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const reply = (msg, result, error) =>
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result, error }) + "\\n");
rl.on("line", (line) => {
	if (!line.trim()) return;
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.id === undefined || msg.id === null) return; // notification
	if (msg.method === "initialize") {
		reply(msg, { protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } });
	} else if (msg.method === "tools/list") {
		reply(msg, { tools: [{ name: "echo", description: "回显文本", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
	} else if (msg.method === "tools/call") {
		const text = msg.params?.arguments?.text ?? "";
		reply(msg, { content: [{ type: "text", text: "mcp回声:" + text }] });
	} else if (msg.method === "ping") {
		reply(msg, {});
	} else {
		reply(msg, undefined, { code: -32601, message: "method not found: " + msg.method });
	}
});
`;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pih-m5-"));
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	events = [];
	core.router.onEvent((e) => events.push(e as AnyAppEvent));
	await invoke("settings:set", {
		defaultModel: fauxModelRef(),
		autoApproveTools: ["read", "grep", "find", "ls", "save_memory", "harness_connect_mcp", "mcp__echo__echo"],
	});
});

afterEach(() => {
	core.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("M5 MCP", () => {
	it("stdio 服务器：配置→会话接入→模型调用 mcp 工具真实执行", async () => {
		const serverPath = join(dir, "echo-server.mjs");
		writeFileSync(serverPath, MCP_ECHO_SERVER, "utf8");
		const added = await invoke("mcp:add", {
			name: "echo",
			command: "node",
			args: [serverPath],
			description: "测试回显服务器",
		});
		expect(added.kind).toBe("stdio");

		const listed = await invoke("mcp:list", {});
		expect(listed.servers.some((s: { name: string }) => s.name === "echo")).toBe(true);

		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("harness_connect_mcp", { name: "echo" })]),
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "echo", limit: 1 })]),
			fauxAssistantMessage([
				fauxText("我用 MCP 工具回显一句话。"),
				fauxToolCall("mcp__echo__echo", { text: "你好MCP" }),
			]),
			fauxAssistantMessage("工具返回了。"),
		]);
		const task = await invoke("task:create", { title: "MCP 测试" });
		await invoke("task:prompt", { taskId: task.id, text: "调用 echo 工具" });
		await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "done"), "MCP 任务完成");

		const got = await invoke("task:get", { taskId: task.id });
		const toolResult = got.transcript.find(
			(m: { role: string; toolName?: string }) => m.role === "toolResult" && m.toolName === "mcp__echo__echo",
		);
		expect(toolResult).toBeDefined();
		expect(toolResult.isError).toBe(false);
		expect(toolResult.text).toContain("mcp回声:你好MCP");
	}, 60_000);

	it("配置 CRUD：重复名拒绝 / 移除 / 启停", async () => {
		await invoke("mcp:add", { name: "srv", command: "node", args: ["-v"] });
		await expect(invoke("mcp:add", { name: "srv", command: "node" })).rejects.toThrow(/已存在/);
		await invoke("mcp:setEnabled", { name: "srv", enabled: false });
		expect((await invoke("mcp:list", {})).servers[0].enabled).toBe(false);
		await invoke("mcp:remove", { name: "srv" });
		expect((await invoke("mcp:list", {})).servers).toHaveLength(0);
	});
});

describe("M5 上下文与模型", () => {
	it("getContext：真实回执口径（faux 零用量如实为 0，窗口已知）", async () => {
		ensureFauxRegistered().setResponses([fauxAssistantMessage("ok")]);
		const task = await invoke("task:create", { title: "ctx" });
		await invoke("task:prompt", { taskId: task.id, text: "hi" });
		await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "done"), "完成");
		const ctx = await invoke("task:getContext", { taskId: task.id });
		expect(ctx.contextWindow).toBeGreaterThan(0);
		expect(typeof ctx.lastRequestTokens).toBe("number");
		expect(ctx.note).toContain("回执");
	});

	it("会话内切模型：活动会话 setModel 生效并落库", async () => {
		ensureFauxRegistered().setResponses([fauxAssistantMessage("第一段")]);
		const task = await invoke("task:create", { title: "切模型" });
		await invoke("task:prompt", { taskId: task.id, text: "hi" });
		await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "done"), "完成");

		const r = await invoke("task:setModel", {
			taskId: task.id,
			provider: fauxModelRef("a").provider,
			modelId: fauxModelRef("a").modelId,
		});
		expect(r.ok).toBe(true);
		const got = await invoke("task:get", { taskId: task.id });
		expect(got.task.model).toEqual(fauxModelRef("a"));
	});

	it("压缩：活动会话可触发（faux 提供摘要响应）", async () => {
		// pi 的 token 估算按 chars/4（ASCII）；中文按字符也计。每轮 ~12k tokens，三轮超预算。
		const big = "This is long ASCII body text to grow the session well beyond the compaction keep-recent budget. ".repeat(700);
		ensureFauxRegistered("").setResponses([
			fauxAssistantMessage(big + " R1"),
			fauxAssistantMessage(big + " R2"),
			fauxAssistantMessage(big + " R3"),
			// 压缩内部可能发起多次摘要调用，多备几条
			fauxAssistantMessage("Summary A."),
			fauxAssistantMessage("Summary B."),
			fauxAssistantMessage("Summary C."),
		]);
		const task = await invoke("task:create", { title: "压缩" });
		for (const [i, text] of ["一", "二", "三"].entries()) {
			await invoke("task:prompt", { taskId: task.id, text });
			await waitFor(
				() => states().filter((s) => s.taskId === task.id && s.status === "done").length >= i + 1,
				`第${text}轮完成`,
			);
		}
		const r = await invoke("task:compact", { taskId: task.id });
		expect(r.ok).toBe(true);
	}, 120_000);
});
