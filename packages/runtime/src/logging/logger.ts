/**
 * 结构化 JSONL 日志器。
 * - 按天分文件：app-YYYY-MM-DD.jsonl
 * - 写入前对敏感键脱敏（凭证绝不落日志）
 * - 支持 sink 注入（测试）与 now 注入（时间相关测试）
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const DEFAULT_REDACT_KEYS = [
	"apikey",
	"api_key",
	"password",
	"token",
	"authorization",
	"secret",
	"credential",
	"credentials",
	"access_token",
	"refresh_token",
	"cookie",
];

/** 深拷贝并掩蔽敏感键（大小写不敏感）。 */
export function redact(value: unknown, keys: string[] = DEFAULT_REDACT_KEYS): unknown {
	const lower = new Set(keys.map((k) => k.toLowerCase()));
	const walk = (v: unknown): unknown => {
		if (v instanceof Error) return { name: v.name, message: v.message };
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
				out[k] = lower.has(k.toLowerCase()) ? "***" : walk(val);
			}
			return out;
		}
		return v;
	};
	return walk(value);
}

export interface LoggerOptions {
	dir?: string;
	level?: LogLevel;
	module?: string;
	redactKeys?: string[];
	sink?: (line: string) => void;
	now?: () => Date;
}

interface Shared {
	dir?: string;
	level: LogLevel;
	redactKeys: string[];
	sink?: (line: string) => void;
	now: () => Date;
}

export class Logger {
	#shared: Shared;
	#module: string;

	constructor(opts: LoggerOptions = {}) {
		this.#shared = {
			dir: opts.dir,
			level: opts.level ?? "info",
			redactKeys: opts.redactKeys ?? DEFAULT_REDACT_KEYS,
			sink: opts.sink,
			now: opts.now ?? (() => new Date()),
		};
		this.#module = opts.module ?? "app";
		if (this.#shared.dir) mkdirSync(this.#shared.dir, { recursive: true });
	}

	child(module: string): Logger {
		const c = new Logger();
		c.#shared = this.#shared;
		c.#module = `${this.#module}.${module}`;
		return c;
	}

	get module(): string {
		return this.#module;
	}

	get level(): LogLevel {
		return this.#shared.level;
	}

	/** 当前应写入的日志文件；未配置目录时为空字符串。 */
	currentFile(): string {
		if (!this.#shared.dir) return "";
		return join(this.#shared.dir, `app-${this.#shared.now().toISOString().slice(0, 10)}.jsonl`);
	}

	debug(msg: string, data?: unknown): void {
		this.#write("debug", msg, data);
	}
	info(msg: string, data?: unknown): void {
		this.#write("info", msg, data);
	}
	warn(msg: string, data?: unknown): void {
		this.#write("warn", msg, data);
	}
	error(msg: string, data?: unknown): void {
		this.#write("error", msg, data);
	}

	#write(level: LogLevel, msg: string, data?: unknown): void {
		if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#shared.level]) return;
		const entry: Record<string, unknown> = {
			ts: this.#shared.now().toISOString(),
			level,
			module: this.#module,
			msg,
		};
		if (data !== undefined) entry.data = redact(data, this.#shared.redactKeys);
		const line = JSON.stringify(entry);
		this.#shared.sink?.(line);
		if (this.#shared.dir) {
			appendFileSync(this.currentFile(), `${line}\n`, "utf8");
		}
	}
}
