import { useEffect, useRef, useState } from "react";
import type { MemoryUsageInfo } from "@pi-harness/contracts";
import { invoke } from "../api.js";
import { useStore } from "../store.js";
import { openTask } from "../data.js";
import { selectWorkbench } from "../workbench-data.js";

const stageName = { routing: "需求判断", planning: "角色规划", execution: "角色执行" };

export default function MemoryUsage({ roleId, memoryId, revision }: {
  roleId: string; memoryId?: string; revision: unknown;
}): React.ReactElement {
  const [expanded,setExpanded] = useState(false), [retry,setRetry] = useState(0);
  const [state,setState] = useState<{key:string;data?:MemoryUsageInfo;error?:string}>({key:""});
  const [opening,setOpening] = useState(false),[openError,setOpenError] = useState("");
  const key = `${roleId}:${memoryId ?? ""}`;
  const identity=useRef(key), alive=useRef(true);
  identity.current=key;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if (!expanded) return;
    let active = true;
    setState({key}); setOpenError("");
    void invoke("memory:usage",{roleId,...(memoryId ? {memoryId} : {})}).then(data=>{
      if(active) {
        if(data.roleId!==roleId || data.memoryId!==(memoryId ?? null)) throw Error("记忆使用记录不匹配，请刷新");
        setState({key,data});
      }
    }).catch(error=>{if(active)setState({key,error:String(error)});});
    return ()=>{active=false;};
  },[expanded,roleId,memoryId,revision,retry]);
  const data = state.key===key ? state.data : undefined;
  const error = state.key===key ? state.error : undefined;
  async function open(ref:MemoryUsageInfo["references"][number]) {
    if(opening)return;
    setOpening(true);setOpenError("");
    try {
      if(ref.workbenchId) await selectWorkbench(ref.workbenchId); else if(ref.taskId) await openTask(ref.taskId);
      const current=useStore.getState();
      if(alive.current && identity.current===key && current.page==="memory" && current.memoryRoleId===roleId)
        current.setTool(ref.workbenchId ? "collaboration" : "workbench");
    }
    catch {setOpenError("任务可能已删除或暂时无法打开，请刷新记录后重试。");}
    finally{setOpening(false);}
  }
  return <section className="memory-usage" aria-label="记忆使用情况">
    <button type="button" className="memory-usage-toggle" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>
      <span>记忆使用情况</span><span className="hint">{expanded ? "收起" : "查看采纳与引用"}</span>
    </button>
    {expanded && <div className="memory-usage-body" aria-busy={!data && !error}>
      {error ? <p className="hint danger" role="alert">使用记录加载失败。<button type="button" className="ghost" onClick={()=>setRetry(v=>v+1)}>重试</button></p>
      : !data ? <p className="hint" role="status">正在读取当前角色的使用记录…</p>
      : <>
        <dl className="memory-usage-metrics">
          <div><dt>自动来源记录</dt><dd>{data.summary.automaticTotal}</dd></div>
          <div><dt>当前采纳</dt><dd>{data.summary.automaticRetained}</dd></div>
          <div><dt>待核对</dt><dd>{data.summary.automaticPending}</dd></div>
          <div><dt>已忘记</dt><dd>{data.summary.automaticForgotten}</dd></div>
          <div><dt>正文修订过</dt><dd>{data.summary.automaticRevised}</dd></div>
          <div><dt>进入后续任务的记忆</dt><dd>{data.summary.referencedMemories}</dd></div>
        </dl>
        <p className="hint">采纳、待核对、忘记和修订统计针对本角色的对话及工作台自动来源记录；修订数可与其他状态重叠。</p>
        {memoryId && <div className="memory-usage-references">
          <h3>当前记忆的上下文引用</h3>
          {!data.references.length ? <p className="hint">尚无记录的上下文引用。</p> : <ul>
            {data.references.map((ref,index)=><li key={`${ref.taskId ?? ref.workbenchId}:${ref.stage}:${ref.version}:${index}`}>
              <button type="button" className="ghost" disabled={opening} onClick={()=>void open(ref)}>
                <span>{ref.title}</span><small>v{ref.version} · {stageName[ref.stage]} · {ref.subsequent ? "后续任务" : "来源任务"}</small>
                <small>最近引用 {new Date(ref.lastAt).toLocaleString()}</small>
              </button>
            </li>)}
          </ul>}
          {data.referenceTotal>20 && <p className="hint">共 {data.referenceTotal} 组版本/任务/阶段引用，显示最近 20 组。</p>}
        </div>}
        <p className="hint">自 {new Date(data.observedSince).toLocaleDateString()} 开始记录。上下文引用表示请求准备提交时携带了记忆，不证明服务商接收、模型采纳或任务成功；不补算此前记录。仅统计尚保留的任务，同一任务同版本同阶段重复请求合并。</p>
        <button type="button" className="ghost" onClick={()=>setRetry(v=>v+1)}>刷新使用记录</button>
      </>}
      {openError && <p className="hint danger" role="alert">{openError}</p>}
    </div>}
  </section>;
}
