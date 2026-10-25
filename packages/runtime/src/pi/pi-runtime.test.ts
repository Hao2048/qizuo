import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRuntime } from "./pi-runtime.js";
import { Logger } from "../logging/logger.js";
import { FAUX_MODEL_ID, FAUX_PROVIDER_ID } from "./faux-provider.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pih-pi-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("PiRuntime", () => {
	it("enableFaux：models.json 注入 faux，提供商清单包含且已配置认证", async () => {
		const pi = await PiRuntime.create({ dataDir: dir, logger: new Logger(), enableFaux: true });
		const providers = await pi.listProviders();
		const faux = providers.find((p) => p.id === FAUX_PROVIDER_ID);
		expect(faux).toBeDefined();
		expect(faux?.authConfigured).toBe(true);
		expect(faux?.models.some((m) => m.id === FAUX_MODEL_ID)).toBe(true);

		const model = pi.getModel(FAUX_PROVIDER_ID, FAUX_MODEL_ID);
		expect(model).toBeDefined();
	});

	it("API Key 持久化：写入后新实例仍可读到（auth.json 落盘）", async () => {
		const pi1 = await PiRuntime.create({ dataDir: dir, logger: new Logger() });
		await pi1.setApiKey("anthropic", "sk-test-123");
		await pi1.removeApiKey("openai");

		const pi2 = await PiRuntime.create({ dataDir: dir, logger: new Logger() });
		const providers = await pi2.listProviders();
		const anthropic = providers.find((p) => p.id === "anthropic");
		expect(anthropic?.authConfigured).toBe(true);
	});

	it("API Key 移除后认证状态复位", async () => {
		const pi1 = await PiRuntime.create({ dataDir: dir, logger: new Logger() });
		await pi1.setApiKey("deepseek", "sk-x");
		await pi1.removeApiKey("deepseek");

		const pi2 = await PiRuntime.create({ dataDir: dir, logger: new Logger() });
		const providers = await pi2.listProviders();
		expect(providers.find((p) => p.id === "deepseek")?.authConfigured).toBe(false);
	});

	it("testConnection：模型不存在时如实失败", async () => {
		const pi = await PiRuntime.create({ dataDir: dir, logger: new Logger() });
		const result = await pi.testConnection("no-such", "no-model");
		expect(result.ok).toBe(false);
		expect(result.message).toContain("不存在");
	});

	it("testConnection：faux 模型真实调用成功并带回执", async () => {
		const pi = await PiRuntime.create({ dataDir: dir, logger: new Logger(), enableFaux: true });
		const result = await pi.testConnection(FAUX_PROVIDER_ID, FAUX_MODEL_ID);
		expect(result.ok).toBe(true);
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	}, 20_000);
});
