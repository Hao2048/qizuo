import { createHash } from "node:crypto";
import type { AgentRun, PlanState, PlanStep, TaskCompletion } from "@pi-harness/contracts";

// One live invocation only. Never reads/replays earlier transcripts or calls a model.
export class CompletionCheck {
  planTouched = false;
  #calls = new Map<string, string>();
  #failed = new Set<string>();
  #finalReply = false;

  constructor(readonly approvedPlan: boolean, readonly previousAgents: string[] = []) {}

  event(event: unknown): void {
    const e = event as { type: string; toolCallId?: string; toolName?: string; args?: unknown; isError?: boolean; message?: { role?: string; stopReason?: string; content?: Array<{ type: string; text?: string }> } };
    if (e.type === "tool_execution_start" && e.toolCallId) {
      // Keep only a digest: paths, command arguments and plugin secrets are not receipts.
      const key = createHash("sha256").update(JSON.stringify([e.toolName, canonical(e.args)])).digest("hex");
      this.#calls.set(e.toolCallId, key);
      this.#finalReply = false;
    }
    if (e.type === "tool_execution_end" && e.toolCallId) {
      const key = this.#calls.get(e.toolCallId) ?? e.toolCallId;
      if (e.isError) this.#failed.add(key);
      else this.#failed.delete(key); // Only an identical successful retry resolves a known failure.
      this.#calls.delete(e.toolCallId);
    }
    if (e.type === "message_end" && e.message?.role === "assistant") {
      this.#finalReply = e.message.stopReason === "stop" && !!e.message.content?.some(c => c.type === "text" && c.text?.trim());
    }
  }

  finish(plan: PlanStep[], state: PlanState | undefined, agents: AgentRun[]): TaskCompletion {
    const issues: TaskCompletion["issues"] = [];
    if (this.planTouched || this.approvedPlan) {
      const pending = plan.filter(s => s.status !== "completed").length;
      if (pending) issues.push(state?.requiresApproval && state.status === "draft"
        ? { code: "plan_approval", message: `计划仍有 ${pending} 项待确认，尚未全部执行。` }
        : { code: "plan_pending", message: `本轮计划仍有 ${pending} 项未完成，请核对实际结果。` });
    }
    if (this.#failed.size) issues.push({ code: "tool_failed", message: `本轮有 ${this.#failed.size} 项工具操作失败或被拒绝，尚无相同操作成功的记录；如已改用其他方案，请结合回复核对。` });
    if (this.#calls.size) issues.push({ code: "tool_pending", message: "仍有工具操作缺少结束记录，请核对实际结果。" });
    if (!this.#finalReply) issues.push({ code: "response_incomplete", message: "未收到正常结束的文字回复，可能被截断或中断，请核对已有输出。" });
    if (agents.some(a => !this.previousAgents.includes(a.id) && a.status !== "done"))
      issues.push({ code: "agent_unresolved", message: "本轮子任务仍有未完成、失败或中断记录，请核对子任务结果。" });
    return { checkedAt: Date.now(), outcome: issues.length ? "needs_attention" : "reply_ended", issues };
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
