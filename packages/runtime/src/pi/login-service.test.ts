import { describe, expect, it } from "vitest";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { LoginService } from "./login-service.js";
import { Logger } from "../logging/logger.js";

function collect(): { events: Array<Record<string, unknown>>; svc: LoginService } {
	const events: Array<Record<string, unknown>> = [];
	const svc = new LoginService({
		modelRuntime: () =>
			({
				login: async (
					_provider: string,
					_type: string,
					interaction: AuthInteraction,
				) => {
					interaction.notify({ type: "auth_url", url: "https://auth.example/x", instructions: "打开页面" });
					const choice = await interaction.prompt({
						type: "select",
						message: "选择登录方式",
						options: [{ id: "oauth-a", label: "方案A" }],
					});
					void choice;
					return { type: "oauth", refresh: "r1", access: "a1", expires: Date.now() + 3600_000 };
				},
				getProvider: () => undefined,
			}) as never,
		openExternal: () => {},
		emit: (type, payload) => events.push({ type, ...(payload as Record<string, unknown>) }),
		logger: new Logger(),
	});
	return { events, svc };
}

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe("LoginService（订阅 OAuth 编排，桩驱动）", () => {
	it("完整流：url 事件 → prompt 选择 → 回填 → done", async () => {
		const { events, svc } = collect();
		const { flowId } = svc.start("zai-coding-cn");

		await waitUntil(() => events.some((e) => e["type"] === "model:loginEvent" && e["kind"] === "prompt"), "prompt 事件");
		const urlEvent = events.find((e) => e["kind"] === "url");
		expect(urlEvent?.["url"]).toBe("https://auth.example/x");

		expect(svc.answer(flowId, "oauth-a")).toBe(true);
		await waitUntil(() => events.some((e) => e["kind"] === "done"), "done 事件");
		const done = events.find((e) => e["kind"] === "done");
		expect(done?.["message"]).toContain("登录成功");
	});

	it("取消：abort 后流程失败并清理", async () => {
		const { events, svc } = collect();
		const { flowId } = svc.start("zai-coding-cn");
		await waitUntil(() => events.some((e) => e["kind"] === "prompt"), "prompt 出现");
		expect(svc.cancel(flowId)).toBe(true);
		await waitUntil(() => events.some((e) => e["kind"] === "error"), "error 事件");
		// 取消后 answer 失败（流程已清理）
		expect(svc.answer(flowId, "x")).toBe(false);
	});

	it("authMethods：oauth（含 refresh）与 api_key（含 resolve）识别", () => {
		const svc = new LoginService({
			modelRuntime: () =>
				({
					getProvider: () => ({
						id: "p",
						auth: [
							{ name: "API Key", resolve: () => undefined },
							{ name: "订阅", isSubscription: true, loginLabel: "订阅登录", login: async () => { throw new Error("unused"); }, refresh: async () => { throw new Error("unused"); }, toAuth: async () => { throw new Error("unused"); } },
						],
					}),
				}) as never,
			openExternal: () => {},
			emit: () => {},
			logger: new Logger(),
		});
		const methods = svc.authMethods("p");
		expect(methods.find((m) => m.type === "oauth")?.isSubscription).toBe(true);
		expect(methods.find((m) => m.type === "api_key")).toBeDefined();
	});
});
