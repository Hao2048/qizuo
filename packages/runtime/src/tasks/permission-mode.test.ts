/**
 * 四档权限模式集成测试（faux 驱动真实工具执行）：
 * ask=变更前确认（写/执行弹卡审批，默认）；auto_edit=自动编辑（write/edit 免审，bash 仍审）；
 * plan=计划模式（变更类工具直接拦截并给理由，不弹卡）；bypass=完全访问（全部放行）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AppEvent, ApprovalRequest, TaskStatus } from "@pi-harness/contracts";
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

function approvals(): ApprovalRequest[] {
	return events
		.filter((e): e is AppEvent<"task:approval"> => e.type === "task:approval")
		.map((e) => e.payload);
}

/** 工具执行结果（start/end 按 toolCallId 配对补工具名） */
function toolEnds(): Array<{ toolName: string; isError?: boolean; resultPreview?: string }> {
	const names = new Map<string, string>();
	for (const e of events) {
		if (e.type !== "task:stream") continue;
		const p = (e as AppEvent<"task:stream">).payload;
		if (p.kind === "tool_execution_start" && p.toolCallId && p.toolName) names.set(p.toolCallId, p.toolName);
	}
	const out: Array<{ toolName: string; isError?: boolean; resultPreview?: string }> = [];
	for (const e of events) {
		if (e.type !== "task:stream") continue;
		const p = (e as AppEvent<"task:stream">).payload;
		if (p.kind !== "tool_execution_end") continue;
		out.push({ toolName: names.get(p.toolCallId ?? "") ?? "?", isError: p.isError, resultPreview: p.resultPreview });
	}
	return out;
}

async function runTask(title: string): Promise<string> {
	const task = (await invoke("task:create", { title })) as { id: string };
	await invoke("task:prompt", { taskId: task.id, text: title });
	await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "done"), `任务完成：${title}`);
	return task.id;
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pih-perm-"));
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

describe("四档权限模式", () => {
	it("默认 ask；设置往返持久化", async () => {
		const initial = (await invoke("settings:get", {})) as { permissionMode?: string };
		expect(initial.permissionMode).toBe("ask");

		const next = (await invoke("settings:set", { permissionMode: "auto_edit", autoApproveTools: ["read", "grep", "find", "ls"] })) as { permissionMode?: string };
		expect(next.permissionMode).toBe("auto_edit");
		const again = (await invoke("settings:get", {})) as { permissionMode?: string };
		expect(again.permissionMode).toBe("auto_edit");
	});

	it("bash 敏感度分级：ask 模式下低敏命令免审直接执行", async () => {
		const target = join(dir, "low-risk.txt");
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: `echo low > "${target}"` })]),
			fauxAssistantMessage("完成。"),
		]);
		await runTask("低敏免审");

		expect(approvals()).toEqual([]);
		expect(readFileSync(target, "utf8")).toBe("low\n");
	});

	it("bash 敏感度分级：ask 模式下高敏命令（rm/sudo）弹卡审批", async () => {
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: `sudo rm -f "${dir}/nothing"` })]),
			fauxAssistantMessage("完成。"),
		]);
		const task = (await invoke("task:create", { title: "高敏审批" })) as { id: string };
		await invoke("task:prompt", { taskId: task.id, text: "高敏审批" });
		await waitFor(() => approvals().length > 0, "高敏 bash 审批请求出现");
		expect(approvals()[0]!.toolName).toBe("bash");
		await invoke("approval:decide", { taskId: task.id, toolCallId: approvals()[0]!.toolCallId, approved: false });
		await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "done"), "拒绝后完成");
	});

	it("auto_edit/bypass 文件修改不再生成自动备份", async () => {
		const existing = join(dir, "ckpt-existing.txt");
		writeFileSync(existing, "old-content");
		const fresh = join(dir, "ckpt-fresh.txt");

		await invoke("settings:set", { permissionMode: "auto_edit", autoApproveTools: ["read", "grep", "find", "ls"] });
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: existing, content: "new-content" })]),
			fauxAssistantMessage("写入完成"),
		]);
		const t1 = (await invoke("task:create", { title: "检查点-已有文件" })) as { id: string };
		await invoke("task:prompt", { taskId: t1.id, text: "改已有文件" });
		await waitFor(() => states().some((s) => s.taskId === t1.id && s.status === "done"), "auto_edit 任务完成");
		expect(readFileSync(existing, "utf8")).toBe("new-content");
		expect(core.checkpoints.list(t1.id)).toHaveLength(0);

		await invoke("settings:set", { permissionMode: "bypass", autoApproveTools: ["read", "grep", "find", "ls"] });
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: fresh, content: "created" })]),
			fauxAssistantMessage("新建完成"),
		]);
		const t2 = (await invoke("task:create", { title: "检查点-新建文件" })) as { id: string };
		await invoke("task:prompt", { taskId: t2.id, text: "新建文件" });
		await waitFor(() => states().some((s) => s.taskId === t2.id && s.status === "done"), "bypass 任务完成");
		expect(readFileSync(fresh, "utf8")).toBe("created");
		expect(core.checkpoints.list(t2.id)).toHaveLength(0);

	}, 30_000);

	it("auto_edit：write 免审直接落盘，高敏 bash 仍弹卡审批", async () => {
		await invoke("settings:set", { permissionMode: "auto_edit", autoApproveTools: ["read", "grep", "find", "ls"] });
		const target = join(dir, "auto-edit.txt");
		const junk = join(dir, "junk.txt");
		writeFileSync(junk, "j");
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxText("直接写入。"), fauxToolCall("write", { path: target, content: "auto\n" })]),
			fauxAssistantMessage([fauxToolCall("bash", { command: `rm -f "${junk}"` })]),
			fauxAssistantMessage("完成。"),
		]);
		const task = (await invoke("task:create", { title: "自动编辑" })) as { id: string };
		await invoke("task:prompt", { taskId: task.id, text: "自动编辑" });
		await waitFor(() => approvals().length > 0, "高敏 bash 审批请求出现");
		expect(approvals().map((a) => a.toolName)).toEqual(["bash"]);
		await invoke("approval:decide", { taskId: task.id, toolCallId: approvals()[0]!.toolCallId, approved: true });
		await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "done"), "批准后完成");

		expect(readFileSync(target, "utf8")).toBe("auto\n");
		expect(existsSync(junk)).toBe(false);
		const writeEnd = toolEnds().find((t) => t.toolName === "write");
		expect(writeEnd?.isError).toBe(false);
	}, 30_000);

	it("plan：write/bash 直接拦截并给理由（不弹卡），read 放行", async () => {
		await invoke("settings:set", { permissionMode: "plan", autoApproveTools: ["read", "grep", "find", "ls"] });
		const target = join(dir, "plan-out.txt");
		const readOnly = join(dir, "seed.txt");
		writeFileSync(readOnly, "seed");
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([
				fauxToolCall("read", { path: readOnly }),
				fauxToolCall("write", { path: target, content: "x" }),
				fauxToolCall("bash", { command: `echo x > "${target}"` }),
			]),
			fauxAssistantMessage("我先整理计划。"),
		]);
		await runTask("计划模式");

		expect(approvals()).toEqual([]);
		expect(existsSync(target)).toBe(false);
		const readEnd = toolEnds().find((t) => t.toolName === "read");
		expect(readEnd?.isError).toBe(false);
		for (const name of ["write", "bash"]) {
			const end = toolEnds().find((t) => t.toolName === name);
			expect(end?.isError).toBe(true);
			expect(end?.resultPreview ?? "").toContain("计划模式");
		}
	}, 30_000);

	it("bypass：bash 免审执行", async () => {
		await invoke("settings:set", { permissionMode: "bypass", autoApproveTools: ["read", "grep", "find", "ls"] });
		const target = join(dir, "bypass-out.txt");
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: `echo ok > "${target}"` })]),
			fauxAssistantMessage("完成。"),
		]);
		await runTask("完全访问");

		expect(approvals()).toEqual([]);
		expect(readFileSync(target, "utf8")).toBe("ok\n");
		const bashEnd = toolEnds().find((t) => t.toolName === "bash");
		expect(bashEnd?.isError).toBe(false);
	}, 30_000);
});

it("plan mode ignores write whitelists and keeps proposed steps pending", async () => {
 await invoke("settings:set",{permissionMode:"plan",autoApproveTools:["write","bash","save_memory"]});
 const target=join(dir,"blocked.txt");
 ensureFauxRegistered().setResponses([
  fauxAssistantMessage([fauxToolCall("tool_search",{query:"save_memory",limit:1})]),
  fauxAssistantMessage([
   fauxToolCall("write",{path:target,content:"bad"}),
   fauxToolCall("bash",{command:`echo bad > "${target}"`}),
   fauxToolCall("save_memory",{scope:"user",title:"bad",content:"bad"}),
   fauxToolCall("update_plan",{steps:[{content:"proposed",status:"completed"},{content:"next",status:"in_progress"}]}),
  ]),fauxAssistantMessage("方案待确认"),
 ]);
 const id=await runTask("仅规划");
 expect(existsSync(target)).toBe(false);
 for(const name of ["write","bash","save_memory"])expect(toolEnds().find(t=>t.toolName===name)?.isError).toBe(true);
 const got=await invoke("task:get",{taskId:id}) as {task:{plan:Array<{status:string}>}};
 expect(got.task.plan.map(s=>s.status)).toEqual(["pending","pending"]);
});
it("keeps a single current plan step while preserving completed work", async () => {
 await invoke("settings:set",{permissionMode:"bypass",autoApproveTools:[]});
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("update_plan",{steps:[{content:"done",status:"completed"},{content:"a",status:"in_progress"},{content:"b",status:"in_progress"}]})]),fauxAssistantMessage("ok")]);
 const id=await runTask("执行步骤");
 const got=await invoke("task:get",{taskId:id}) as {task:{plan:Array<{status:string}>}};
 expect(got.task.plan.map(s=>s.status)).toEqual(["completed","in_progress","pending"]);
});

it("plan mode permits Git inspection but blocks repository initialization", async()=>{
 await invoke("settings:set",{permissionMode:"plan",autoApproveTools:["harness_git"]});
 const projectDir=join(dir,"workspace");
 mkdirSync(projectDir);
 const project=await invoke("project:add",{dir:projectDir}) as {id:string};
 const task=await invoke("task:create",{projectId:project.id,title:"只读 Git"}) as {id:string};
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("harness_git",{action:"status"}),fauxToolCall("harness_git",{action:"init"})]),fauxAssistantMessage("待确认")]);
 await invoke("task:prompt",{taskId:task.id,text:"检查项目版本并给出方案"});
 await waitFor(()=>states().some(s=>s.taskId===task.id && s.status==="done"),"只读 Git 完成");
 expect(existsSync(join(projectDir,".git"))).toBe(false);
 const results=toolEnds().filter(t=>t.toolName==="harness_git");
 expect(results).toHaveLength(2);
 expect(results.filter(t=>t.isError)).toHaveLength(1);
 expect(results.find(t=>t.isError)?.resultPreview).toContain("计划模式");
});
