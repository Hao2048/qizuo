import type { Workbench, WorkbenchMessage } from "@pi-harness/contracts";
import { uuidv7 } from "@pi-harness/shared";
export type NotificationPurpose = NonNullable<WorkbenchMessage["notification"]>["purpose"];

/** A directed, immutable note is reference data, never a new execution permission. */
export function pendingNotifications(w: Workbench, roleId: string): WorkbenchMessage[] {
  return w.messages.filter(m=>m.notification && m.notification.status!=="handled" && m.recipients.length===1 && m.recipients[0]===roleId);
}

/** Preserve whole notes and FIFO order while bounding explicit read output, too. */
export function notificationBatch(pending: WorkbenchMessage[]): WorkbenchMessage[] {
  const selected: WorkbenchMessage[]=[];let chars=0;
  for(const message of pending) {
    if(selected.length===4 || chars+message.text.length>4000) break;
    selected.push(message);chars+=message.text.length;
  }
  return selected;
}

export function enqueueNotification(w: Workbench, input: {
  taskId: string; toolCallId: string; requestId: string; sender: string; roleId: string; message: string;
  purpose?: NotificationPurpose;
}): WorkbenchMessage {
  if(input.purpose && !["information","question","collaboration","delivery"].includes(input.purpose))throw Error("协作消息用途无效");
  const text=input.message.trim();
  if(!text || text.length>4000 || !input.toolCallId || input.toolCallId.length>200) throw Error("通知内容或调用标识无效");
  const sender=w.participants.find(p=>p.roleId===input.sender), recipient=w.participants.find(p=>p.roleId===input.roleId);
  if(!sender?.enabled || sender.unavailable) throw Error("发送角色已暂停或不可用");
  if(!recipient || recipient.roleId===sender.roleId) throw Error("只能通知本任务中的其他专业角色");
  const prior=w.messages.find(m=>m.notification?.sourceTaskId===input.taskId && m.notification.sourceToolCallId===input.toolCallId);
  if(prior) {
    if(prior.recipients[0]!==input.roleId || prior.text!==text || (prior.notification?.purpose??"information")!==(input.purpose??"information")) throw Error("通知调用标识已用于其他内容，未重复发送");
    return prior;
  }
  const identical=w.messages.find(m=>m.notification?.sourceTaskId===input.taskId && m.recipients[0]===input.roleId && m.text===text && (m.notification?.purpose??"information")===(input.purpose??"information"));
  if(identical) return identical;
  if(pendingNotifications(w,input.roleId).length>=40) throw Error("该角色已有40条未处理通知，请先安排其处理，不能丢弃旧通知");
  // Derive ancestry from a host-recorded run, never from model-supplied fields.
  const parent=w.messages.find(m=>m.notification?.automatic?.taskId===input.taskId)?.notification?.automatic;
  const roleChain=parent?.roleChain??[sender.roleId];
  const purpose=input.purpose??"information";
  const cycle=purpose!=="information" && purpose!=="question" && roleChain.includes(input.roleId);
  const message:WorkbenchMessage={id:uuidv7(),requestId:input.requestId,sender:sender.roleId,senderName:sender.name,
    recipients:[recipient.roleId],kind:"handoff",text,at:Date.now(),
    notification:{sourceTaskId:input.taskId,sourceToolCallId:input.toolCallId,status:"pending",purpose,
      ...(purpose!=="information" ? {automatic:{state:cycle?"blocked" as const:"queued" as const,roleChain:[...roleChain],...(cycle?{reason:"协作链重复唤醒同一角色，请由用户确认下一步，未自动循环执行。"}:{})}} : {})}};
  w.messages.push(message);
  return message;
}

export function deliverNotifications(w: Workbench, roleId: string, taskId: string, ids: string[]): boolean {
  let changed=false;
  for(const id of new Set(ids)) {
    const message=w.messages.find(m=>m.id===id && m.notification && m.recipients.length===1 && m.recipients[0]===roleId);
    const n=message?.notification;
    if(!n || n.status==="handled" || n.deliveredTaskId===taskId) continue;
    n.status="delivered";n.deliveredTaskId=taskId;n.deliveredAt=Date.now();changed=true;
  }
  return changed;
}

export function acknowledgeNotifications(w: Workbench, roleId: string, taskId: string, ids: string[], note: string): void {
  if(!ids.length || ids.length>8 || new Set(ids).size!==ids.length || !note.trim() || note.length>1000) throw Error("请指定1至8条通知并说明处理结果");
  // Validate the whole batch before modifying anything. A role cannot acknowledge another role's inbox.
  const messages=ids.map(id=>{
    const message=w.messages.find(m=>m.id===id && m.notification && m.recipients.length===1 && m.recipients[0]===roleId);
    if(!message?.notification) throw Error("通知不存在或不属于当前接收角色");
    const n=message.notification;
    if(n.status!=="handled" && (n.status!=="delivered" || n.deliveredTaskId!==taskId)) throw Error("请先读取本次执行收到的完整通知，再确认处理");
    return message;
  });
  for(const message of messages) {
    const n=message.notification!;
    if(n.status==="handled") continue;
    n.status="handled";n.handledTaskId=taskId;n.handledAt=Date.now();n.handlingNote=note.trim();
    if(n.automatic && (n.automatic.state!=="running" || n.automatic.taskId!==taskId)) {
      n.automatic.state="completed";delete n.automatic.reason;
    }
  }
}
