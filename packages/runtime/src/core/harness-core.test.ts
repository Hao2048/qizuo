import { describe, expect, it } from "vitest";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHealthReport, createHarnessCore, latestMigrationVersion } from "./harness-core.js";

describe("pi SDK 依赖", () => {
	it("锁定版本 1.0.3 可正常导入", () => {
		expect(VERSION).toBe("1.0.3");
	});
});

describe("createHarnessCore 集成", () => {
	it("装配后健康报告全绿，ping 全链路可用", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pih-core-"));
		try {
			const core = await createHarnessCore({ dataDir: dir, appVersion: "0.1.0-test" });
			expect(existsSync(join(dir, "harness.db"))).toBe(true);
			expect(existsSync(join(dir, "logs"))).toBe(true);

			const pingEnv = await core.router.invoke("dev:ping", { echo: "链路" });
			expect(pingEnv.ok).toBe(true);
			if (pingEnv.ok) {
				expect(pingEnv.result).toMatchObject({ echo: "链路", pong: true });
			}

			const healthEnv = await core.router.invoke("health:get", {});
			expect(healthEnv.ok).toBe(true);
			if (healthEnv.ok) {
				const report = healthEnv.result as ReturnType<typeof buildHealthReport>;
				expect(report.ok).toBe(true);
				expect(report.appVersion).toBe("0.1.0-test");
				expect(report.schemaVersion).toBe(latestMigrationVersion());
				expect(report.steps.map((s) => s.name)).toEqual([
					"sqlite",
					"migrations",
					"logger",
					"router",
					"default-role",
				]);
				for (const s of report.steps) expect(s.ok, `${s.name}: ${s.detail}`).toBe(true);
			}

			core.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("health:get 输出通过契约校验（防自欺）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pih-core2-"));
		try {
			const core = await createHarnessCore({ dataDir: dir });
			// 走 router（含输出校验）本身就是契约校验；此处显式再验一次
			const env = await core.router.invoke("health:get", {});
			expect(env.ok).toBe(true);
			core.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
