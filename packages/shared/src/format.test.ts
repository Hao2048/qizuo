import { describe, expect, it } from "vitest";
import { clamp, formatBytes, formatDuration, formatPercent, formatTokens, truncate } from "./index.js";

describe("formatBytes", () => {
	it("已知字节数正常显示", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2.0 KB");
		expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MB");
	});

	it("未知显示「未知」而不是 0", () => {
		expect(formatBytes(null)).toBe("未知");
		expect(formatBytes(undefined)).toBe("未知");
		expect(formatBytes(Number.NaN)).toBe("未知");
	});
});

describe("formatTokens", () => {
	it("数量级缩写", () => {
		expect(formatTokens(42)).toBe("42");
		expect(formatTokens(4200)).toBe("4.2k");
		expect(formatTokens(123_456)).toBe("123k");
		expect(formatTokens(2_500_000)).toBe("2.5M");
	});

	it("未知显示「未知」", () => {
		expect(formatTokens(null)).toBe("未知");
		expect(formatTokens(undefined)).toBe("未知");
	});
});

describe("formatDuration / formatPercent / 其他", () => {
	it("时长", () => {
		expect(formatDuration(500)).toBe("500ms");
		expect(formatDuration(1500)).toBe("1.5s");
		expect(formatDuration(65_000)).toBe("1m05s");
		expect(formatDuration(3_600_000)).toBe("1h00m");
		expect(formatDuration(-1)).toBe("未知");
	});

	it("百分比未知口径", () => {
		expect(formatPercent(0.0523)).toBe("5.2%");
		expect(formatPercent(0.75)).toBe("75%");
		expect(formatPercent(null)).toBe("未知");
	});

	it("clamp 与 truncate", () => {
		expect(clamp(5, 0, 10)).toBe(5);
		expect(clamp(-1, 0, 10)).toBe(0);
		expect(clamp(11, 0, 10)).toBe(10);
		expect(truncate("abcdefghij", 8)).toBe("abcdefg…");
		expect(truncate("short", 10)).toBe("short");
	});
});
