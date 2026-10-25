/**
 * M2 集成测试（faux）：角色行为差异 / 记忆注入 / 模型解析链 / 检查点回滚。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AnyAppEvent, AppEvent, TranscriptMessage } from "@pi-harness/contracts";
import { createHarnessCore, type HarnessCore } from "../core/harness-core.js";
import { ensureFauxRegistered, FAUX_MODEL_ID, FAUX_PROVIDER_ID } from "../pi/faux-provider.js";

let dir: string;
let core: HarnessCore;
let events: AnyAppEvent[];

async function invoke(name: string, input: unknown): Promise<any> {
	const env = await core.router.invoke(name, input);
	if (!env.ok) throw new Error(`${name} 失败: ${env.error.message}`);
	return env.result;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

const states = () =>
	events.filter((e): e is AppEvent<"task:state"> => e.type === "task:state").map((e) => e.payload);
const approvals = () =>
	events.filter((e): e is AppEvent<"task:approval"> => e.type === "task:approval").map((e) => e.payload);

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pih-m2-"));
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	events = [];
	core.router.onEvent((e) => events.push(e as AnyAppEvent));
	await invoke("settings:set", {
		defaultModel: { provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID },
		autoApproveTools: ["read", "grep", "find", "ls"],
	});
});

afterEach(() => {
	core.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("M2 角色与记忆（faux）", () => {
	it("角色快照与模型解析链：任务强制 > 角色偏好 > 应用默认", async () => {
		ensureFauxRegistered().setResponses([fauxAssistantMessage("ok")]);
		const role = await invoke("role:create", {
			name: "诗人程序员",
			systemPrompt: "你以诗句风格写代码注释",
			preferredModel: { provider: "other", modelId: "other-model" },
		});

		// 角色偏好（无效 provider）→ 任务应报错说明模型不可用（诚实）
		const t1 = await invoke("task:create", { roleId: role.id, title: "角色偏好无效" });
		await expect(invoke("task:prompt", { taskId: t1.id, text: "hi" })).rejects.toThrow(/不可用/);

		// 任务强制模型覆盖角色偏好 → 成功
		const t2 = await invoke("task:create", {
			roleId: role.id,
			title: "强制覆盖",
			model: { provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID },
		});
		await invoke("task:prompt", { taskId: t2.id, text: "hi" });
		await waitFor(() => states().some((s) => s.status === "done"), "完成");
		const got = await invoke("task:get", { taskId: t2.id });
		expect(got.task.roleName).toBe("诗人程序员");
		expect(got.task.model).toEqual({ provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID });
		// 角色提示词进入有效系统提示词
		expect(got.task.systemPrompt).toContain("诗句风格");
	}, 30_000);

	it("记忆注入：用户/角色记忆动态进入请求而不破坏稳定系统前缀", async () => {
		let request="";ensureFauxRegistered().setResponses([ctx=>{request=JSON.stringify(ctx);return fauxAssistantMessage("ok");}]);
		const role = await invoke("role:create", { name: "带记忆角色", systemPrompt: "SP" });
		await invoke("memory:write", {
			scopeType: "role",
            scopeId:role.id,
			title: "用户偏好",
			content: "回答控制在三句话内",
		});
		await invoke("memory:write", {
			scopeType: "role",
			scopeId: role.id,
			title: "角色经验",
			content: "改配置前先备份",
		});

		const task = await invoke("task:create", {
			roleId: role.id,
			model: { provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID },
			title: "记忆注入",
		});
		await invoke("task:prompt", { taskId: task.id, text: "请按用户偏好和角色经验回答" });
		await waitFor(() => states().some((s) => s.status === "done"), "完成");

		const got = await invoke("task:get", { taskId: task.id });
		expect(got.task.systemPrompt).not.toContain("回答控制在三句话内");
        expect(request).toContain("回答控制在三句话内");
		expect(request).toContain("改配置前先备份");
	}, 30_000);

	it("save_memory 工具：模型调用 → 记忆落层（角色任务写角色层）", async () => {
		const role = await invoke("role:create", { name: "会记忆的角色", systemPrompt: "SP" });
		ensureFauxRegistered().setResponses([
            fauxAssistantMessage([fauxToolCall("tool_search",{query:"save_memory",limit:1})]),
			fauxAssistantMessage([
				fauxText("我记一下。"),
				fauxToolCall("save_memory", { scope: "role", title: "测试经验", content: "faux 驱动全链路可行" }),
			]),
			fauxAssistantMessage("记好了。"),
		]);

		const task = await invoke("task:create", {
			roleId: role.id,
			model: { provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID },
			title: "save_memory 链路",
		});
		await invoke("task:prompt", { taskId: task.id, text: "记住这个经验" });
		await waitFor(() => states().some((s) => s.status === "done"), "完成");

		const roleMem = await invoke("memory:list", { scopeType: "role", scopeId: role.id });
		expect(roleMem.items.some((m: { title: string }) => m.title === "测试经验")).toBe(true);
		expect(roleMem.items[0]?.sourceTaskId).toBe(task.id);
        expect(roleMem.items[0]?.quality?.verification).toBe("pending");
        expect(core.memory.retrieve({scopes:[{scopeType:"role",scopeId:role.id}]})).toEqual([]);

		// 转录包含工具结果（保存成功回执）
		const got = await invoke("task:get", { taskId: task.id });
		const toolResult = (got.transcript as TranscriptMessage[]).find((m) => m.role === "toolResult" && m.toolName === "save_memory");
		expect(toolResult?.isError).toBe(false);
		expect(toolResult?.text).toContain("角色记忆候选");
	}, 30_000);

	it("未指定角色时绑定默认助手，记忆写入该角色", async () => {
		ensureFauxRegistered().setResponses([
            fauxAssistantMessage([fauxToolCall("tool_search",{query:"save_memory",limit:1})]),
			fauxAssistantMessage([
				fauxToolCall("save_memory", { scope: "role", title: "错误归属", content: "x" }),
			]),
			fauxAssistantMessage("那算了。"),
		]);
		const task = await invoke("task:create", {
			model: { provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID },
			title: "范围校验",
		});
		await invoke("task:prompt", { taskId: task.id, text: "记住到角色层" });
		await waitFor(() => states().some((s) => s.status === "done"), "完成");

		const got = await invoke("task:get", { taskId: task.id });
		const toolResult = (got.transcript as TranscriptMessage[]).find((m) => m.role === "toolResult" && m.toolName === "save_memory");
		expect(toolResult?.isError).toBe(false);
		expect(toolResult?.text).toContain("角色记忆候选");
        expect(got.task.roleId).toBe(core.roles.seedDefault().id);
	}, 30_000);

	it("edit 审批保留差异，不再产生独立文件备份", async () => {
		const target = join(dir, "checkpoint-demo.txt");
		writeFileSync(target, "原始内容 v1");

		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([
				fauxToolCall("edit", { path: target, oldText: "原始内容 v1", newText: "被修改的内容 v2" }),
			]),
			fauxAssistantMessage("改完了。"),
		]);
		const task = await invoke("task:create", {
			model: { provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID },
			title: "检查点",
		});
		await invoke("task:prompt", { taskId: task.id, text: "改这个文件" });
		await waitFor(() => approvals().length > 0, "审批出现");
		await invoke("approval:decide", { taskId: task.id, toolCallId: approvals()[0]!.toolCallId, approved: true });
		await waitFor(() => states().some((s) => s.status === "done"), "完成");

		expect(readFileSync(target, "utf8")).toBe("被修改的内容 v2");

		expect(core.checkpoints.list(task.id)).toHaveLength(0);
		expect(core.router.has("checkpoint:restore")).toBe(false);
	}, 30_000);

	it("拒绝路径不产生检查点", async () => {
		const target = join(dir, "deny-checkpoint.txt");
		writeFileSync(target, "保持不变");
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: target, content: "新内容" })]),
			fauxAssistantMessage("好的。"),
		]);
		const task = await invoke("task:create", {
			model: { provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID },
			title: "拒绝检查点",
		});
		await invoke("task:prompt", { taskId: task.id, text: "写文件" });
		await waitFor(() => approvals().length > 0, "审批出现");
		await invoke("approval:decide", { taskId: task.id, toolCallId: approvals()[0]!.toolCallId, approved: false });
		await waitFor(() => states().some((s) => s.status === "done"), "完成");

		expect(readFileSync(target, "utf8")).toBe("保持不变");
		const checkpoints = core.checkpoints.list(task.id);
		expect(checkpoints.length).toBe(0);
	}, 30_000);

	it("运行中任务的角色卡编辑不影响快照（隔离）", async () => {
		ensureFauxRegistered().setResponses([fauxAssistantMessage("第一轮")]);
		const role = await invoke("role:create", { name: "原始", systemPrompt: "提示A" });
		const task = await invoke("task:create", {
			roleId: role.id,
			model: { provider: FAUX_PROVIDER_ID, modelId: FAUX_MODEL_ID },
			title: "快照隔离",
		});
		await invoke("task:prompt", { taskId: task.id, text: "hi" });
		await waitFor(() => states().some((s) => s.status === "done"), "第一轮完成");

		await invoke("role:update", { roleId: role.id, systemPrompt: "提示B" });

		const got = await invoke("task:get", { taskId: task.id });
		expect(got.task.systemPrompt).toContain("提示A");
	}, 30_000);
});

it("refreshes revised and forgotten memory on the next request without persisting injected memory in history",async()=>{
 const role=core.roles.create({name:"记忆测试",systemPrompt:"按经验工作"});
 const memory=core.memory.write({scopeType:"role",scopeId:role.id,title:"配置经验",content:"old-method"});
 const other=core.roles.create({name:"其他角色"});core.memory.write({scopeType:"role",scopeId:other.id,title:"配置经验",content:"other-private-method"});
 const task=await invoke("task:create",{roleId:role.id});const requests:string[]=[];
 ensureFauxRegistered().setResponses(Array.from({length:3},()=>ctx=>{requests.push(JSON.stringify(ctx.messages));return fauxAssistantMessage("收到");}));
 await invoke("task:prompt",{taskId:task.id,text:"使用配置经验"});await waitFor(()=>states().filter(e=>e.taskId===task.id && e.status==="done").length===1,"first");
 core.memory.revise(memory.id,{content:"new-method"});
 await invoke("task:prompt",{taskId:task.id,text:"再次使用配置经验"});await waitFor(()=>states().filter(e=>e.taskId===task.id && e.status==="done").length===2,"second");
 core.memory.forget(memory.id);
 await invoke("task:prompt",{taskId:task.id,text:"再次使用配置经验"});await waitFor(()=>states().filter(e=>e.taskId===task.id && e.status==="done").length===3,"third");
 expect(requests[0]).toContain("old-method");expect(requests[1]).toContain("new-method");expect(requests[1]).not.toContain("old-method");expect(requests[2]).not.toContain("new-method");for(const request of requests)expect(request).not.toContain("other-private-method");
 expect(JSON.stringify((await invoke("task:get",{taskId:task.id})).transcript)).not.toContain("new-method");
});
it("删除来源任务保留角色记忆来源标识并可展示已删除状态",async()=>{
 const role=core.roles.create({name:"保留出处"}),task=await core.tasks.createTask({roleId:role.id,title:"来源"});
 const m=core.memory.write({scopeType:"role",scopeId:role.id,title:"已核对的方法",content:"实际方法",sourceTaskId:task.id,sourceNote:"用户核对依据"});
 await invoke("task:delete",{taskId:task.id});expect(core.memory.get(m.id)).toMatchObject({sourceTaskId:task.id,sourceDeleted:true,quality:{evidence:"用户核对依据"}});
});
it("公开记忆写入不能伪造已联调验证状态或借用来源",async()=>{
 const role=core.roles.create({name:"普通角色"});const m=await invoke("memory:write",{scopeType:"role",scopeId:role.id,title:"用户记录",content:"方法",quality:{verification:"verified",source:"workbench",evidence:"伪造"},sourceTaskId:"other-task"});
 expect(m.quality).toMatchObject({verification:"confirmed",source:"manual"});expect(m.sourceTaskId).toBeNull();
});
