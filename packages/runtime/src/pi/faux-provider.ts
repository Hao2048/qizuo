/**
 * faux 测试模型：pi 官方假 provider，脚本化响应，零成本确定性。
 * 用于 runtime 集成测试与 Electron 冒烟测试（--pih-smoke + PIH_ENABLE_FAUX=1）。
 *
 * 注册走 pi-ai compat 全局表（coding-agent 的 ModelRuntime 从该表解析自定义 api）。
 * 进程级单例：同一进程重复调用安全。
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";

export const FAUX_PROVIDER_ID = "pih-faux";
export const FAUX_API_ID = "pih-faux";
export const FAUX_MODEL_ID = "faux-1";

/** 多实例：工作台的并行角色各自独享脚本队列，保证确定性。 */
const registrations = new Map<string, FauxProviderRegistration>();

export function ensureFauxRegistered(suffix = ""): FauxProviderRegistration {
	const key = suffix || "base";
	const providerId = suffix ? `${FAUX_PROVIDER_ID}-${suffix}` : FAUX_PROVIDER_ID;
	const apiId = suffix ? `${FAUX_API_ID}-${suffix}` : FAUX_API_ID;
	let reg = registrations.get(key);
	if (!reg) {
		reg = registerFauxProvider({
			provider: providerId,
			api: apiId,
			models: [{ id: FAUX_MODEL_ID, name: `Faux 测试模型${suffix ? ` ${suffix}` : ""}`, contextWindow: 128_000 }],
		});
		registrations.set(key, reg);
	}
	return reg;
}

/** faux 模型引用（suffix 为空 = 基础实例） */
export function fauxModelRef(suffix = ""): { provider: string; modelId: string } {
	return {
		provider: suffix ? `${FAUX_PROVIDER_ID}-${suffix}` : FAUX_PROVIDER_ID,
		modelId: FAUX_MODEL_ID,
	};
}

/** 把 faux provider（含多实例）合并进指定 models.json（不破坏既有内容）。 */
export function seedFauxIntoModelsJson(modelsPath: string): void {
	let config: { providers?: Record<string, unknown> } = {};
	if (existsSync(modelsPath)) {
		try {
			config = JSON.parse(readFileSync(modelsPath, "utf8")) as typeof config;
		} catch {
			config = {};
		}
	}
	config.providers = config.providers ?? {};
	mkdirSync(join(modelsPath, ".."), { recursive: true });
	// 基础实例 + 多实例（a/b/c/d，供并行角色测试分配独立脚本队列）
	for (const suffix of ["", "a", "b", "c", "d"]) {
		const providerId = suffix ? `${FAUX_PROVIDER_ID}-${suffix}` : FAUX_PROVIDER_ID;
		const apiId = suffix ? `${FAUX_API_ID}-${suffix}` : FAUX_API_ID;
		if (!config.providers[providerId]) {
			config.providers[providerId] = {
				api: apiId,
				apiKey: "dummy",
				baseUrl: "http://localhost:9",
				models: [{ id: FAUX_MODEL_ID, name: `Faux 测试模型${suffix ? ` ${suffix}` : ""}` }],
			};
		}
		ensureFauxRegistered(suffix);
	}
	writeFileSync(modelsPath, JSON.stringify(config, null, "\t"), "utf8");
}

/**
 * 冒烟/演示脚本：先说明 → 调 ls 工具（真实执行）→ 总结收尾。
 * 覆盖：文本流、工具调用、两轮 agent 循环。
 */
/**
 * 冒烟/演示脚本：说明 → ls 工具（真实执行）→ save_memory（真实落库）→ 总结。
 * 覆盖：文本流、内置工具、自定义记忆工具、多轮 agent 循环。
 */
export function setDefaultFauxScript(reg: FauxProviderRegistration, listDir: string): void {
	reg.setResponses([
		fauxAssistantMessage(
			[fauxText("好的，我先查看目录内容。\n"), fauxToolCall("ls", { path: listDir }, { id: "faux-call-1" })],
			{ stopReason: "toolUse" },
		),
        fauxAssistantMessage([fauxToolCall("tool_search",{query:"save_memory",limit:1})]),
		fauxAssistantMessage(
			[
				fauxText("目录确认完毕，我记录一条冒烟记忆。\n"),
				fauxToolCall(
					"save_memory",
					{ scope: "role", title: "冒烟记忆", content: "faux 全链路冒烟于本机通过" },
					{ id: "faux-call-2" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("已确认目录并保存记忆，冒烟链路（模型→工具→记忆→总结）全部打通。")], {
			stopReason: "stop",
		}),
	]);
}
