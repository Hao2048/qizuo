import { useEffect, useRef, useState } from "react";
import type { ConversationReference } from "@pi-harness/contracts";
import { invoke } from "../api.js";
import { useStore } from "../store.js";

export function ReferenceTags({ references }: { references?: ConversationReference[] }) {
 if (!references?.length) return null;
 return <div className="att-tags">{references?.map(ref => <details key={ref.id} className="reference-preview">
  <summary className="att-tag">引用 · {ref.title}</summary>
  <small>快照时间 {new Date(ref.capturedAt).toLocaleString()}{ref.omittedMessages ? ` · 已省略 ${ref.omittedMessages} 条早期消息` : ""}{ref.truncated ? " · 正文已截断" : ""}</small>
  <pre>{ref.text}</pre>
 </details>)}</div>;
}
export default function SessionReferences({value,onChange,disabled}:{value:ConversationReference[];onChange:(refs:ConversationReference[])=>void;disabled:boolean}) {
 const tasks=useStore(s=>s.tasks), current=useStore(s=>s.currentTaskId);
 const [open,setOpen]=useState(false),[loading,setLoading]=useState(false);
 const generation=useRef(0);
 useEffect(()=>{generation.current++;setOpen(false);setLoading(false);return()=>{generation.current++;};},[current,disabled]);
 const capture=async(id:string)=>{
  const version=generation.current;setLoading(true);
  try {
   const reference=await invoke("task:captureReference",{sourceTaskId:id});
   if(version===generation.current){onChange([...value,reference]);setOpen(false);}
  }catch(error){if(version===generation.current)useStore.getState().setNotice({level:"error",message:String(error)});}
  finally{if(version===generation.current)setLoading(false);}
 };
 return <div className="session-references">
  <button type="button" className="chip-btn" disabled={disabled || loading || value.length>=3} onClick={()=>setOpen(!open)} aria-expanded={open}>{loading ? "正在引用…" : "引用会话"}</button>
  {value.map(ref=><span className="chip" key={ref.id} title={`引用 ${ref.title}`}>
   {ref.title}<button type="button" aria-label={`移除引用 ${ref.title}`} disabled={disabled} onClick={()=>onChange(value.filter(r=>r.id!==ref.id))}>×</button>
  </span>)}
  {open && !disabled ? <div className="reference-picker" role="dialog" aria-label="选择引用会话">
   <p className="hint">选择最多 3 个会话，引用当前文字快照</p>
   {tasks.filter(t=>t.id!==current&&!value.some(r=>r.sourceTaskId===t.id)).map(t=><button type="button" key={t.id} disabled={loading} onClick={()=>void capture(t.id)}>{t.title}</button>)}
   {!tasks.some(t=>t.id!==current&&!value.some(r=>r.sourceTaskId===t.id)) ? <p className="hint">暂无可引用的会话</p> : null}
  </div> : null}
 </div>;
}
