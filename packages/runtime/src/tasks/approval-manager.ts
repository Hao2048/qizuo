/**
 * 审批管理器：工具调用审批的挂起/决策/清理。
 * 一次审批一个 Promise；任务中止时统一拒绝，避免会话悬挂。
 */
import type { ApprovalRequest } from "@pi-harness/contracts";
import type { ApprovalDecision } from "../pi/agent-factory.js";

interface PendingApproval {
	request: ApprovalRequest;
	resolve: (d: ApprovalDecision) => void;
}

export class ApprovalManager {
	#pending = new Map<string, PendingApproval>(); // key: [taskId, toolCallId]

	create(request: ApprovalRequest): Promise<ApprovalDecision> {
		const key = JSON.stringify([request.taskId, request.toolCallId]);
		const existing = this.#pending.get(key);
		if (existing) {
			// 不应发生（toolCallId 唯一）；防御性处理
			return Promise.resolve({ approved: false, reason: "重复的审批请求" });
		}
		return new Promise<ApprovalDecision>((resolve) => {
			this.#pending.set(key, { request, resolve });
		});
	}

	decide(toolCallId: string, approved: boolean, reason?: string, taskId?: string): boolean {
		// Internal callers may omit taskId only when the call ID is unambiguous.
        const matches = taskId === undefined ? [...this.#pending.entries()].filter(([, p]) => p.request.toolCallId === toolCallId) : [];
        const key = taskId === undefined ? (matches.length === 1 ? matches[0]![0] : undefined) : JSON.stringify([taskId, toolCallId]);
        const p = key === undefined ? undefined : this.#pending.get(key);
		if (!p) return false;
		// 校验归属：审批决策不得跨任务生效
		if (taskId !== undefined && p.request.taskId !== taskId) return false;
		this.#pending.delete(key!);
		p.resolve({ approved, reason: approved ? undefined : (reason ?? "用户拒绝了此次工具调用") });
		return true;
	}

	pending(): ApprovalRequest[] {
		return [...this.#pending.values()].map((p) => p.request);
	}

	/** 全部按拒绝清理（仅诊断/退出场景使用）。 */
	rejectAll(reason: string): number {
		return this.#rejectWhere(() => true, reason);
	}

	/** 按任务拒绝：停止一个任务不影响其他任务的待审批。 */
	rejectTask(taskId: string, reason: string): number {
		return this.#rejectWhere((req) => req.taskId === taskId, reason);
	}

	#rejectWhere(match: (req: ApprovalRequest) => boolean, reason: string): number {
		let n = 0;
		for (const [id, p] of this.#pending) {
			if (!match(p.request)) continue;
			this.#pending.delete(id);
			p.resolve({ approved: false, reason });
			n++;
		}
		return n;
	}
}
