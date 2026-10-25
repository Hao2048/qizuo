/**
 * 渲染进程类型化 IPC 客户端。
 * 桥由 preload 注入（window.pih）；无桥环境（纯浏览器）显式报错。
 */
import type {
	AnyAppEvent,
	CommandInput,
	CommandName,
	CommandOutput,
	InvokeEnvelope,
} from "@pi-harness/contracts";

export interface PiHBridge {
 onDraftFlush?: (cb:()=>Promise<void>)=>()=>void;
	invoke(name: string, payload?: unknown): Promise<unknown>;
	onEvent(cb: (event: unknown) => void): () => void;
	platform: string;
	versions: { electron: string; chrome: string };
}

declare global {
	interface Window {
		pih?: PiHBridge;
	}
}

export function bridge(): PiHBridge {
	const b = typeof window !== "undefined" ? window.pih : undefined;
	if (!b) throw new Error("当前环境缺少 PiH 桥（需在 栖作 Qizuo 应用内运行）");
	return b;
}

export async function invoke<N extends CommandName>(
	name: N,
	input: CommandInput<N>,
): Promise<CommandOutput<N>> {
	const env = (await bridge().invoke(name, input)) as InvokeEnvelope<CommandOutput<N>>;
	if (!env.ok) throw new Error(env.error.message);
	return env.result;
}

export function onEvent(cb: (event: AnyAppEvent) => void): () => void {
	return bridge().onEvent((e) => cb(e as AnyAppEvent));
}
