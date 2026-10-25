import type { WorkbenchMessage, WorkbenchParticipant } from "@pi-harness/contracts";

export default function NotificationReceipt({message,recipient,phase,isCurrent=true}:{message:WorkbenchMessage;recipient?:WorkbenchParticipant;phase?:string;isCurrent?:boolean}) {
  const receipt=message.notification;
  if(!receipt) return null;
  const automatic=receipt.automatic;
  const purpose=receipt.purpose??"information";
  const label={information:"信息同步",question:"请求答复",collaboration:"请求协作",delivery:"交付就绪"}[purpose];
  const waiting=!recipient ? "接收角色已交接，待用户重新安排" : recipient.unavailable ? "接收角色不可用" : !recipient.enabled ? "接收角色已暂停" : ["running","planning"].includes(recipient.status) ? "接收角色正在工作" : "等待接收角色继续工作";
  const automaticReason=!recipient||recipient.unavailable||!recipient.enabled?`${waiting}；请求保留，不自动启用。`
    : automatic?.reason??(!isCurrent?"这是历史协作请求，不会因查看而重新执行。"
    : automatic?.state==="interrupted"?"请求已中断，保留消息；不会自动重放。"
    : phase&&!["running","planning","routing"].includes(phase)?"本轮已结束推进，仍需核对这条请求；不会因查看而重新执行。"
    : automatic?.state==="running"?purpose==="question"?"正在只读答复，不执行工具。":"正在按本轮职责处理协作请求。"
    : purpose==="question"?"问题已排队，等待本角色上一条问答结束。":"等待本轮执行的安全边界；只在已有分工与权限内推进，暂停角色不唤醒。");
  return <div className="wb-notification-receipt" aria-label="协作通知状态">
    {purpose!=="information" && <span className="badge">{label}</span>}
    <span className="badge">{receipt.status==="handled" ? purpose==="question"?"角色已只读答复":"接收角色已确认处理" : receipt.status==="delivered" ? "已带入接收方上下文 · 待处理" : "待送达"}</span>
    {receipt.status!=="handled" && <small>{automatic
      ? automaticReason
      : `${waiting}；不会因此自动启动角色。`}</small>}
    {receipt.status==="handled" && <>
      {receipt.handlingNote && <p>{receipt.handlingNote}</p>}
      <small>这是角色的处理回执，成果仍须按正常流程审阅与验收。</small>
    </>}
  </div>;
}
