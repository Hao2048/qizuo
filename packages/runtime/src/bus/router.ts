/**
 * MessageRouter：传输无关的命令总线。
 *
 * Electron 的 ipcMain 只是它的一个适配器；单测直接驱动 router 本身。
 * 契约（schema）来自 @pi-harness/contracts，输入输出双重校验，
 * 任何失败都折叠为 InvokeError 信封——异常永不穿透到传输层。
 */
import type { InvokeEnvelope, InvokeErrorCode } from "@pi-harness/contracts";
import { validateOrFirstError } from "@pi-harness/contracts";
import type { TSchema } from "typebox";
import { Logger } from "../logging/logger.js";

export interface CommandHandlerCtx {
	log: Logger;
}

export interface CommandRegistration {
	input: TSchema;
	output: TSchema;
	handler: (input: any, ctx: CommandHandlerCtx) => unknown | Promise<unknown>;
}

export type RouterEventListener = (event: { type: string; ts: number; payload: unknown }) => void;

export class MessageRouter {
	#commands = new Map<string, CommandRegistration>();
	#listeners = new Set<RouterEventListener>();
	#ctx: CommandHandlerCtx;

	constructor(opts: { logger?: Logger } = {}) {
		this.#ctx = { log: opts.logger ?? new Logger() };
	}

	register(name: string, reg: CommandRegistration): void {
		if (this.#commands.has(name)) {
			throw new Error(`命令重复注册: ${name}`);
		}
		this.#commands.set(name, reg);
	}

	has(name: string): boolean {
		return this.#commands.has(name);
	}

	names(): string[] {
		return [...this.#commands.keys()];
	}

	/** 永不抛出；一切失败编码为 InvokeError。 */
	async invoke(name: string, input: unknown): Promise<InvokeEnvelope<unknown>> {
		const fail = (code: InvokeErrorCode, message: string): InvokeEnvelope<unknown> => ({
			ok: false,
			error: { code, message },
		});

		const reg = this.#commands.get(name);
		if (!reg) {
			this.#ctx.log.warn("router: 未知命令", { name });
			return fail("unknown_command", `未知命令: ${name}`);
		}

		const inputCheck = validateOrFirstError(reg.input, input);
		if (!inputCheck.ok) {
			return fail("invalid_input", `命令 ${name} 输入校验失败: ${inputCheck.message}`);
		}

		let raw: unknown;
		try {
			raw = await reg.handler(input, this.#ctx);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.#ctx.log.error("router: 处理器异常", { name, message });
			return fail("handler_error", `命令 ${name} 执行失败: ${message}`);
		}

		const outputCheck = validateOrFirstError(reg.output, raw);
		if (!outputCheck.ok) {
			this.#ctx.log.error("router: 输出契约违约", { name, message: outputCheck.message });
			return fail("invalid_output", `命令 ${name} 输出校验失败: ${outputCheck.message}`);
		}

		return { ok: true, result: raw };
	}

	/** 同步扇发事件；单个监听器异常被记录且不影响其他监听器。 */
	emit(type: string, payload: unknown): void {
		const event = { type, ts: Date.now(), payload };
		for (const l of this.#listeners) {
			try {
				l(event);
			} catch (err) {
				this.#ctx.log.error("router: 事件监听器异常", {
					eventType: type,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	onEvent(listener: RouterEventListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
}
