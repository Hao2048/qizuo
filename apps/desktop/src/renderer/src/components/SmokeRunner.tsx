import { useEffect, useRef } from "react";
import { invoke } from "../api.js";
import { dispatchAppEvent } from "../events.js";
import type { AnyAppEvent as AppEvent } from "@pi-harness/contracts";

/**
 * 冒烟模式驱动器 v2：真实走完整 IPC 链路。
 * 1) 基础：health:get + dev:ping
 * 2) faux 全链路对话：model:list → settings:set → task:create → task:prompt
 *    → 收流式事件（文本/工具）→ 等待 done → 汇总上报
 */
export default function SmokeRunner(): null {
	const started = useRef(false);

	useEffect(() => {
		if (started.current) return;
		started.current = true;

		const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
		async function waitFor(predicate: () => boolean, what: string, timeoutMs: number): Promise<void> {
			const startedAt = Date.now();
			while (!predicate()) {
				if (Date.now() - startedAt > timeoutMs) throw new Error(`等待超时: ${what}`);
				await waitMs(50);
			}
		}

		const run = async (): Promise<void> => {
			let health = null;
			let pingOk = false;
			let faux: {
				ok: boolean;
				textChars: number;
				toolCalls: number;
				roleUsed?: boolean;
				memorySaved?: boolean;
				workbenchOk?: boolean;

				error?: string | null;
			} = { ok: false, textChars: 0, toolCalls: 0 };
			let error: string | null = null;
			try {
				health = await invoke("health:get", {});
				const pong = await invoke("dev:ping", { echo: "pih-smoke" });
				pingOk = pong.echo === "pih-smoke" && pong.pong === true;

				// ---- faux 全链路对话 ----
				const seen: AppEvent[] = [];
				const unsub = window.pih
					? (() => {
							// 借用全局订阅：dispatchAppEvent 已在 App 挂载，这里再挂一个只读收集器
							return (window as unknown as { pih: { onEvent: (cb: (e: unknown) => void) => () => void } }).pih.onEvent(
								(e) => seen.push(e as AppEvent),
							);
						})()
					: () => {};
				try {
					const { providers } = await invoke("model:list", {});
					const fauxProvider = providers.find((p) => p.id === "pih-faux");
					if (!fauxProvider) throw new Error("model:list 未包含 pih-faux 提供商");

					// M2：默认角色 + 记忆种子
					const { roles } = await invoke("role:list", {});
					const defaultRole = roles.find((r) => r.isDefault);
					if (!defaultRole) throw new Error("默认角色缺失");
					if (defaultRole.memoryCount < 1) throw new Error("默认角色缺少记忆种子");

					await invoke("settings:set", {
						defaultModel: { provider: "pih-faux", modelId: "faux-1" },
						autoApproveTools: ["read", "grep", "find", "ls"],
					});

					const task = await invoke("task:create", { roleId: defaultRole.id, title: "冒烟对话" });
					await invoke("task:prompt", { taskId: task.id, text: "请检查工作目录并记录发现" });

					await waitFor(
						() => seen.some((e) => e.type === "task:state" && (e.payload as { status: string }).status === "done"),
						"faux 任务完成",
						60_000,
					);

					const streams = seen
						.filter((e) => e.type === "task:stream" && (e as { payload: { taskId: string } }).payload.taskId === task.id)
						.map((e) => (e as { payload: { kind: string; delta?: string; isError?: boolean } }).payload);
					const textChars = streams
						.filter((x) => x.kind === "text_delta")
						.map((x) => x.delta ?? "")
						.join("").length;
					const toolCalls = streams.filter((x) => x.kind === "tool_execution_start").length;
					const toolEnd = streams.find((x) => x.kind === "tool_execution_end");

					// 有效系统提示词含默认角色提示词；save_memory 真实落库
					const got = await invoke("task:get", { taskId: task.id });
					const roleUsed = typeof got.task?.systemPrompt === "string" && got.task.systemPrompt.includes("栖作 Qizuo");
					const mem = await invoke("memory:list", { scopeType: "role", query: "冒烟记忆" });
					const memorySaved = (mem.items ?? []).some((x: { title: string }) => x.title === "冒烟记忆");

                    // New workbench durable creation and cleanup (full routing is covered by runtime faux tests).
                    const wb=await invoke("workbench:create",{title:"冒烟协作"});
                    const wbList=await invoke("workbench:list",{});
                    const image=await invoke("workbench:attach",{id:wb.id,name:"smoke.png",kind:"image",mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=="});
                    const readImage=await invoke("workbench:readAttachment",{id:wb.id,attachmentId:image.id});
                    const workbenchOk=wbList.items.some(item=>item.id===wb.id) && readImage.data.length>20 && readImage.attachment.kind==="image";
                    await invoke("workbench:discardAttachment",{id:wb.id,attachmentId:image.id});
                    await invoke("workbench:delete",{id:wb.id});

					faux = {
						ok: textChars > 5 && toolCalls >= 2 && toolEnd?.isError === false && roleUsed && memorySaved,
						textChars,
						toolCalls,
						roleUsed,
						memorySaved,
						workbenchOk,
					};
					if (!faux.workbenchOk) faux.ok = false;
				} finally {
					unsub();
				}
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			}
			try {
				await invoke("smoke:report", {
					rendererBoot: true,
					health,
					ping: pingOk,
					faux,
					error,
				});
			} catch {
				// 主进程超时兜底会处理
			}
		};

		void run();
	}, []);

	return null;
}
