import type { Workbench, WorkbenchMessage } from "@pi-harness/contracts";

/** A suspended worker lends one model slot, even if its tools ask multiple questions. */
export class SerialConsultations {
  #tails = new Map<string, Promise<unknown>>();
  async run<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const prior=this.#tails.get(taskId)??Promise.resolve();
    const next=prior.catch(()=>{}).then(work);
    this.#tails.set(taskId,next);
    try { return await next; }
    finally { if(this.#tails.get(taskId)===next)this.#tails.delete(taskId); }
  }
}

/** Only the active human request may supply an execution scope. Notes cannot create one. */
export function nextCollaboration(w: Workbench, requestId: string): WorkbenchMessage | undefined {
  return w.messages.find(m => m.requestId === requestId &&
    ["collaboration", "delivery"].includes(m.notification?.purpose ?? "") &&
    m.notification?.automatic?.state === "queued");
}

export function collaborationBlock(w: Workbench, message: WorkbenchMessage, assignedRoles: Set<string>): string | undefined {
  const recipient = w.participants.find(p => p.roleId === message.recipients[0]);
  if (!recipient || recipient.unavailable) return "接收角色不可用，请由用户安排职责交接。";
  if (!recipient.enabled) return "接收角色已暂停；保留通知，不自动启用。";
  if (w.phase !== "running" || w.proposals.some(p => p.status === "pending")) return "执行已停止或有待确认的接口变更。";
  if (!assignedRoles.has(recipient.roleId)) return "接收角色未获本轮分工；保留通知，等待任务助手根据用户要求安排。";
  return undefined;
}

/** Startup/stop never replay queued actions. Information and explicit read receipts survive. */
export function interruptCollaborations(w: Workbench, reason: string): void {
  for (const message of w.messages) {
    const automatic = message.notification?.automatic;
    if (automatic && ["queued", "running"].includes(automatic.state)) {
      automatic.state = "interrupted";
      automatic.reason = reason;
    }
  }
  for (const participant of w.participants) delete participant.collaborationWait;
}
