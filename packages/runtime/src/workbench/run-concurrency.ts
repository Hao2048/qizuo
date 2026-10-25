import type { AgentLimits } from "@pi-harness/contracts";
import { DEFAULT_AGENT_LIMITS } from "@pi-harness/shared";
export { DEFAULT_AGENT_LIMITS };
/** Queues active work and propagates explicit cancellation; never meters usage. */
export class RunConcurrency {
  readonly limits: Required<AgentLimits>;
  #active = 0;
  #stopped = false;
  #waiters: Array<() => void> = [];
  constructor(limits: AgentLimits = {}) {
    this.limits = { ...DEFAULT_AGENT_LIMITS, ...limits };
  }
  check(): string | null {
    return this.#stopped ? "任务已停止" : null;
  }
  stop(): void {
    this.#stopped = true;
    for (const wake of this.#waiters.splice(0)) wake();
  }
  async acquire(): Promise<() => void> {
    const stopped = this.check();
    if (stopped) throw new Error(stopped);
    while (this.#active >= this.limits.maxConcurrent) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
      if (this.check()) throw new Error(this.check()!);
    }
    const reason = this.check();
    if (reason) throw new Error(reason);
    this.#active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      this.#waiters.shift()?.();
    };
  }
}
