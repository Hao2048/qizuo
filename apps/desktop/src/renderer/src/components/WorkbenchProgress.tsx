import type { Workbench } from "@pi-harness/contracts";
import { workbenchProgress } from "../workbench-progress.js";
import Icon from "./Icon.js";

export default function WorkbenchProgress({w,onTab}:{w:Workbench;onTab:(tab:string)=>void}) {
  const {roles,finished,unresolved,assignedCount}=workbenchProgress(w);
  if(!roles.length)return null;
  const active=roles.filter(r=>r.progress.tone==="active").length;
  const waiting=roles.filter(r=>r.progress.tone==="waiting").length;
  const attention=roles.filter(r=>r.progress.tone==="attention").length;
  const paused=roles.filter(r=>!r.participant.enabled).length;
  const title=w.phase==="planning"?"正在共同规划":w.phase==="waiting_decision"?"等待选择协作方案":w.phase==="verifying"?"正在联调验收":w.phase==="done"?"已验收":assignedCount?`${finished}/${assignedCount} 项执行结束`:"正在处理协作问题";
  return <details className="wb-coordination" aria-label="本轮协作进度">
    <summary>
      <Icon name="team" size={16}/>
      <strong>{title}</strong>
      <span className="wb-coordination-counts" aria-live="polite" aria-atomic="true">
        {active>0&&<span>{active} 位工作中</span>}
        {waiting>0&&<span>{waiting} 位等待中</span>}
        {attention>0&&<span className="wb-progress-attention">{attention} 位需要处理</span>}
        {paused>0&&<span>{paused} 位已暂停</span>}
        {active===0&&waiting===0&&attention===0&&paused===0&&<span>{w.phase==="done"?"用户已确认交付":"执行结束后仍需审阅与验收"}</span>}
      </span>
      <Icon name="chevron" size={14}/>
    </summary>
    <ul className="wb-coordination-roles">
      {roles.map(({participant:p,progress})=><li key={p.roleId} data-tone={progress.tone}>
        <span className="wb-progress-dot" aria-hidden="true"/>
        <strong>{p.name}</strong>
        <div><b>{progress.label}</b><p>{progress.detail}</p></div>
        {progress.tab&&<button className="ghost sm" onClick={()=>onTab(progress.tab!)}>{progress.tab==="contracts"?"查看方案":progress.tab==="results"?"查看成果":progress.tab==="conversation"?"查看对话":"查看记录"}</button>}
      </li>)}
    </ul>
    {unresolved>0&&<p className="wb-coordination-note">{unresolved} 项协作请求待处理，尚未完成验收。</p>}
  </details>;
}
