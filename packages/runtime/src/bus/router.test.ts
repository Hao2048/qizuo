import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { MessageRouter } from "./router.js";

describe("MessageRouter", () => {
	it("注册后调用成功返回输出", async () => {
		const router = new MessageRouter();
		router.register("demo:add", {
			input: Type.Object({ a: Type.Number(), b: Type.Number() }),
			output: Type.Object({ sum: Type.Number() }),
			handler: (input: any) => ({ sum: input.a + input.b }),
		});
		const env = await router.invoke("demo:add", { a: 2, b: 3 });
		expect(env).toEqual({ ok: true, result: { sum: 5 } });
	});

	it("未知命令返回 unknown_command 而不抛出", async () => {
		const router = new MessageRouter();
		const env = await router.invoke("nope", {});
		expect(env.ok).toBe(false);
		if (!env.ok) {
			expect(env.error.code).toBe("unknown_command");
			expect(env.error.message).toContain("nope");
		}
	});

	it("输入校验失败返回 invalid_input 且信息含字段路径", async () => {
		const router = new MessageRouter();
		router.register("demo", {
			input: Type.Object({ echo: Type.String() }),
			output: Type.Object({ echo: Type.String() }),
			handler: (i: any) => i,
		});
		const env = await router.invoke("demo", { wrong: 1 });
		expect(env.ok).toBe(false);
		if (!env.ok) {
			expect(env.error.code).toBe("invalid_input");
			expect(env.error.message).toContain("echo");
		}
	});

	it("处理器异常折叠为 handler_error", async () => {
		const router = new MessageRouter();
		router.register("boom", {
			input: Type.Object({}),
			output: Type.Object({ ok: Type.Boolean() }),
			handler: () => {
				throw new Error("内部炸了");
			},
		});
		const env = await router.invoke("boom", {});
		expect(env.ok).toBe(false);
		if (!env.ok) {
			expect(env.error.code).toBe("handler_error");
			expect(env.error.message).toContain("内部炸了");
		}
	});

	it("输出契约违约被拦截（invalid_output）", async () => {
		const router = new MessageRouter();
		router.register("bad-output", {
			input: Type.Object({}),
			output: Type.Object({ must: Type.String() }),
			handler: () => ({ unexpected: 1 }),
		});
		const env = await router.invoke("bad-output", {});
		expect(env.ok).toBe(false);
		if (!env.ok) expect(env.error.code).toBe("invalid_output");
	});

	it("重复注册抛错；names/has 正常", () => {
		const router = new MessageRouter();
		const reg = {
			input: Type.Object({}),
			output: Type.Object({}),
			handler: () => ({}),
		};
		router.register("a", reg);
		expect(() => router.register("a", reg)).toThrow();
		expect(router.has("a")).toBe(true);
		expect(router.names()).toContain("a");
	});

	it("事件扇发：多监听器都收到；异常监听器不影响他人；退订生效", () => {
		const router = new MessageRouter();
		const got: string[] = [];
		router.onEvent((e) => got.push(`a:${e.type}`));
		const off = router.onEvent((e) => {
			got.push(`b:${e.type}`);
			if (e.type === "bad") throw new Error("listener boom");
		});
		router.onEvent((e) => got.push(`c:${(e.payload as any).v}`));

		router.emit("good", { v: 1 });
		expect(got).toEqual(["a:good", "b:good", "c:1"]);

		got.length = 0;
		router.emit("bad", { v: 2 });
		// a 与 c 仍然收到，b 抛错不中断
		expect(got).toEqual(["a:bad", "b:bad", "c:2"]);

		got.length = 0;
		off();
		router.emit("good", { v: 3 });
		expect(got).toEqual(["a:good", "c:3"]);
	});

	it("并发调用互不干扰", async () => {
		const router = new MessageRouter();
		router.register("echo", {
			input: Type.Object({ n: Type.Number() }),
			output: Type.Object({ n: Type.Number() }),
			handler: async (i: any) => {
				await new Promise((r) => setTimeout(r, 5 + (i.n % 3)));
				return { n: i.n };
			},
		});
		const results = await Promise.all(
			Array.from({ length: 50 }, (_, n) => router.invoke("echo", { n })),
		);
		for (let n = 0; n < 50; n++) {
			const env = results[n]!;
			expect(env.ok).toBe(true);
			if (env.ok) expect(env.result).toEqual({ n });
		}
	});
});
