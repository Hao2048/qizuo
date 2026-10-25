/**
 * LoginService：订阅 OAuth 登录流（pi Models.login 的可编程驱动）。
 * 交互经事件往返：auth_url/device_code → 渲染层展示 + 主进程开浏览器；
 * prompt(select/text) → 渲染层选择 → model:loginAnswer 回填。
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { uuidv7 } from "@pi-harness/shared";
import type { Logger } from "../logging/logger.js";

interface PendingFlow {
	controller: AbortController;
	answer: ((value: string) => void) | null;
	fail: ((reason: Error) => void) | null;
}

export interface LoginServiceOptions {
	modelRuntime: () => ModelRuntime;
	openExternal: (url: string) => void;
	emit: (type: string, payload: unknown) => void;
	logger: Logger;
}

export class LoginService {
	#opts: LoginServiceOptions;
	#flows = new Map<string, PendingFlow>();

	constructor(opts: LoginServiceOptions) {
		this.#opts = opts;
	}

	/** 启动订阅登录（后台异步执行，进度经 model:loginEvent 推送）。 */
	start(providerId: string): { flowId: string } {
		const flowId = uuidv7();
		const controller = new AbortController();
		const flow: PendingFlow = { controller, answer: null, fail: null };
		this.#flows.set(flowId, flow);

		const emitEvent = (payload: Record<string, unknown>): void => {
			this.#opts.emit("model:loginEvent", { flowId, ...payload });
		};

		const interaction: AuthInteraction = {
			signal: controller.signal,
			prompt: async (prompt: AuthPrompt) => {
				emitEvent({
					kind: "prompt",
					promptId: `${flowId}-${Date.now()}`,
					promptText: prompt.message,
					options:
						prompt.type === "select"
							? prompt.options.map((o) => ({ id: o.id, label: o.label }))
							: undefined,
				});
				return await new Promise<string>((resolve, reject) => {
					flow.answer = resolve;
					flow.fail = reject;
				});
			},
			notify: (event: AuthEvent) => {
				if (event.type === "auth_url") {
					try {
						this.#opts.openExternal(event.url);
					} catch (err) {
						this.#opts.logger.warn("打开浏览器失败", {
							url: event.url,
							message: err instanceof Error ? err.message : String(err),
						});
					}
					emitEvent({ kind: "url", url: event.url, message: event.instructions });
				} else if (event.type === "device_code") {
					try {
						this.#opts.openExternal(event.verificationUri);
					} catch {
						/* 渲染层可手动打开 */
					}
					emitEvent({
						kind: "device_code",
						userCode: event.userCode,
						verificationUri: event.verificationUri,
					});
				} else if (event.type === "progress") {
					emitEvent({ kind: "progress", message: event.message });
				} else {
					emitEvent({ kind: "info", message: event.message });
				}
			},
		};

		void (async () => {
			try {
				const credential = await this.#opts.modelRuntime().login(providerId, "oauth", interaction);
				emitEvent({
					kind: "done",
					message: `登录成功（${credential.type === "oauth" ? "订阅凭证已保存" : "凭证已保存"}）`,
				});
				this.#opts.logger.info("订阅登录成功", { providerId });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				emitEvent({ kind: "error", message });
				this.#opts.logger.warn("订阅登录失败", { providerId, message });
			} finally {
				this.#flows.delete(flowId);
			}
		})();

		return { flowId };
	}

	answer(flowId: string, answer: string): boolean {
		const flow = this.#flows.get(flowId);
		if (!flow?.answer) return false;
		flow.answer(answer);
		flow.answer = null;
		flow.fail = null;
		return true;
	}

	cancel(flowId: string): boolean {
		const flow = this.#flows.get(flowId);
		if (!flow) return false;
		flow.controller.abort();
		flow.fail?.(new Error("用户取消登录"));
		this.#flows.delete(flowId);
		return true;
	}

	/** 提供商可用的登录方式（api_key / oauth）。 */
	authMethods(providerId: string): Array<{ type: "api_key" | "oauth"; name: string; isSubscription: boolean; label?: string }> {
		const provider = this.#opts.modelRuntime().getProvider(providerId);
		if (!provider?.auth) return [];
		const auths = Array.isArray(provider.auth) ? provider.auth : [provider.auth];
		const out: Array<{ type: "api_key" | "oauth"; name: string; isSubscription: boolean; label?: string }> = [];
		for (const a of auths as Array<Record<string, unknown>>) {
			if ("refresh" in a) {
				out.push({
					type: "oauth",
					name: String(a["name"] ?? providerId),
					isSubscription: Boolean(a["isSubscription"]),
					label: a["loginLabel"] ? String(a["loginLabel"]) : undefined,
				});
			} else if ("resolve" in a) {
				out.push({
					type: "api_key",
					name: String(a["name"] ?? providerId),
					isSubscription: false,
				});
			}
		}
		return out;
	}
}
