/**
 * UUID v7：48bit 毫秒时间戳 + 随机位，字典序即时间序。
 * 使用 Web Crypto（globalThis.crypto），Node ≥19 与浏览器/渲染进程均可用，保持包同构。
 */
export function uuidv7(now: number = Date.now()): string {
	const ts = BigInt(now);
	const b = new Uint8Array(16);
	globalThis.crypto.getRandomValues(b);
	b[0] = Number((ts >> 40n) & 0xffn);
	b[1] = Number((ts >> 32n) & 0xffn);
	b[2] = Number((ts >> 24n) & 0xffn);
	b[3] = Number((ts >> 16n) & 0xffn);
	b[4] = Number((ts >> 8n) & 0xffn);
	b[5] = Number(ts & 0xffn);
	b[6] = (b[6]! & 0x0f) | 0x70; // version 7
	b[8] = (b[8]! & 0x3f) | 0x80; // variant 10xx
	const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidv7(value: string): boolean {
	return UUID_RE.test(value);
}

/** 从 uuidv7 中恢复生成时刻（毫秒）。非法输入返回 null。 */
export function uuidv7Timestamp(value: string): number | null {
	if (!isUuidv7(value)) return null;
	const hex = value.replace(/-/g, "").slice(0, 12);
	return Number.parseInt(hex, 16);
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export function truncate(text: string, max: number, suffix = "…"): string {
	if (text.length <= max) return text;
	return text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** 字节数人性化显示（诚实口径：未知传 null）。 */
export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "未知";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = bytes;
	let i = -1;
	do {
		v /= 1024;
		i++;
	} while (v >= 1024 && i < units.length - 1);
	return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** token 数显示：大数缩写，未知显示"未知"而不是 0。 */
export function formatTokens(tokens: number | null | undefined): string {
	if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) return "未知";
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "未知";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
	const m = Math.floor(s / 60);
	const rest = Math.round(s % 60);
	if (m < 60) return `${m}m${rest.toString().padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${(m % 60).toString().padStart(2, "0")}m`;
}

/** 百分比显示；容量/用量未知时返回"未知"（不得用累计 token 冒充）。 */
export function formatPercent(ratio: number | null | undefined): string {
	if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "未知";
	return `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`;
}

/** Shared UI/runtime defaults; kept independent of schema compilation. */
export const DEFAULT_AGENT_LIMITS = {maxConcurrent:3,maxMembers:8};
