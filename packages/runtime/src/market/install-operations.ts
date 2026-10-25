import { randomUUID } from "node:crypto";

const publishing = new WeakSet<AbortSignal>();
function recoveryFailed(value: unknown): boolean {
	return !!value && typeof value === "object" && "message" in value && typeof value.message === "string" && value.message.includes("自动恢复未完成");
}
/** Publication is synchronous; after this boundary cancellation is no longer accepted. */
export function sealInstall(signal?: AbortSignal): void {
	signal?.throwIfAborted();
	if (signal) publishing.add(signal);
}

/** Shared catalog reads may finish for other consumers; a cancelled install stops waiting. */
export function waitForInstall<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
		signal.addEventListener("abort", abort, { once: true });
		promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
		if (signal.aborted) abort();
	});
}

/** IDs belong to one install request; cancelling never affects another queued request. */
export class InstallOperations {
	#running = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
	#closed = false;
	async run<T>(id: string | undefined, install: (signal: AbortSignal) => Promise<T>, cancelled: () => T): Promise<T> {
		if (this.#closed) return cancelled();
		const key = id ?? randomUUID();
		if (this.#running.has(key)) throw new Error("安装请求编号重复");
		const controller = new AbortController();
		let finish!: () => void;
		const done = new Promise<void>(resolve => { finish = resolve; });
		this.#running.set(key, { controller, done });
		try {
			const result = await install(controller.signal);
			return controller.signal.aborted && !recoveryFailed(result) ? cancelled() : result;
		} catch (error) {
			if (controller.signal.aborted && !recoveryFailed(error)) return cancelled();
			throw error;
		} finally { this.#running.delete(key); finish(); }
	}
	cancel(id: string): boolean {
		const operation = this.#running.get(id);
		if (!operation || publishing.has(operation.controller.signal)) return false;
		operation.controller.abort(new Error("已取消安装"));
		return true;
	}
	dispose(): void {
		this.#closed = true;
		for (const id of this.#running.keys()) this.cancel(id);
	}
	async shutdown(): Promise<void> {
		this.dispose();
		await Promise.allSettled([...this.#running.values()].map(x => x.done));
	}
}
