/**
 * 审批任务隔离回归：停止任务 B 不得拒绝任务 A 的待审批；decideApproval 跨任务决策被拒。
 * （历史缺陷：ApprovalManager 全局 rejectAll + decide 不校验 taskId）
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AppEvent, ApprovalRequest, TaskStatus } from "@pi-harness/contracts";
import { createHarnessCore, type HarnessCore } from "../core/harness-core.js";
import { ensureFauxRegistered, FAUX_MODEL_ID, FAUX_PROVIDER_ID } from "../pi/faux-provider.js";

let dir: string;
let core: HarnessCore;
let events: AppEvent[];

async function invoke<N extends Parameters<HarnessCore["router"]["invoke"]>[0]>(name: N, input: unknown): Promise<unknown> {
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

const states = () => events.filter((e): e is AppEvent<"task:state"> => e.type === "task:state").map((e) => e.payload);
const approvals = () => events.filter((e): e is AppEvent<"task:approval"> => e.type === "task:approval").map((e) => e.payload);

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pih-appr-"));
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

describe("审批任务隔离", () => {
	it("停止 B 不拒绝 A 的待审批；A 批准后正常完成", async () => {
		// 同一份 faux 队列对两个任务各自复制（faux 多实例隔离由 harness 的 enableFaux 处理）
		const taskA = (await invoke("task:create", { title: "任务A" })) as { id: string };
		const taskB = (await invoke("task:create", { title: "任务B" })) as { id: string };

		// 共享 faux 队列按消费时序：A 的 write → B 的 write → A 批准后的收尾
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: join(dir, "a.txt"), content: "a" })]),
			fauxAssistantMessage([fauxToolCall("write", { path: join(dir, "b.txt"), content: "b" })]),
			fauxAssistantMessage("A 完成"),
		]);

		await invoke("task:prompt", { taskId: taskA.id, text: "A 任务" });
		await waitFor(() => approvals().some((a) => a.taskId === taskA.id), "A 审批出现");

		await invoke("task:prompt", { taskId: taskB.id, text: "B 任务" });
		await waitFor(() => approvals().some((a) => a.taskId === taskB.id), "B 审批出现");

		// 停止 B：只有 B 的审批被拒；A 的仍挂起
		await invoke("task:abort", { taskId: taskB.id });
		await waitFor(() => states().some((s) => s.taskId === taskB.id && s.status === "cancelled"), "B 取消");

		const reqA = approvals().find((a) => a.taskId === taskA.id) as ApprovalRequest;
		expect(reqA).toBeTruthy();
		// 正常批准 A → A 继续并完成
		await invoke("approval:decide", { taskId: taskA.id, toolCallId: reqA.toolCallId, approved: true });
		await waitFor(() => states().some((s) => s.taskId === taskA.id && s.status === "done"), "A 批准后完成");
	}, 30_000);

	it("decideApproval 校验任务归属：错误 taskId 的决策不生效", async () => {
		const taskA = (await invoke("task:create", { title: "归属A" })) as { id: string };
		const taskB = (await invoke("task:create", { title: "归属B" })) as { id: string };
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: join(dir, "x.txt"), content: "x" })]),
			fauxAssistantMessage("A 完成"),
		]);
		await invoke("task:prompt", { taskId: taskA.id, text: "A" });
		await waitFor(() => approvals().length > 0, "A 审批出现");
		const reqA = approvals()[0]!;
		// 用 B 的 taskId 决策 A 的审批：应当失败（done=false）
		const r = (await invoke("approval:decide", { taskId: taskB.id, toolCallId: reqA.toolCallId, approved: true })) as { ok?: boolean; done?: boolean };
		// 决策未生效（返回 done:false / ok:false 均表示未命中），A 仍挂起
		expect(r.done ?? r.ok).toBeFalsy();
		// A 仍处 waiting_approval
		expect(states().some((s) => s.taskId === taskA.id && s.status === "waiting_approval")).toBe(true);
	}, 30_000);
});

it('lets two real sessions wait on the same provider call ID without cross-approval or implicit denial',async()=>{
 const taskA=(await invoke('task:create',{title:'重复调用ID-A'})) as {id:string};
 const taskB=(await invoke('task:create',{title:'重复调用ID-B'})) as {id:string};
 ensureFauxRegistered().setResponses([
  fauxAssistantMessage([fauxToolCall('write',{path:join(dir,'a.txt'),content:'a'},{id:'same-provider-id'})]),
  fauxAssistantMessage([fauxToolCall('write',{path:join(dir,'b.txt'),content:'b'},{id:'same-provider-id'})]),
  fauxAssistantMessage('A done')
 ]);
 await invoke('task:prompt',{taskId:taskA.id,text:'write A'});await waitFor(()=>approvals().some(x=>x.taskId===taskA.id),'A approval');
 await invoke('task:prompt',{taskId:taskB.id,text:'write B'});await waitFor(()=>approvals().some(x=>x.taskId===taskB.id),'B approval');
 const beforeB=await invoke('task:get',{taskId:taskB.id}) as any;expect(beforeB.pendingApprovals).toHaveLength(1);
 expect((await invoke('approval:decide',{taskId:taskA.id,toolCallId:'same-provider-id',approved:true}) as any).ok).toBe(true);
 await waitFor(()=>completedTask(taskA.id),'A finishes');
 const waitingB=await invoke('task:get',{taskId:taskB.id}) as any;expect(waitingB.task.status).toBe('waiting_approval');expect(waitingB.pendingApprovals).toHaveLength(1);
 await invoke('task:abort',{taskId:taskB.id});
 const {existsSync}=await import('node:fs');expect(existsSync(join(dir,'a.txt'))).toBe(true);expect(existsSync(join(dir,'b.txt'))).toBe(false);
 function completedTask(id:string){return states().some(s=>s.taskId===id&&s.status==='done');}
});
