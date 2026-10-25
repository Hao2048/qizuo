import { describe, expect, it } from "vitest";
import { isUuidv7, uuidv7, uuidv7Timestamp } from "./index.js";

describe("uuidv7", () => {
	it("生成合法 v7 格式", () => {
		for (let i = 0; i < 200; i++) {
			const id = uuidv7();
			expect(isUuidv7(id)).toBe(true);
		}
	});

	it("同毫秒内多次生成互不重复", () => {
		const fixed = 1_770_000_000_000;
		const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(fixed)));
		expect(ids.size).toBe(1000);
	});

	it("可恢复时间戳（±2ms 容差）", () => {
		const now = Date.now();
		const id = uuidv7(now);
		const restored = uuidv7Timestamp(id);
		expect(restored).not.toBeNull();
		expect(Math.abs((restored as number) - now)).toBeLessThanOrEqual(2);
	});

	it("字典序与时间序一致", () => {
		const a = uuidv7(1_000_000_000_000);
		const b = uuidv7(1_000_000_000_001);
		expect(a < b).toBe(true);
	});

	it("非法输入被识别", () => {
		expect(isUuidv7("not-a-uuid")).toBe(false);
		expect(isUuidv7("550e8400-e29b-41d4-a716-446655440000")).toBe(false); // v4
		expect(uuidv7Timestamp("zzz")).toBeNull();
	});
});
