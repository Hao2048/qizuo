/**
 * M7 集成/单元测试：
 * - 会话分叉：完整历史复制 + 叶子移动到指定轮次的结果 + 新任务续写新分支（faux 端到端）
 * - 凭证加密：cipher 注入（读/写/明文迁移/损坏回退）
 * - 市场每日推荐：npm 下载量排序 + 日缓存 + 网络失败降级（mock fetch）
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AnyAppEvent, AppEvent, TranscriptMessage } from "@pi-harness/contracts";
import { createHarnessCore, type HarnessCore } from "./core/harness-core.js";
import { ensureFauxRegistered, fauxModelRef } from "./pi/faux-provider.js";
import { FileApiKeyStore, type CredentialCipher } from "./pi/credentials.js";
import { MarketService } from "./market/market-service.js";
import { Logger } from "./logging/logger.js";

let dir: string;
let core: HarnessCore;
let events: AnyAppEvent[];

async function invoke(name: string, input: unknown): Promise<any> {
	const env = await core.router.invoke(name, input);
	if (!env.ok) throw new Error(`${name} 失败: ${env.error.message}`);
	return env.result;
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${what}`);
		await new Promise((r) => setTimeout(r, 30));
	}
}

const states = () =>
	events.filter((e): e is AppEvent<"task:state"> => e.type === "task:state").map((e) => e.payload);

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "pih-m7-"));
	core = await createHarnessCore({ dataDir: dir, enableFaux: true });
	events = [];
	core.router.onEvent((e) => events.push(e as AnyAppEvent));
	await invoke("settings:set", {
		defaultModel: fauxModelRef(),
		autoApproveTools: ["read", "grep", "find", "ls", "save_memory"],
	});
});

afterEach(() => {
	core.dispose();
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe("M7 会话分叉", () => {
	it("从第一轮分叉：指令与回复保留到轮次结束，新分支续写（faux 端到端）", async () => {
		// 原任务：两轮对话
		ensureFauxRegistered().setResponses([
			fauxAssistantMessage("第一轮回答。"),
			fauxAssistantMessage("第二轮回答。"),
			// 分叉任务续写
			fauxAssistantMessage("分叉后的新回答。"),
		]);
		const task = await invoke("task:create", { title: "原任务" });
		await invoke("task:prompt", { taskId: task.id, text: "第一问" });
		await waitFor(() => states().some((s) => s.taskId === task.id && s.status === "done"), "第一轮");
		await invoke("task:prompt", { taskId: task.id, text: "第二问" });
		await waitFor(
			() => states().filter((s) => s.taskId === task.id && s.status === "done").length >= 2,
			"第二轮",
		);

		// 取会话树用户消息
		const tree = await invoke("task:getTree", { taskId: task.id });
		expect(tree.userMessages.length).toBe(2);
		expect(tree.userMessages[0].text).toContain("第一问");

		// 从第一条消息分叉
		const fork = await invoke("task:fork", { taskId: task.id, entryId: tree.userMessages[0].entryId });
		expect(fork.title).toContain("分叉");
		expect(fork.projectId ?? null).toBeNull();

		await invoke("task:prompt", { taskId: fork.id, text: "换个方向再来" });
		await waitFor(() => states().some((s) => s.taskId === fork.id && s.status === "done"), "分叉任务完成");

		const got = await invoke("task:get", { taskId: fork.id });
		const texts = (got.transcript as TranscriptMessage[]).filter((m) => m.role === "user").map((m) => m.text);
		// 历史到分叉点为止：包含第一问，不包含第二问；再续新消息
		expect(texts.some((t) => t?.includes("第一问"))).toBe(true);
		expect(texts.some((t) => t?.includes("第二问"))).toBe(false);
		expect(texts.some((t) => t?.includes("换个方向再来"))).toBe(true);
		const answers = (got.transcript as TranscriptMessage[]).filter((m) => m.role === "assistant").map((m) => m.text);
		expect(answers.some((t) => t?.includes("第一轮回答"))).toBe(true);
        expect(answers.some((t) => t?.includes("第二轮回答"))).toBe(false);
        expect(answers.some((t) => t?.includes("分叉后的新回答"))).toBe(true);
	}, 60_000);

    it("分叉保留工具结果，重启后询问历史仅新增回答且不重放命令", async () => {
        const { SessionManager } = await import("@earendil-works/pi-coding-agent");
        const { existsSync } = await import("node:fs");
        const file = join(dir, "once.txt");
        await invoke("settings:set", { defaultModel: { ...fauxModelRef() }, autoApproveTools: ["read", "write"] });
        ensureFauxRegistered().setResponses([
            fauxAssistantMessage([fauxToolCall("write", {path:file,content:"written once"}, {id:"write-once"})]),
            fauxAssistantMessage("已经创建 once.txt。"),
            fauxAssistantMessage("第二轮答复。"),
        ]);
        const task = await invoke("task:create", {title:"执行记录"});
        await invoke("task:prompt", {taskId:task.id,text:"创建一次文件"});
        await waitFor(()=>states().some(s=>s.taskId===task.id&&s.status==="done"),"写入完成");
        expect(existsSync(file)).toBe(true);
        await invoke("task:prompt", {taskId:task.id,text:"另一个问题"});
        await waitFor(()=>states().filter(s=>s.taskId===task.id&&s.status==="done").length===2,"第二轮");
        const tree = await invoke("task:getTree",{taskId:task.id});
        const fork = await invoke("task:fork",{taskId:task.id,entryId:tree.userMessages[0].entryId});
        const before = await invoke("task:get",{taskId:fork.id});
        expect(before.transcript.some((m:TranscriptMessage)=>m.role==="toolResult"&&m.toolCallId==="write-once")).toBe(true);
        expect(before.transcript.some((m:TranscriptMessage)=>m.text==="已经创建 once.txt。")).toBe(true);
        expect(before.transcript.some((m:TranscriptMessage)=>m.text==="另一个问题")).toBe(false);
        expect(before.task.plan).toBeNull();
        const sourceRow = core.db.prepare("SELECT pi_session_id FROM tasks WHERE id = ?").get(task.id) as {pi_session_id:string};
        const assistantEntry = SessionManager.open(sourceRow.pi_session_id).getBranch().find(e=>e.type==="message"&&e.message.role==="assistant")!;
        await expect(invoke("task:fork",{taskId:task.id,entryId:assistantEntry.id})).rejects.toThrow(/没有待执行工具/);
        core.dispose(); core=await createHarnessCore({dataDir:dir,enableFaux:true});events=[];
        core.router.onEvent(e=>events.push(e as AnyAppEvent));
        let context = "";
        ensureFauxRegistered().setResponses([(ctx)=>{context=JSON.stringify(ctx);return fauxAssistantMessage("之前创建了 once.txt。");}]);
        await invoke("task:prompt",{taskId:fork.id,text:"之前做了什么？"});
        await waitFor(()=>states().some(s=>s.taskId===fork.id&&s.status==="done"),"历史询问");
        expect(context).toContain("已经创建 once.txt");
        expect(context).toContain("write-once");
        expect(context).not.toContain("另一个问题");
        const got=await invoke("task:get",{taskId:fork.id});
        expect(got.transcript.filter((m:TranscriptMessage)=>m.role==="toolResult")).toHaveLength(1);
        expect(got.task.systemPrompt).toContain("不要为回答历史询问重新执行命令");
        expect(events.some(e=>e.type==="task:stream"&&e.payload.kind==="tool_execution_start")).toBe(false);
    }, 60_000);

	it("无持久会话的任务分叉如实报错", async () => {
		const task = await invoke("task:create", { title: "空任务" });
		await expect(invoke("task:fork", { taskId: task.id, entryId: "x" })).rejects.toThrow(/无法分叉/);
	});
});

describe("M7 凭证加密", () => {
	const fakeCipher: CredentialCipher = {
		encrypt: (plain) => `ENC<${Buffer.from(plain, "utf8").toString("base64")}>`,
		decrypt: (stored) => {
			const m = stored.match(/^ENC<(.+)>$/);
			if (!m) throw new Error("非加密格式");
			return Buffer.from(m[1] ?? "", "base64").toString("utf8");
		},
		isEncrypted: (stored) => stored.startsWith("ENC<"),
	};

	it("写入加密、读取解密、密文落盘", async () => {
		const path = join(dir, "auth-enc.json");
		const store = new FileApiKeyStore(path, { cipher: fakeCipher });
		await store.modify("anthropic", async () => ({ type: "api_key" as const, key: "sk-1" }) as never);
		const raw = readFileSync(path, "utf8");
		expect(raw.startsWith("ENC<")).toBe(true);
		expect(raw.includes("sk-1")).toBe(false); // 明文密钥绝不落盘

		const store2 = new FileApiKeyStore(path, { cipher: fakeCipher });
		const cred = await store2.read("anthropic");
		expect((cred as { key?: string })?.key).toBe("sk-1");
	});

	it("明文旧文件自动迁移为密文", () => {
		const path = join(dir, "auth-mig.json");
		writeFileSync(path, JSON.stringify({ openai: { type: "api_key", key: "sk-old" } }), "utf8");
		const store = new FileApiKeyStore(path, { cipher: fakeCipher });
		void store;
		const raw = readFileSync(path, "utf8");
		expect(raw.startsWith("ENC<")).toBe(true);
		expect(raw.includes("sk-old")).toBe(false);
	});

	it("密文损坏时回退为空（不崩溃）", () => {
		const path = join(dir, "auth-bad.json");
		writeFileSync(path, "ENC<损坏数据", "utf8");
		const store = new FileApiKeyStore(path, { cipher: fakeCipher });
		void store.list().then((l) => expect(l).toEqual([]));
	});
});

describe("M7 市场每日推荐", () => {
	it("npm 检索 + 下载量排序 + 日缓存", async () => {
		let searchCalls = 0;
		let dlCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown) => {
				const u = String(url);
				if (u.includes("registry.npmjs.org/-/v1/search")) {
					searchCalls += 1;
					return new Response(
						JSON.stringify({
							objects: [
								{ package: { name: "@x/popular", description: "热门", version: "1.0.0" } },
								{ package: { name: "@x/quiet", description: "冷门", version: "1.0.0" } },
							],
						}),
						{ status: 200 },
					);
				}
				if (u.includes("api.npmjs.org/downloads")) {
					dlCalls += 1;
					// scoped 包逐个请求（URL 以 /@x/<name> 结尾）返回平铺单包格式；否则 bulk
					const single = u.match(/\/(@[A-Za-z0-9-]+\/[A-Za-z0-9._-]+)$/);
					if (single) {
						const name = single[1]!;
						return new Response(JSON.stringify({ downloads: name === "@x/popular" ? 9999 : 5, package: name }), { status: 200 });
					}
					return new Response(JSON.stringify({ "@x/quiet": { downloads: 5 }, "@x/popular": { downloads: 9999 } }), {
						status: 200,
					});
				}
				return new Response("{}", { status: 404 });
			}),
		);
		const market = await MarketService.create({ agentDir: join(dir, "pi"), cwd: dir, logger: new Logger(), emit: () => {}, getVisibility: () => "public", setVisibilityRow: () => {} });
		const meta = new Map<string, string>();
		const r1 = await market.recommend({
			get: (k) => meta.get(k) ?? null,
			set: (k, v) => meta.set(k, v),
		});
		expect(r1.items[0]!.name).toBe("@x/popular"); // 按下载量排序
		expect(r1.items[0]!.downloads).toBe(9999);
		expect(searchCalls).toBe(1);
		expect(dlCalls).toBe(2); // scoped 包逐个查询（bulk 接口不支持 @scope）

		// 第二次：当日缓存命中，不再发网络请求
		const r2 = await market.recommend({
			get: (k) => meta.get(k) ?? null,
			set: (k, v) => meta.set(k, v),
		});
		expect(r2.items).toEqual(r1.items);
		expect(searchCalls).toBe(1);
	});

	it("npm 检索失败 → 空推荐 + 如实说明", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
		const market = await MarketService.create({ agentDir: join(dir, "pi"), cwd: dir, logger: new Logger(), emit: () => {}, getVisibility: () => "public", setVisibilityRow: () => {} });
		const r = await market.recommend({ get: () => null, set: () => {} });
		expect(r.items).toEqual([]);
		expect(r.note).toContain("不可用");
	});
});
