import { describe, expect, it } from "vitest";
import {
	commandNames,
	validateOrFirstError,
	PingInput,
	HealthReport,
	SmokeReportInput,
} from "./index.js";

describe("命令注册表", () => {
	it("包含 M0 全部命令", () => {
		expect(commandNames()).toEqual(expect.arrayContaining(["dev:ping", "health:get", "smoke:report"]));
	});
});

describe("validateOrFirstError", () => {
	it("合法 ping 输入通过", () => {
		expect(validateOrFirstError(PingInput, { echo: "hello" })).toEqual({ ok: true });
	});

	it("缺字段拒绝并给出路径", () => {
		const r = validateOrFirstError(PingInput, {});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("echo");
	});

	it("类型错误拒绝", () => {
		const r = validateOrFirstError(PingInput, { echo: 123 });
		expect(r.ok).toBe(false);
	});

	it("空字符串拒绝（minLength 1）", () => {
		expect(validateOrFirstError(PingInput, { echo: "" }).ok).toBe(false);
	});
});

describe("HealthReport / SmokeReport schema", () => {
	const validHealth = {
		ok: true,
		appVersion: "0.1.0",
		schemaVersion: 1,
		dataDir: "/tmp/x",
		logFile: "/tmp/x/logs/app.jsonl",
		uptimeMs: 100,
		steps: [{ name: "db", ok: true }],
	};

	it("合法健康报告通过", () => {
		expect(validateOrFirstError(HealthReport, validHealth).ok).toBe(true);
	});

	it("缺 steps 拒绝", () => {
		const { steps: _steps, ...noSteps } = validHealth;
		expect(validateOrFirstError(HealthReport, noSteps).ok).toBe(false);
	});

	it("smoke 报告允许 health 为 null", () => {
		expect(validateOrFirstError(SmokeReportInput, { rendererBoot: true, health: null, error: "x" }).ok).toBe(true);
		expect(validateOrFirstError(SmokeReportInput, { rendererBoot: false, health: null }).ok).toBe(true);
	});
});
