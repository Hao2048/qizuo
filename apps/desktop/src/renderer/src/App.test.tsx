import { describe, expect, it, afterEach, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";
import App from "./App.js";
import { useStore } from "./store.js";
import type { AnyAppEvent as AppEvent } from "@pi-harness/contracts";
import type { PiHBridge } from "./api.js";

// jsdom 不实现 scrollIntoView（对话区自动滚动），环境垫片
Element.prototype.scrollIntoView = vi.fn();

const validHealth = {
	ok: true,
	appVersion: "0.1.0-test",
	schemaVersion: 2,
	dataDir: "/tmp/pih-data",
	logFile: "/tmp/pih-data/logs/app.jsonl",
	uptimeMs: 1234,
	steps: [
		{ name: "sqlite", ok: true, detail: "SQLite 3.x" },
		{ name: "migrations", ok: true, detail: "schema v2" },
		{ name: "logger", ok: true, detail: "/tmp/log" },
		{ name: "router", ok: true, detail: "命令已注册" },
	],
};

const providers = [
	{
		id: "pih-faux",
		name: "Faux 测试模型",
		authConfigured: true,
		models: [{ id: "faux-1", name: "Faux 1", api: "pih-faux", provider: "pih-faux" }],
	},
	{
		id: "anthropic",
		name: "Anthropic",
		authConfigured: false,
		models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", api: "anthropic-messages", provider: "anthropic" }],
	},
];

function installBridge(): { invoke: ReturnType<typeof vi.fn>; emit: (e: AppEvent) => void } {
	let taskSeq = 0;
 let workbenchItem:Record<string,unknown>|null=null;
	// 市场已装包为可变状态：安装命令会追加，验证「已安装」状态回显
	const installedPackages = [{ source: "npm:demo-pkg@1.0.0", scope: "user", installedPath: "/x/demo-pkg", visibility: "public" }];
	// MCP 令牌为可变状态：配置后 missingVars 动态清空，验证徽章翻转
	const mcpCreds = new Set<string>();
	const GH_VAR = "GITHUB_PERSONAL_ACCESS_TOKEN";
	const invoke = vi.fn(async (name: string, payload?: unknown) => {
		switch (name) {
			case "health:get":
				return { ok: true, result: validHealth };
			case "dev:ping":
				return { ok: true, result: { echo: (payload as { echo: string }).echo, pong: true, ts: 1 } };
			case "model:list":
				return { ok: true, result: { providers } };
			case "settings:get":
				return { ok: true, result: { defaultModel: null, autoApproveTools: ["read", "grep", "find", "ls"], sandboxMode: "off" } };
			case "settings:set":
				return { ok: true, result: payload };
			case "project:list":
				return { ok: true, result: { projects: [] } };
			case "project:pickFolder":
				return { ok: true, result: { dir: null } };
            case "workbench:create":workbenchItem={id:"wb-smoke",title:"冒烟协作",phase:"draft",participants:[],messages:[],recommendations:[],contracts:[],proposals:[],projectId:null,revision:0,createdAt:1,updatedAt:1};return {ok:true,result:workbenchItem};
            case "workbench:list":return {ok:true,result:{items:workbenchItem ? [workbenchItem] : []}};
            case "workbench:attach":return {ok:true,result:{id:"smoke-image",name:"smoke.png",kind:"image",mimeType:"image/png",bytes:80}};
            case "workbench:readAttachment":return {ok:true,result:{attachment:{id:"smoke-image",name:"smoke.png",kind:"image",mimeType:"image/png",bytes:80},data:"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=="}};
            case "workbench:discardAttachment":return {ok:true,result:{ok:true}};
            case "workbench:delete":workbenchItem=null;return {ok:true,result:{ok:true}};
			case "task:list":
				return { ok: true, result: { tasks: [] } };
			case "task:create":
				taskSeq += 1;
				return {
					ok: true,
					result: {
						id: `task-${taskSeq}`,
						title: "t",
						status: "draft",
						mode: (payload as { mode?: string })?.mode ?? "single",
						projectId: null,
						dir: null,
						model: null,
						roleId: null,
						roleName: null,
						systemPrompt: null,
						members: [],
						createdAt: 1,
						updatedAt: 1,
					},
				};
			case "task:get":
				return {
					ok: true,
					result: {
						task: {
							id: (payload as { taskId: string }).taskId,
							title: "t",
							status: "done",
							mode: "single",
							projectId: null,
							dir: null,
							model: null,
							roleId: null,
							roleName: null,
							systemPrompt: "你是运行在 栖作 Qizuo 中的专业编程助理……【用户】工作偏好",
							members: [],
							createdAt: 1,
							updatedAt: 1,
						},
						transcript: [],
					},
				};
			case "task:prompt":
				return { ok: true, result: { accepted: true } };
			case "task:getUsage":
				return {
					ok: true,
					result: {
						byRole: [
							{ roleId: "role-1", roleName: "架构师", input: 1200, output: 300, cacheRead: null, cacheWrite: null, calls: 3 },
							{ roleId: "role-2", roleName: "前端", input: 800, output: 200, cacheRead: null, cacheWrite: null, calls: 2 },
						],
						total: { input: 2000, output: 500, calls: 5 },
					},
				};
			case "task:recommendDecide":
				return { ok: true, result: { ok: true } };
			case "task:resolveDispute":
				return { ok: true, result: { ok: true } };
			case "mcp:diagnostics": return {items:[]};
			case "mcp:list":
					return {
						ok: true,
						result: {
							servers: [
								{ name: "filesystem", kind: "stdio", command: "npx", args: ["-y"], url: null, description: null, enabled: true },
								{
									name: "github", kind: "http", command: null, url: "https://api.githubcopilot.com/mcp/",
									description: "来自官方插件 github", enabled: true,
									authVars: [GH_VAR],
									missingVars: mcpCreds.has(GH_VAR) ? [] : [GH_VAR],
								},
							],
						},
					};
			case "mcp:setCredential":
				if ((payload as { varName?: string })?.varName) mcpCreds.add(String((payload as { varName: string }).varName));
				return { ok: true, result: { ok: true } };
			case "mcp:clearCredential":
				if ((payload as { varName?: string })?.varName) mcpCreds.delete(String((payload as { varName: string }).varName));
				return { ok: true, result: { ok: true } };
			case "market:authInfo":
 return { ok: true, result: { source: (payload as { source: string }).source, kind: (payload as { source: string }).source === "claude:github" ? "oauth" : "none", status: (payload as { source: string }).source === "claude:github" && !mcpCreds.has(GH_VAR) ? "required" : "ready", servers: [] } };
            case "market:authStart":
 mcpCreds.add(GH_VAR);
 return { ok: true, result: { source: (payload as { source: string }).source, kind: "oauth", status: "ready", servers: [] } };
			case "sys:openExternal":
				if (!/^https:\/\//.test(String((payload as { url: string }).url))) return { ok: true, result: { ok: false } };
				return { ok: true, result: { ok: true } };
			case "mcp:add":
				return { ok: true, result: { name: "new-srv", kind: "stdio", command: "node", args: [], url: null, description: null, enabled: true } };
			case "mcp:remove":
				return { ok: true, result: { ok: true } };
			case "mcp:setEnabled":
				return { ok: true, result: { ok: true } };
            case "task:getRoleContexts":
                return {ok:true,result:{roles:[{roleId:null,roleName:"默认助手",kind:"single",context:{currentTokens:4200,contextWindow:128000,percent:3.3}}]}};
			case "task:getContext":
				return { ok: true, result: { lastRequestTokens: 4200, contextWindow: 128000, percent: 3.3, cacheRead: 1200, cacheWrite: null, note: "按最近一次请求回执计" } };
			case "task:compact":
				return { ok: true, result: { ok: true } };
			case "task:setThinking":
            case "task:setModel":
				return { ok: true, result: { ok: true } };
			case "prompt:list":
				return { ok: true, result: { prompts: [{ name: "review", description: "代码评审", argumentHint: "文件路径" }] } };
			case "market:list":
				return {
					ok: true,
					result: {
						packages: [...installedPackages, { source: "npm:pi-lens", scope: "user", installedPath: null, visibility: "public", core: true, intro: "代码反馈：LSP、lint、类型检查改动即时回贴" }],
						localSkills: [{ name: "pdf-tools", source: "local", visibility: "public" }],
						localExtensions: [],
					},
				};
			case "market:setVisibility":
				return { ok: true, result: { ok: true } };
			case "market:listPi":
				return {
					ok: true,
					result: {
						items: [
							{ source: "npm:pi-web-access", name: "pi-web-access", description: "Web search and fetching", downloads: 1234 },
							{ source: "npm:pi-subagents", name: "pi-subagents", description: "Multi-agent workflows", downloads: null },
						],
					},
				};
			case "resource:listBindable":
				return {
					ok: true,
					result: {
						items: [
							{ name: "pdf-tools", kind: "skill" },
							{ name: "demo-skill", kind: "skill" },
							{ name: "npm:demo-pkg@1.0.0", kind: "package" },
						],
					},
				};
			case "market:searchNpm":
				return {
					ok: true,
					result: {
						items: [
							{ name: "@demo/pi-tools", description: "演示工具集", version: "1.2.0", publisher: "demo", date: null },
						],
					},
				};
			case "market:installNpm": {
				const spec = (payload as { spec: string }).spec;
				installedPackages.push({ source: `npm:${spec}`, scope: "user", installedPath: `/x/${spec}`, visibility: "public" });
				return { ok: true, result: { ok: true } };
			}
			case "market:remove":
				return { ok: true, result: { ok: true } };
			case "market:pickLocal":
				return { ok: true, result: { path: null } };
			case "task:getTree":
				return {
					ok: true,
					result: { userMessages: [{ entryId: "e1", text: "第一问" }, { entryId: "e2", text: "第二问" }] },
				};
			case "task:fork":
				return {
					ok: true,
					result: { id: "task-9", title: "原任务 分叉", status: "draft", mode: "single", projectId: null, dir: null, model: null, roleId: null, roleName: null, systemPrompt: null, members: [], createdAt: 1, updatedAt: 1 },
				};
			case "market:recommend":
				return {
					ok: true,
					result: {
						items: (payload as { source: string }).source === "claude" ? [] : [
							{ name: "@x/popular", description: "热门包", downloads: 9999, source: "npm" },
							{ name: "@x/quiet", description: null, downloads: null, source: "npm" },
						],
						generatedAt: 1,
					},
				};
			case "settings:setApproval":
				return { ok: true, result: { ok: true } };
			case "market:listClaude":
					return {
						ok: true,
						result: {
							items: [
								{ name: "docx", description: "Word 文档技能", license: "Proprietary", fileCount: 3, fallback: false },
								{ name: "pdf", description: "PDF 处理", license: null, fileCount: 1, fallback: true },
								{ name: "github", description: "GitHub 官方 MCP 插件", license: null, fileCount: 1, fallback: false, kind: "mcp-plugin" },
							],
							fallbackSource: false,
						},
					};
			case "market:claudeDetail":
				return { ok: true, result: { content: "---\nname: docx\n---\n# DOCX 技能正文" } };
			case "market:installClaude":
				return { ok: true, result: { ok: true, message: "已安装 docx（3 个文件）", files: ["SKILL.md"] } };
			case "backup:list":
				return { ok: true, result: { backups: [{ id: "backup-1", createdAt: 1, path: "/b1", sizeBytes: 1024 }] } };
			case "backup:create":
				return { ok: true, result: { id: "backup-2", createdAt: 2, path: "/b2" } };
            case "git:status":
                return {ok:true,result:{available:true,repository:true,root:"/tmp/project",branch:"main",head:"a".repeat(40),files:[{path:"a.ts",status:" M",staged:false,tracked:true,conflicted:false}],branches:["main"],commits:[]}};
            case "git:diff": return {ok:true,result:{text:"-old\n+new",version:"version-1",truncated:false}};
            case "git:mutate": return {ok:true,result:{available:true,repository:true,root:"/tmp/project",branch:"main",head:"a".repeat(40),files:[],branches:["main"],commits:[]}};
            case "task:delete": return {ok:true,result:{ok:true}};
			case "task:getWorkspaceFiles":
				return {
					ok: true,
					result: { files: [{ relPath: "node-1/out.txt", sizeBytes: 12 }], root: "/ws" },
				};
			case "task:writeBack":
				return { ok: true, result: { ok: true, targetPath: "/proj/out.txt" } };
			case "approval:decide":
				return { ok: true, result: { ok: true } };
			case "role:list":
				return {
					ok: true,
					result: {
						roles: [
							{ id: "role-1", name: "默认助手", intro: "框架默认角色", systemPrompt: "你是……", boundSkills: [], boundPlugins: [], preferredModel: null, preferredThinking: null, isDefault: true, status: "active", memoryCount: 1, createdAt: 1, updatedAt: 1 },
							{ id: "role-2", name: "代码评审员", intro: "评审代码", systemPrompt: "SP2", boundSkills: [], boundPlugins: [], preferredModel: null, preferredThinking: null, isDefault: false, status: "active", memoryCount: 0, createdAt: 1, updatedAt: 1 },
						],
					},
				};
			case "role:create":
				return {
					ok: true,
					result: {
						id: `role-new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
						name: (payload as { name?: string })?.name ?? "新角色",
						intro: "",
						systemPrompt: "",
						boundSkills: [],
						boundPlugins: [],
						preferredModel: (payload as { preferredModel?: unknown })?.preferredModel ?? null,
						preferredThinking: null,
						isDefault: false,
						status: "active",
						memoryCount: 0,
						createdAt: 1,
						updatedAt: 1,
					},
				};
			case "memory:list":
				return {
					ok: true,
					result: {
						items: [
							{ id: "mem-1", scopeType: "role", scopeId: "role-1", scopeLabel: "任务助手", title: "冒烟记忆", content: "faux 全链路冒烟于本机通过", summary: "", tags: [], status: "active", sourceTaskId: null, version: 1, createdAt: 1, updatedAt: 1 },
						],
						total: 1,
					},
				};
			case "memory:history":
				return {
					ok: true,
					result: {
						versions: [
							{ ver: 1, title: "冒烟记忆", content: "faux 全链路冒烟于本机通过", reason: null, createdAt: 1 },
						],
					},
				};
			case "memory:forget":
				return { ok: true, result: { ok: true } };
			default:
				return { ok: true, result: { received: true } };
		}
	});
	const listeners = new Set<(e: unknown) => void>();
	const bridge: PiHBridge = {
		invoke,
        onEvent: (cb) => { listeners.add(cb); return () => {listeners.delete(cb);}; },
		platform: "darwin",
		versions: { electron: "44.0.0", chrome: "140.0.0" },
	};
	(window as unknown as { pih: PiHBridge }).pih = bridge;
	const emit = (e: AppEvent) => act(() => {for(const listener of listeners) listener(e);});
	return { invoke, emit };
}

afterEach(() => {
	cleanup();
	delete (window as unknown as { pih?: PiHBridge }).pih;
	window.history.replaceState({}, "", "/");
	// zustand store 跨用例持久——显式复位，避免测试间污染
	useStore.setState({
		page: "workbench",
		tool: "workbench",
		marketTab: "plugins",
	pluginsSource: "pi",
	skillsSource: "claude",
		settingsSection: "model",
		selectedRoleId: null,
		selectedMemoryId: null,
		drilledProjectId: null,
		memoryScope: "role",
		memoryQuery: "",
		currentTaskId: null,
		draftProjectId: null,
		draftRoleId: null,
		draftModel: null,
        draftThinking:null,
		transcript: [],
		toolCards: [],
		streamingText: "",
		streamingThinking: "",
		taskStatus: null,
        runProgress:null,
        preparingMessage:false,
		pendingApproval: null,
		plan: null,
		question: null,
		notice: null,
		loginEvent: null,
		contextInfo: null,
		prompts: [],
		forkCandidates: null,
		bindable: [],
	});
});

describe("App 骨架与导航", () => {
	it("渲染主导航五项（图标栏）", async () => {
		installBridge();
		render(<App />);
		for (const label of ["工作台", "角色卡", "记忆", "Skill 与插件", "模型与设置"]) {
			expect(screen.getByLabelText(label)).toBeTruthy();
		}
	});

	it("新对话按钮清空当前任务回到工作台", async () => {
		installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("新建对话"));
		expect(screen.getByPlaceholderText(/描述任务/)).toBeTruthy();
	});
});

describe("M1 对话流", () => {
	it("输入并发送：创建任务→上屏用户消息→调用 prompt", async () => {
		const { invoke } = installBridge();
		render(<App />);
		const textarea = screen.getByPlaceholderText(/描述任务/) as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: "帮我看看目录" } });
		fireEvent.keyDown(textarea, { key: "Enter" });

		await waitFor(() => expect(invoke).toHaveBeenCalledWith("task:create", expect.anything()));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("task:prompt", expect.objectContaining({ taskId: "task-1" })));
		expect(screen.getByText("帮我看看目录")).toBeTruthy();
	});

	it("流式事件驱动：text_delta 累积、message_end 落转录、状态切换", async () => {
		const { emit } = installBridge();
		render(<App />);
		const textarea = screen.getByPlaceholderText(/描述任务/) as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: "hi" } });
		fireEvent.keyDown(textarea, { key: "Enter" });

		await waitFor(() => screen.getByText("hi"));
		emit({ type: "task:state", ts: 1, payload: { taskId: "task-1", status: "running" } });
		emit({ type: "task:stream", ts: 2, payload: { taskId: "task-1", kind: "text_delta", delta: "你" } });
		emit({ type: "task:stream", ts: 3, payload: { taskId: "task-1", kind: "text_delta", delta: "好" } });
		expect(screen.getByText("你好")).toBeTruthy();

		emit({
			type: "task:stream",
			ts: 4,
			payload: { taskId: "task-1", kind: "assistant_message_end", message: { id: "m1", role: "assistant", text: "你好" } },
		});
		emit({ type: "task:state", ts: 5, payload: { taskId: "task-1", status: "done" } });
		await waitFor(() => screen.getByText("已完成"));
	});

	it("计划条：task:plan 事件实时渲染步骤与进度", async () => {
		const { emit } = installBridge();
		render(<App />);
		useStore.getState().selectTask("task-1");
		// 需先选中任务（事件带 taskId 且 currentTaskId 为 null 时也接受——与 state 事件口径一致）
		emit({
			type: "task:plan",
			ts: 1,
			payload: {
				taskId: "task-1",
				steps: [
					{ content: "读取配置", status: "completed" },
					{ content: "修改代码", status: "in_progress" },
					{ content: "验证结果", status: "pending" },
				],
			},
		});
		expect(await screen.findByText("任务计划")).toBeTruthy();
		expect(screen.getByText("1/3")).toBeTruthy();
		expect(screen.queryByText("读取配置")).toBeNull();
        expect(screen.queryByText("验证结果")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "查看完整计划" }));
        expect(screen.getByText("读取配置")).toBeTruthy();
		expect(screen.getByText("修改代码").closest(".plan-step")!.className).toContain("in_progress");
		expect(screen.getByText("验证结果").closest(".plan-step")!.className).toContain("pending");
		// 无步骤后隐藏
		emit({ type: "task:plan", ts: 2, payload: { taskId: "task-1", steps: [] } });
		await waitFor(() => expect(screen.queryByText("任务计划")).toBeNull());
	});

	it("工具卡与审批卡：事件渲染 + 批准决策走真实命令", async () => {
		const { invoke, emit } = installBridge();
		render(<App />);
		useStore.getState().selectTask("task-1");
        emit({type:"task:state",ts:0,payload:{taskId:"task-1",status:"running"}});
		emit({
			type: "task:stream",
			ts: 1,
			payload: { taskId: "task-1", kind: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls -la" } },
		});
		expect(await screen.findByText("bash")).toBeTruthy();
		emit({
			type: "task:stream",
			ts: 2,
			payload: { taskId: "task-1", kind: "tool_execution_end", toolCallId: "c1", isError: false, durationMs: 120, resultPreview: "total 0" },
		});

		emit({
			type: "task:approval",
			ts: 3,
			payload: { taskId: "task-1", toolCallId: "c2", toolName: "write", input: { path: "/tmp/x" } },
		});
		expect(await screen.findByText(/请求执行工具操作/)).toBeTruthy();
		fireEvent.click(screen.getByText("批准执行"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("approval:decide", {
				taskId: "task-1",
				toolCallId: "c2",
				approved: true,
			}),
		);
		await waitFor(() => expect(screen.queryByText(/请求执行工具操作/)).toBeNull());
	});

	it("审批拒绝路径", async () => {
		const { invoke, emit } = installBridge();
		render(<App />);
		useStore.getState().selectTask("task-1");
		emit({
			type: "task:approval",
			ts: 1,
			payload: { taskId: "task-1", toolCallId: "c9", toolName: "bash", input: { command: "rm -rf /" } },
		});
		fireEvent.click(await screen.findByText("拒绝"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("approval:decide", expect.objectContaining({ approved: false })),
		);
	});
});

describe("M1 设置页", () => {
	it("提供商列表渲染并支持保存 API Key", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("模型与设置"));
		fireEvent.click(await screen.findByText("账号与连接"));
		expect(await screen.findByText("Anthropic")).toBeTruthy();
		fireEvent.click(screen.getByText("配置 API Key"));
		const input = screen.getByPlaceholderText("API Key") as HTMLInputElement;
		fireEvent.change(input, { target: { value: "sk-test" } });
		fireEvent.click(screen.getByText("保存"));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("model:setApiKey", { provider: "anthropic", apiKey: "sk-test" }));
	});

	it("运行自检", async () => {
		installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("模型与设置"));
		fireEvent.click(await screen.findByText("关于软件"));
		fireEvent.click(await screen.findByText("运行系统自检"));
		await waitFor(() => screen.getByText("自检通过"));
	});
});

describe("M2 角色卡与记忆页", () => {
	it("角色卡列表渲染默认/自定义角色并可打开编辑器", async () => {
		installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("角色卡"));
		expect(await screen.findByText("默认助手")).toBeTruthy();
		expect(screen.getByText("代码评审员")).toBeTruthy();
		fireEvent.click(screen.getByTitle("角色卡").querySelector(".ctx-add") ?? screen.getByLabelText("新建角色"));
		expect(await screen.findByPlaceholderText("如：代码评审员")).toBeTruthy();
	});

	it("克隆对话框提供两种模式", async () => {
		installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("角色卡"));
		fireEvent.click((await screen.findByText("代码评审员")).closest("button")!);
		fireEvent.click(await screen.findByText("克隆角色"));
		expect(await screen.findByText("仅复制配置")).toBeTruthy();
		expect(screen.getByText("配置和记忆快照")).toBeTruthy();
	});

	it("记忆：中列列表→点选→右列详情含忘记", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("记忆"));
		fireEvent.click((await screen.findByRole("button",{name:/冒烟记忆/})).closest("button")!);
		const forgetBtn = await screen.findByText("忘记", {}, { timeout: 5000 });
		fireEvent.click(forgetBtn);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("memory:forget", { memoryId: "mem-1" }),
		);
	}, 15000);

	it("审批先显示具体影响，原始命令默认收起且保持审批标识", async()=>{
        const {emit,invoke}=installBridge();render(<App/>);useStore.getState().selectTask("task-1");
        emit({type:"task:state",ts:0,payload:{taskId:"task-1",status:"running"}});
        emit({type:"task:stream",ts:0,payload:{taskId:"task-1",kind:"tool_execution_start",toolCallId:"delete-1",toolName:"bash",args:{command:"rm -rf '/tmp/old drafts'"}}});
        emit({type:"task:approval",ts:1,payload:{taskId:"task-1",toolCallId:"delete-1",toolName:"bash",input:{command:"rm -rf '/tmp/old drafts'"},summary:"删除文件或文件夹",effects:["/tmp/old drafts","直接删除，不会移到废纸篓。"]}});
        expect((await screen.findAllByText("删除文件或文件夹")).length).toBe(2);expect(document.querySelector(".tool-head")?.textContent).not.toContain("rm -rf");expect(screen.getByText("/tmp/old drafts")).toBeTruthy();
        const details=screen.getByText("查看技术详情").closest("details")!;expect(details.open).toBe(false);expect(details.textContent).toContain("rm -rf");
        fireEvent.click(screen.getByText("批准执行"));await waitFor(()=>expect(invoke).toHaveBeenCalledWith("approval:decide",{taskId:"task-1",toolCallId:"delete-1",approved:true}));
    });
	it("edit 审批卡显示 diff（description 由主进程生成）", async () => {
		const { emit } = installBridge();
		render(<App />);
		useStore.getState().selectTask("task-1");
        emit({type:"task:state",ts:0,payload:{taskId:"task-1",status:"running"}});
		emit({
			type: "task:approval",
			ts: 1,
			payload: {
				taskId: "task-1",
				toolCallId: "c1",
				toolName: "edit",
				input: { path: "/tmp/a.ts", oldText: "a", newText: "b" },
				description: " 1 - a\n 2 + b",
			},
		});
		expect(await screen.findByText(/请求执行工具操作/)).toBeTruthy();
		expect(screen.getByText(/1 - a/)).toBeTruthy();
	});
});

describe("M4 市场/面板/命令面板", () => {
	it("市场已安装列表 + Pi 社区安装（已安装态）+ 切 Claude 源", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("Skill 与插件"));
		fireEvent.click(await screen.findByText("已安装"));
		// 插件名去 npm: 前缀显示，且不显示安装目录
		expect(await screen.findByText("demo-pkg@1.0.0")).toBeTruthy();
		expect(screen.queryByText(/\/x\/demo-pkg/)).toBeNull();
		expect(screen.getByText(/pdf-tools/)).toBeTruthy();

		fireEvent.click(screen.getByText("插件"));
		const input = await screen.findByPlaceholderText(/搜索插件/);
		expect(input).toBeTruthy();
		const searchBtns = (await screen.findAllByText("搜索")).filter((b) => b.tagName === "BUTTON" && b.className.includes("primary"));
		fireEvent.click(searchBtns[0]!);
		await screen.findAllByText(/月下载 1,234/); // 目录已加载（目录+精选各一张）
		const toolRow = (await screen.findAllByText("pi-web-access"))[0]!.closest(".card-row")!;
		fireEvent.click(toolRow.querySelector("button.primary")!);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("market:installNpm", { spec: "pi-web-access", operationId: expect.any(String) }),
		);
		// 卡片展示下载量
		expect(screen.getAllByText(/月下载 1,234/).length).toBeGreaterThan(0);
		// 安装完成后卡片回显「已安装」状态（徽章 + 禁用按钮）
		await waitFor(() => expect(screen.getAllByText("已安装").length).toBeGreaterThanOrEqual(2));

		// 插件页切 Claude 源：仍在本页，展示 Claude 目录
		fireEvent.click(screen.getByText("Claude 官方"));
		fireEvent.click((await screen.findAllByText("搜索")).filter((b) => b.tagName === "BUTTON" && b.className.includes("primary"))[0]!);
		expect(await screen.findByText("docx")).toBeTruthy();
	});

	it("插件页 Claude 源以插件（包）方式安装", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("Skill 与插件"));
		fireEvent.click(await screen.findByText("Claude 官方"));
		fireEvent.click((await screen.findAllByText("搜索")).filter((b) => b.tagName === "BUTTON" && b.className.includes("primary"))[0]!);
		const card = (await screen.findByText("docx")).closest(".mkt-card")!;
		fireEvent.click(card.querySelector("button.primary.sm")!);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("market:installClaude", { name: "docx", as: "package", operationId: expect.any(String) }),
		);
	});

	it("卡片点开详情弹窗并可安装", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("Skill 与插件"));
		fireEvent.click(await screen.findAllByText("插件").then((els) => els.map((b) => b.closest("button")).find((b) => b?.className.includes("seg-item"))!));
		const searchBtns = await screen.findAllByText("搜索").then((els) => els.filter((b) => b.tagName === "BUTTON" && b.className.includes("primary")));
		fireEvent.click(searchBtns[0]!);
		await screen.findAllByText(/月下载 1,234/);
		fireEvent.click((await screen.findAllByText("pi-web-access"))[0]!.closest(".mkt-card")!);
		// 弹窗展示名称与描述（目录卡 + 弹窗内各一份，取弹窗内）
		expect((await screen.findAllByText("Web search and fetching")).some((el) => el.closest(".modal"))).toBeTruthy();
		const modalBtn = screen.getAllByText("安装").filter((b) => b.closest(".modal"))[0]!;
		fireEvent.click(modalBtn);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("market:installNpm", { spec: "pi-web-access", operationId: expect.any(String) }),
		);
	});

 it("Git 面板展示差异并确认撤销所选文件",async()=>{
 const {invoke}=installBridge();render(<App/>);
 await waitFor(()=>screen.getByPlaceholderText(/描述任务/));
 const {useStore}=await import("./store.js"); await act(async()=>{useStore.getState().selectTask("task-1");});
 fireEvent.click(await screen.findByRole("button",{name:/Git · main/}));
 expect(await screen.findByText("+new")).toBeTruthy();
 fireEvent.click(screen.getByRole("checkbox",{name:"选择 a.ts"}));
 const undo=screen.getByRole("button",{name:"撤销选中修改"}); await waitFor(()=>expect(undo).toHaveProperty("disabled",false));
 fireEvent.click(undo);fireEvent.click(screen.getByRole("button",{name:"确认撤销"}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith("git:mutate",expect.objectContaining({taskId:"task-1",action:"discard",paths:["a.ts"],version:"version-1"})));
 expect(screen.queryByText(/检查点/)).toBeNull();
 });

    it("工作区仅浏览，不再提供主管写回按钮",async()=>{installBridge();render(<App/>);useStore.getState().selectTask("task-1");fireEvent.click(await screen.findByText(/工作区/));expect(await screen.findByText(/node-1\/out.txt/)).toBeTruthy();expect(screen.queryByText("写回项目")).toBeNull();});

	it("命令面板 ⌘K 打开、过滤并导航", async () => {
		installBridge();
		render(<App />);
		fireEvent.keyDown(window, { key: "k", metaKey: true });
		expect(await screen.findByPlaceholderText(/输入命令或任务名/)).toBeTruthy();
		fireEvent.change(screen.getByPlaceholderText(/输入命令或任务名/), { target: { value: "角色卡" } });
		fireEvent.click(screen.getByText("前往 角色卡"));
		await waitFor(() => expect(screen.getByLabelText("角色卡")).toBeTruthy());
	});
});

describe("M5 渲染层", () => {
	it("设置 MCP 区：列表渲染 + 添加表单校验提交", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("模型与设置"));
		fireEvent.click(await screen.findByText("MCP 服务"));
        fireEvent.click(await screen.findByText("服务器配置与管理"));
		expect(await screen.findByText("filesystem")).toBeTruthy();
		fireEvent.click(screen.getByText("添加服务器"));
		fireEvent.change(screen.getByPlaceholderText(/名称（字母数字-_）/), { target: { value: "docs" } });
		fireEvent.change(screen.getByPlaceholderText(/stdio 命令/), { target: { value: "npx -y docs-mcp" } });
		fireEvent.click(screen.getByText("保存"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"mcp:add",
				expect.objectContaining({ name: "docs", command: "npx", args: ["-y", "docs-mcp"] }),
			),
		)
	});

	it("角色卡展示上下文占比且移除会话信息入口", async () => {
        const { invoke } = installBridge();
        render(<App />);
        const { useStore } = await import("./store.js");
        await act(async () => useStore.getState().selectTask("task-1"));
        const ring=await screen.findByRole("progressbar",{name:"默认助手上下文使用占比"});
        expect(ring.getAttribute("aria-valuenow")).toBe("3.3");
        expect(screen.queryByText("会话信息")).toBeNull();
        expect(invoke).toHaveBeenCalledWith("task:getRoleContexts",{taskId:"task-1"});
    });

	it("斜杠命令：/ 前缀弹补全，内置命令直达", async () => {
		const { invoke } = installBridge();
		render(<App />);
		const ta = screen.getByPlaceholderText(/描述任务/) as HTMLTextAreaElement;
		fireEvent.change(ta, { target: { value: "/" } });
		expect(await screen.findByText("/compact")).toBeTruthy();
		expect(screen.getByText("/review")).toBeTruthy();
		fireEvent.click(screen.getAllByText("/compact")[0]!);
		expect(ta.value).toBe("/compact ");
		fireEvent.change(ta, { target: { value: "/compact" } });
		fireEvent.keyDown(ta, { key: "Enter" });
		// 未选任务时不调用；先选任务再触发
		await waitFor(() => expect(screen.getByPlaceholderText(/描述任务/)).toBeTruthy());
	}, 10_000);

	it("自动模型和思考同步显示，手动思考随新任务保存",async()=>{
        const {invoke}=installBridge();render(<App/>);
        expect(await screen.findByTitle("选择任务模型")).toHaveProperty("textContent"," 自动");
        expect(screen.getByRole("button",{name:"设置思考强度"}).textContent).toContain("自动");
        fireEvent.click(screen.getByTitle("选择任务模型"));fireEvent.click(await screen.findByText("Faux 1"));
        fireEvent.click(screen.getByRole("button",{name:"设置思考强度"}));fireEvent.click(screen.getByRole("button",{name:"中"}));
        expect(screen.getByRole("button",{name:"设置思考强度"}).textContent).toContain("中");
        fireEvent.change(screen.getByPlaceholderText(/描述任务/),{target:{value:"manual thinking"}});fireEvent.keyDown(screen.getByPlaceholderText(/描述任务/),{key:"Enter"});
        await waitFor(()=>expect(invoke).toHaveBeenCalledWith("task:create",expect.objectContaining({model:{provider:"pih-faux",modelId:"faux-1"},thinkingLevel:"medium"})));
    });
    it("切回自动清除手动思考并请求角色推荐配置",async()=>{
        const {invoke}=installBridge();render(<App/>);await screen.findByTitle("选择任务模型");
        act(()=>useStore.setState({currentTaskId:"task-1",draftModel:{provider:"pih-faux",modelId:"faux-1"},draftThinking:"high"}));
        fireEvent.click(screen.getByTitle("选择任务模型"));fireEvent.click(screen.getByRole("button",{name:/自动.*采用各角色卡/}));
        await waitFor(()=>expect(invoke).toHaveBeenCalledWith("task:setModel",{taskId:"task-1",auto:true}));
        await waitFor(()=>expect(useStore.getState().draftModel).toBeNull());expect(useStore.getState().draftThinking).toBeNull();expect(screen.getByRole("button",{name:"设置思考强度"}).textContent).toContain("自动");
    });
	it("运行中任务模型芯片触发 task:setModel", async () => {
		const { invoke, emit } = installBridge();
		render(<App />);
		const ta = screen.getByPlaceholderText(/描述任务/) as HTMLTextAreaElement;
		fireEvent.change(ta, { target: { value: "hi" } });
		fireEvent.keyDown(ta, { key: "Enter" });
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("task:prompt", expect.anything()));
		// 任务已创建（task-1）→ 点模型芯片选 Faux
		fireEvent.click(screen.getByTitle(/任务模型/));
		fireEvent.click(await screen.findByText("Faux 1"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("task:setModel", { taskId: "task-1", provider: "pih-faux", modelId: "faux-1" }),
		);
	});
});

describe("M6 Claude 技能源 UI", () => {
	it("技能页：目录列表 + 点卡片开详情弹窗 + 安装命令", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("Skill 与插件"));
		fireEvent.click(await screen.findByText("技能"));
		fireEvent.click(await screen.findByText("重新加载"));
		expect(await screen.findByText(/Word 文档技能/)).toBeTruthy();

		// 点卡片打开详情弹窗（自动拉取 SKILL.md 全文）；docx 同时在精选区，取目录卡（首个）
		fireEvent.click((await screen.findAllByText("docx"))[0]!.closest(".mkt-card")!);
		expect(await screen.findByText(/DOCX 技能正文/)).toBeTruthy();
		const modalBtn = screen.getAllByText("安装").filter((b) => b.closest(".modal"))[0]!;
		fireEvent.click(modalBtn);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("market:installClaude", { name: "docx", as: "skill", operationId: expect.any(String) }),
		);
	});

	it("行内安装按钮直达命令（以技能安装）", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("Skill 与插件"));
		fireEvent.click(await screen.findByText("技能"));
		fireEvent.click(await screen.findByText("重新加载"));
		await screen.findByText(/Word 文档技能/);
		const card = (await screen.findByText("docx")).closest(".mkt-card")!;
		fireEvent.click(card.querySelector("button.primary")!);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("market:installClaude", { name: "docx", as: "skill", operationId: expect.any(String) }),
		);
	});
});

describe("M10 沙箱设置", () => {
	it("审批页可切换 bash 沙箱档位并落 settings:set", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("模型与设置"));
		fireEvent.click(await screen.findByText("权限与审批"));
		expect(await screen.findByText("运行沙箱（bash）", { selector: "h1" })).toBeTruthy();
		fireEvent.click(screen.getByText("工作区可写"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("settings:set", expect.objectContaining({ sandboxMode: "workspace_write" })),
		);
	});
});

describe("M10 基础能力插件分区", () => {
	it("已安装页单独分区展示核心插件与介绍，且无移除/私有可能性控件", async () => {
		installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("Skill 与插件"));
		fireEvent.click(await screen.findByText("已安装"));
		expect(await screen.findByText("基础能力（1）")).toBeTruthy();
		expect(screen.getByText("代码反馈：LSP、lint、类型检查改动即时回贴")).toBeTruthy();
		const card = screen.getByText("pi-lens").closest(".mkt-card")!;
		expect(card.querySelector("button")).toBeNull(); // 无移除/可见性按钮
		expect(card.textContent).not.toContain("私有");
		// 普通插件分区计数不含核心
		expect(screen.getByText("插件（1）")).toBeTruthy();
		expect(screen.getByText("demo-pkg@1.0.0")).toBeTruthy();
	});
});

describe("M10 ask_user 弹窗", () => {
	it("task:question 事件渲染选项弹窗并答复", async () => {
		const { invoke, emit } = installBridge();
		render(<App />);
		useStore.getState().selectTask("task-1");
		emit({
			type: "task:question",
			ts: 1,
			payload: {
				taskId: "task-1",
				questionId: "q-1",
				question: "数据库选哪个？",
				options: [
					{ label: "PostgreSQL", description: "生产级" },
					{ label: "SQLite", description: "零运维" },
				],
			},
		});
		expect(await screen.findByText("Agent 提问 · 需要你决策")).toBeTruthy();
		expect(screen.getByText("PostgreSQL")).toBeTruthy();
		fireEvent.click(screen.getByText("PostgreSQL"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("task:answerQuestion", { taskId: "task-1", questionId: "q-1", answer: "PostgreSQL" }),
		);
		// 答复后弹窗关闭
		await waitFor(() => expect(screen.queryByText("Agent 提问 · 需要你决策")).toBeNull());
	});
});

describe("M7 渲染层", () => {
	it("从 AI 回复创建分支，顶部不再显示分叉入口", async () => {
		const { invoke } = installBridge();
		render(<App />);
		const { useStore } = await import("./store.js");
		await act(async () => {
			useStore.getState().selectTask("task-1");
            useStore.setState({transcript:[{id:"u",role:"user",text:"请求"},{id:"a",entryId:"e2",role:"assistant",text:"AI 回复"}]});
		});
        expect(screen.queryByText(/^分叉$/)).toBeNull();
		fireEvent.click(await screen.findByRole("button",{name:"创建分支"}));
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("task:fork", { taskId: "task-1", entryId: "e2" }));
	});

	it("审批策略：勾选切换并保存", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("模型与设置"));
		fireEvent.click(await screen.findByText("权限与审批"));
		await screen.findByText("bash");
		fireEvent.click(screen.getByText("bash").closest("label")!);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"settings:set",
				expect.objectContaining({ autoApproveTools: expect.arrayContaining(["bash"]) }),
			),
		);
	});

	it("市场推荐区：加载并展示下载量", async () => {
		installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("Skill 与插件"));
		await screen.findByText("本周推荐");
		expect(await screen.findByText("@x/popular")).toBeTruthy();
		expect(screen.getAllByText(/月下载 9,999/).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/下载量未知/).length).toBeGreaterThan(0);
	});
});

describe("M8 渲染层", () => {
	it("市场已安装：包与本地技能的公开/私有点击生效", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("Skill 与插件"));
		fireEvent.click(await screen.findByText("已安装"));
		expect(await screen.findByText("demo-pkg@1.0.0")).toBeTruthy();
		const rows = screen.getAllByText("私有");
		fireEvent.click(rows[0]!);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("market:setVisibility", {
				name: "npm:demo-pkg@1.0.0",
				kind: "package",
				visibility: "private",
			}),
		);
	});

	it("Pi 官方：画廊加载与安装", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("Skill 与插件"));
		const segBtns = await screen.findAllByText("插件");
		const tile = segBtns.map((b) => b.closest("button")).find((b) => b?.className.includes("seg-item"));
		fireEvent.click(tile!);
		const input = await screen.findByPlaceholderText(/搜索插件/);
		const searchBtns = (await screen.findAllByText("搜索")).filter((b) => b.tagName === "BUTTON" && b.className.includes("primary"));
		fireEvent.click(searchBtns[0]!);
		await screen.findAllByText(/月下载 1,234/);
		const toolCard = (await screen.findByText("pi-web-access")).closest(".mkt-card")!;
		fireEvent.click(toolCard.querySelector("button.primary")!);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("market:installNpm", { spec: "pi-web-access", operationId: expect.any(String) }),
		);
	});

	it("角色编辑：Skill/插件下拉多选并随保存提交", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("角色卡"));
		fireEvent.click((await screen.findByText("代码评审员")).closest("button")!);
		fireEvent.click(screen.getByRole("button",{name:"技能与插件"}));
        fireEvent.click(await screen.findByText("绑定 Skill"));
		fireEvent.click(await screen.findByText("demo-skill"));
		fireEvent.click(screen.getByText("保存"));
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"role:update",
				expect.objectContaining({ boundSkills: ["demo-skill"] }),
			),
		);
	});
});

describe("冒烟驱动（faux 对话模拟）", () => {
	it("冒烟模式完成基础+faux 全链路上报", async () => {
		const { invoke, emit } = installBridge();
		window.history.replaceState({}, "", "/?smoke=1");
		render(<App />);

		// SmokeRunner 会依次调用 model:list / settings:set / task:create / task:prompt
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("task:prompt", expect.anything()), { timeout: 4000 });
		// 模拟主进程事件流
		emit({ type: "task:stream", ts: 1, payload: { taskId: "task-1", kind: "text_delta", delta: "冒烟回复内容" } });
		emit({ type: "task:stream", ts: 2, payload: { taskId: "task-1", kind: "tool_execution_start", toolCallId: "t1", toolName: "ls", args: {} } });
		emit({ type: "task:stream", ts: 3, payload: { taskId: "task-1", kind: "tool_execution_end", toolCallId: "t1", isError: false } });
		emit({ type: "task:stream", ts: 4, payload: { taskId: "task-1", kind: "tool_execution_start", toolCallId: "t2", toolName: "save_memory", args: {} } });
		emit({ type: "task:stream", ts: 5, payload: { taskId: "task-1", kind: "tool_execution_end", toolCallId: "t2", isError: false } });
		emit({ type: "task:state", ts: 6, payload: { taskId: "task-1", status: "done" } });


		await waitFor(() => expect(invoke).toHaveBeenCalledWith("smoke:report", expect.anything()), { timeout: 4000 });
		const call = invoke.mock.calls.find((c) => c[0] === "smoke:report");
		const payload = call?.[1] as {
			rendererBoot: boolean;
			ping: boolean;
			faux: {
				ok: boolean;
				textChars: number;
				toolCalls: number;
				roleUsed: boolean;
				memorySaved: boolean;
				workbenchOk: boolean;

			};
		};
		expect(payload.rendererBoot).toBe(true);
		expect(payload.ping).toBe(true);
		expect(payload.faux.ok).toBe(true);
		expect(payload.faux.textChars).toBeGreaterThan(5);
		expect(payload.faux.toolCalls).toBeGreaterThanOrEqual(2);
		expect(payload.faux.roleUsed).toBe(true);
		expect(payload.faux.memorySaved).toBe(true);
		expect(payload.faux.workbenchOk).toBe(true);
	});
});

describe("权限模式与思考面板", () => {
	it("权限模式胶囊：默认变更前确认，弹出四档（ZCode 文案）并切换到计划模式", async () => {
		const { invoke } = installBridge();
		render(<App />);
		const chip = await screen.findByTitle(/权限模式/);
		expect(chip.textContent).toContain("变更前确认");
		fireEvent.click(chip);
		for (const desc of ["编辑前先出计划。", "改文件前先问我。", "自动编辑文件。", "减少确认次数。"]) {
			expect(screen.getByText(desc)).toBeTruthy();
		}
		fireEvent.click(screen.getByText("编辑前先出计划。").closest("button") as HTMLElement);
		await waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("settings:set", expect.objectContaining({ permissionMode: "plan" })),
		);
		await waitFor(() => expect(chip.textContent).toContain("计划模式"));
	});

	it("本轮分析进行中可查看，任务完成后自动折叠", async () => {
		const { emit } = installBridge();
		render(<App />);
		const textarea = screen.getByPlaceholderText(/描述任务/) as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: "hi" } });
		fireEvent.keyDown(textarea, { key: "Enter" });
		await waitFor(() => screen.getByText("hi"));

		emit({ type: "task:state", ts: 1, payload: { taskId: "task-1", status: "running" } });
		emit({ type: "task:stream", ts: 2, payload: { taskId: "task-1", kind: "thinking_delta", delta: "先分析" } });
		expect(screen.getByText(/^分析中/)).toBeTruthy();
		expect(screen.getByText("先分析")).toBeTruthy();

		emit({
			type: "task:stream",
			ts: 3,
			payload: {
				taskId: "task-1",
				kind: "assistant_message_end",
				message: { id: "m1", role: "assistant", text: "结论", thinking: "先分析" },
			},
		});
		emit({type:"task:state",ts:4,payload:{taskId:"task-1",status:"done"}});
        await waitFor(() => expect(screen.getByRole("button",{name:/^已完成/})).toBeTruthy());
        expect(screen.queryByText("先分析")).toBeNull();
	});
});

describe("MCP 插件闭环（市场接入型安装）", () => {
	it("已安装区显示 MCP 服务器分区，可停用/移除", async () => {
		const { invoke } = installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("Skill 与插件"));
		fireEvent.click(await screen.findByText("已安装"));
		expect(await screen.findByText(/MCP 服务器（2）/)).toBeTruthy();
		const row = (await screen.findByText("github")).closest(".card-row")!;
		expect(row.textContent).toContain("来自官方插件 github");
		fireEvent.click([...row.querySelectorAll("button")].find((b) => b.textContent === "停用")!);
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("mcp:setEnabled", { name: "github", enabled: false }));
	});

	it("插件页 Claude 源：github（MCP 型）按服务器判定已安装；技能页不显示 MCP 型", async () => {
		installBridge();
		render(<App />);
		fireEvent.click(screen.getByLabelText("Skill 与插件"));
		// 先进已安装页让页面标题不再是「插件」，避免与页签同名冲突
		fireEvent.click(await screen.findByText("已安装"));
		fireEvent.click(screen.getByText("插件"));
		fireEvent.click(screen.getByText("Claude 官方"));
		fireEvent.click((await screen.findAllByText("搜索")).filter((b) => b.tagName === "BUTTON" && b.className.includes("primary"))[0]!);
		const card = (await screen.findByText("github")).closest(".mkt-card")!;
		expect(card.textContent).toContain("已安装");
		expect(card.textContent).toContain("MCP 插件 · 安装即接入");

		fireEvent.click(screen.getByText("技能"));
		fireEvent.click(screen.getByText("Claude 官方"));
		fireEvent.click((await screen.findAllByText("搜索")).filter((b) => b.tagName === "BUTTON" && b.className.includes("primary"))[0]!);
		await screen.findAllByText("docx"); // 目录+精选各一张
		expect(screen.queryByText("MCP 插件 · 安装即接入")).toBeNull();
	});
});

describe("MCP 浏览器认证", () => {
 it("GitHub missing credentials opens browser auth and updates the installed badge", async () => {
  const {invoke}=installBridge(); render(<App />);
  fireEvent.click(screen.getByLabelText("Skill 与插件")); fireEvent.click(await screen.findByText("已安装"));
  const row=(await screen.findByText("github")).closest(".card-row")!;
  expect(row.textContent).toContain("需认证（1）");
  fireEvent.click([...row.querySelectorAll("button")].find(button=>button.textContent?.trim()==="认证设置")!);
  await screen.findByRole("dialog",{name:"GitHub 认证"});
  expect(screen.queryByPlaceholderText("粘贴令牌…")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"开始认证"}));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("market:authStart",{source:"claude:github"}));
  fireEvent.click(await screen.findByRole("button",{name:"完成"}));
  await waitFor(()=>expect((screen.getByText("github").closest(".card-row")!).textContent).toContain("已认证"));
  expect(invoke).not.toHaveBeenCalledWith("mcp:setCredential",expect.anything());
 });
});

describe("输入法与事件隔离", () => {
	it("IME 组合中的回车不发送（中文输入法选字上屏）", async () => {
		const { invoke } = installBridge();
		render(<App />);
		const textarea = screen.getByPlaceholderText(/描述任务/) as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: "你好" } });
		fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
		await new Promise((r) => setTimeout(r, 50));
		expect(invoke).not.toHaveBeenCalledWith("task:create", expect.anything());
		// 组合结束后的普通回车正常发送
		fireEvent.keyDown(textarea, { key: "Enter", isComposing: false });
		await waitFor(() => expect(invoke).toHaveBeenCalledWith("task:create", expect.anything()));
	});

	it("新任务视图（未选任务）不串入后台任务事件", async () => {
		const { emit } = installBridge();
		render(<App />);
		// 后台任务的流式/审批/计划事件：currentTaskId 为 null 时全部拦截
		emit({ type: "task:state", ts: 1, payload: { taskId: "task-bg", status: "running" } });
		emit({ type: "task:stream", ts: 2, payload: { taskId: "task-bg", kind: "text_delta", delta: "串" } });
		emit({ type: "task:approval", ts: 3, payload: { taskId: "task-bg", toolCallId: "tc1", toolName: "write" } });
		expect(screen.queryByText("串")).toBeNull();
		expect(useStore.getState().pendingApproval).toBeNull();
		expect(useStore.getState().taskStatus).toBeNull();
	});
});
