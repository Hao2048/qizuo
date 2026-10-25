/**
 * PiRuntime：pi ModelRuntime 的受控封装。
 * - 独立 agentDir（<dataDir>/pi），与用户可能安装的 pi CLI（~/.pi）完全隔离
 * - 模型/提供商清单、API Key 管理、连接测试
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {getSupportedThinkingLevels} from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ConnectionTestResult, ModelInfo, ProviderInfo } from "@pi-harness/contracts";
import type { Logger } from "../logging/logger.js";
import { ensureFauxRegistered, seedFauxIntoModelsJson, setDefaultFauxScript } from "./faux-provider.js";
import { FileApiKeyStore, type CredentialCipher } from "./credentials.js";

export interface PiRuntimeOptions {
	dataDir: string;
	logger: Logger;
	/** 注册 faux 测试模型（测试与冒烟用） */
	enableFaux?: boolean;
	/** M7：凭证加密（如 Electron safeStorage）；不传为明文 */
	credentialCipher?: CredentialCipher | null;
}

export class PiRuntime {
	readonly piDir: string;
	readonly modelsPath: string;
	readonly authPath: string;
	#rt: ModelRuntime;
	#store: FileApiKeyStore;
	#logger: Logger;

	private constructor(rt: ModelRuntime, store: FileApiKeyStore, opts: PiRuntimeOptions) {
		this.#rt = rt;
		this.#store = store;
		this.#logger = opts.logger;
		this.piDir = join(opts.dataDir, "pi");
		this.modelsPath = join(this.piDir, "models.json");
		this.authPath = join(this.piDir, "auth.json");
	}

	static async create(opts: PiRuntimeOptions): Promise<PiRuntime> {
		const piDir = join(opts.dataDir, "pi");
		mkdirSync(piDir, { recursive: true });
		const modelsPath = join(piDir, "models.json");
		const authPath = join(piDir, "auth.json");

		if (opts.enableFaux) {
			const reg = ensureFauxRegistered();
			seedFauxIntoModelsJson(modelsPath);
			setDefaultFauxScript(reg, opts.dataDir);
		}

		// 持久化凭证走自有 CredentialStore（pi 默认文件存储不随运行时覆盖落盘）
		const store = new FileApiKeyStore(authPath, { cipher: opts.credentialCipher ?? null });
		if (opts.credentialCipher) opts.logger.info("凭证存储已启用加密", {});
		const rt = await ModelRuntime.create({ modelsPath, authPath, credentials: store });
		opts.logger.info("PiRuntime 就绪", { piDir, faux: opts.enableFaux ?? false });
		return new PiRuntime(rt, store, opts);
	}

	get raw(): ModelRuntime {
		return this.#rt;
	}

	getModel(provider: string, modelId: string): Model<never> | undefined {
		return this.#rt.getModel(provider, modelId) as Model<never> | undefined;
	}

	/** 提供商清单（含每个提供商的模型与认证状态）。空模型提供商不返回。 */
	async listProviders(): Promise<ProviderInfo[]> {
		const providers = this.#rt.getProviders();
		const out: ProviderInfo[] = [];
		for (const p of providers) {
			const models = this.#rt.getModels(p.id);
			if (models.length === 0) continue;
			// 检测是否提供 OAuth（订阅）登录方式
			const auth = (p as { auth?: unknown }).auth;
			const authList = Array.isArray(auth) ? auth : auth ? [auth] : [];
			const oauthSupported = authList.some((a) => typeof a === "object" && a !== null && "refresh" in (a as object));
			out.push({
				id: p.id,
				name: p.name ?? p.id,
				authConfigured: this.#rt.hasConfiguredAuth(p.id),
				requiresApiKey: true,
				oauthSupported,
				models: models.map((m) => ({
					id: m.id,
					name: m.name ?? m.id,
					api: m.api,
					provider: m.provider,
					contextWindow: m.contextWindow,
					reasoning: (m as { reasoning?: boolean }).reasoning,
                    thinkingLevels:getSupportedThinkingLevels(m),
					input: m.input,
				})),
			});
		}
		// 已配置认证的排前面，未配置的按名称
		out.sort((a, b) => Number(b.authConfigured) - Number(a.authConfigured) || a.name.localeCompare(b.name));
		return out;
	}

	async setApiKey(providerId: string, apiKey: string): Promise<void> {
		// 持久化（auth.json）+ 当前运行时立即可用
		await this.#store.modify(providerId, async () => ({ type: "api_key" as const, key: apiKey }));
		await this.#rt.setRuntimeApiKey(providerId, apiKey);
		this.#logger.info("API Key 已保存", { providerId });
	}


	async removeApiKey(providerId: string): Promise<void> {
		await this.#store.delete(providerId);
		await this.#rt.removeRuntimeApiKey(providerId);
		this.#logger.info("API Key 已移除", { providerId });
	}

	/** 真实小请求测试连接（用户显式点击才调用，有真实开销）。 */
	async testConnection(provider: string, modelId: string): Promise<ConnectionTestResult> {
		const model = this.getModel(provider, modelId);
		if (!model) {
			return { ok: false, message: `模型不存在: ${provider}/${modelId}` };
		}
		const started = Date.now();
		try {
			const reply = await this.#rt.completeSimple(model, {
				systemPrompt: "You are a connectivity probe. Reply with the single word: pong.",
				messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
			});
			const latencyMs = Date.now() - started;
			if (reply.stopReason === "error") {
				return { ok: false, latencyMs, message: reply.errorMessage ?? "模型返回错误" };
			}
			const text = reply.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			return {
				ok: true,
				latencyMs,
				message: text.trim().slice(0, 200) || "(空响应)",
				usage: { input: reply.usage.input ?? 0, output: reply.usage.output ?? 0 },
			};
		} catch (err) {
			return {
				ok: false,
				latencyMs: Date.now() - started,
				message: err instanceof Error ? err.message : String(err),
			};
		}
	}
}
