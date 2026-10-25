import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger, redact, DEFAULT_REDACT_KEYS } from "./logger.js";

describe("redact", () => {
	it("嵌套对象与数组中的敏感键被掩蔽", () => {
		const input = {
			apiKey: "sk-secret",
			nested: { authorization: "Bearer x", safe: "ok" },
			list: [{ token: "t1" }, { name: "n" }],
		};
		const out = redact(input) as any;
		expect(out.apiKey).toBe("***");
		expect(out.nested.authorization).toBe("***");
		expect(out.nested.safe).toBe("ok");
		expect(out.list[0].token).toBe("***");
		expect(out.list[1].name).toBe("n");
	});

	it("大小写不敏感", () => {
		const out = redact({ API_KEY: "x", Password: "y" }) as any;
		expect(out.API_KEY).toBe("***");
		expect(out.Password).toBe("***");
	});

	it("原始对象不被修改", () => {
		const input = { token: "keep" };
		redact(input);
		expect(input.token).toBe("keep");
	});

	it("Error 序列化为 name+message 且默认键表非空", () => {
		const out = redact({ err: new Error("boom") }) as any;
		expect(out.err).toEqual({ name: "Error", message: "boom" });
		expect(DEFAULT_REDACT_KEYS.length).toBeGreaterThan(0);
	});
});

describe("Logger", () => {
	it("sink 收到合法 JSONL 且包含模块与数据", () => {
		const lines: string[] = [];
		const log = new Logger({ module: "test", sink: (l) => lines.push(l) });
		log.info("hello", { a: 1 });
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]!);
		expect(parsed.level).toBe("info");
		expect(parsed.module).toBe("test");
		expect(parsed.msg).toBe("hello");
		expect(parsed.data).toEqual({ a: 1 });
	});

	it("级别过滤：默认 info 时不写 debug", () => {
		const lines: string[] = [];
		const log = new Logger({ sink: (l) => lines.push(l) });
		log.debug("nope");
		log.warn("yes");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]!).level).toBe("warn");
	});

	it("敏感字段落日志前被脱敏", () => {
		const lines: string[] = [];
		const log = new Logger({ sink: (l) => lines.push(l) });
		log.info("login", { apiKey: "sk-real", user: "u" });
		const parsed = JSON.parse(lines[0]!);
		expect(parsed.data.apiKey).toBe("***");
		expect(parsed.data.user).toBe("u");
	});

	it("child 模块名带前缀并共享配置", () => {
		const lines: string[] = [];
		const log = new Logger({ module: "core", sink: (l) => lines.push(l) });
		const child = log.child("db");
		child.error("failed", { code: 1 });
		const parsed = JSON.parse(lines[0]!);
		expect(parsed.module).toBe("core.db");
		expect(parsed.level).toBe("error");
	});

	it("写文件到目录并按天滚动", () => {
		const dir = mkdtempSync(join(tmpdir(), "pih-log-"));
		let fake = new Date("2026-10-06T10:00:00Z");
		const log = new Logger({ dir, now: () => fake });
		log.info("day1");
		fake = new Date("2026-10-07T10:00:00Z");
		log.info("day2");

		const f1 = join(dir, "app-2026-10-06.jsonl");
		const f2 = join(dir, "app-2026-10-07.jsonl");
		expect(existsSync(f1)).toBe(true);
		expect(existsSync(f2)).toBe(true);
		expect(readFileSync(f1, "utf8")).toContain("day1");
		expect(readFileSync(f2, "utf8")).toContain("day2");
		expect(log.currentFile()).toBe(f2);
	});
});
