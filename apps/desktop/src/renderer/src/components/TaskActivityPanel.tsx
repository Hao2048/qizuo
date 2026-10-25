import { useEffect, useRef, useState } from "react";
import type { TaskActivity } from "@pi-harness/contracts";
import { formatDuration } from "@pi-harness/shared";
import { invoke, onEvent } from "../api.js";
import { openTask } from "../data.js";
import { useStore } from "../store.js";
import Icon from "./Icon.js";
import CompletionEvidence from "./CompletionEvidence.js";

const labels:Record<TaskActivity["status"],string>={draft:"准备中",running:"运行中",waiting_approval:"待审批",waiting_user:"待回答",waiting_recommend:"待选择",done:"已完成",error:"失败",cancelled:"已停止"};
function label(item:TaskActivity):string {
 if(item.busy && ["accepted","git","resources","mcp","preparing"].includes(item.progress?.stage ?? ""))return "准备中";
 if(item.busy && ["done","error","cancelled"].includes(item.status))return "正在结束";
 if(item.status === "done" && item.completion) return item.completion.outcome === "needs_attention" ? "结束 · 需核对" : "回复结束";
 return item.recovery && !item.busy ? "已中断" : labels[item.status];
}

/** Available on every page; leaving the conversation does not stop its work. */
export default function TaskActivityPanel():React.ReactElement {
 const [items,setItems]=useState<TaskActivity[]>([]),[open,setOpen]=useState(false);
 const [selected,setSelected]=useState<string|null>(null),[detail,setDetail]=useState<string|null>(null);
 const [error,setError]=useState<string|null>(null),[actionError,setActionError]=useState<string|null>(null),[detailError,setDetailError]=useState<string|null>(null);
 const [stopping,setStopping]=useState<string[]>([]),[opening,setOpening]=useState(false);
 const [refresh,setRefresh]=useState(0);
 const root=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null);
 const live=items.filter(item=>item.busy),item=items.find(item=>item.id===selected);
 useEffect(()=>{
  let alive=true,version=0,timer:ReturnType<typeof setTimeout>|undefined;
  const load=async()=>{const current=++version;try{const value=await invoke("task:listActivity",{});if(alive && current===version){setItems(value.items ?? []);setError(null);}}catch(e){if(alive && current===version)setError(e instanceof Error ? e.message : String(e));}};
  void load();
  const unsubscribe=onEvent(event=>{if(["task:progress","task:state","task:agent","task:deleted"].includes(event.type)){clearTimeout(timer);timer=setTimeout(()=>void load(),100);}});
  // A slow fallback also catches creation/deletion or a missed final event.
  const poll=window.setInterval(()=>void load(),open ? 5000 : 15000);
  return ()=>{alive=false;version++;clearTimeout(timer);window.clearInterval(poll);unsubscribe();};
 },[open,refresh]);
 useEffect(()=>{
  if(!open)return;
  root.current?.querySelector<HTMLButtonElement>('[aria-label="关闭任务管理"]')?.focus();
  const dismiss=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
  const escape=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.preventDefault();setOpen(false);button.current?.focus();}};
  document.addEventListener("pointerdown",dismiss);document.addEventListener("keydown",escape);
  return ()=>{document.removeEventListener("pointerdown",dismiss);document.removeEventListener("keydown",escape);};
 },[open]);
 useEffect(()=>{
  if(!open || !selected)return;
  let alive=true;
  setDetail(null);setDetailError(null);
  void invoke("task:activityResult",{taskId:selected}).then(result=>{
   if(!alive)return;
   setDetail(result.text ? result.text + (result.truncated ? "\n…打开会话查看完整回答。" : "") : "暂无已保存的回答，打开会话查看实时进度。");
  }).catch(e=>{if(alive)setDetailError(e instanceof Error ? e.message : String(e));});
  return ()=>{alive=false;};
 },[open,selected,item?.updatedAt,item?.busy,refresh]);
 const close=()=>{setOpen(false);button.current?.focus();};
 const stop=async(id:string)=>{
  setStopping(value=>[...value,id]);setActionError(null);
  try{const result=await invoke("task:abort",{taskId:id});if(!result.ok)setActionError("任务已结束或已不存在运行实例，请刷新查看。");}
  catch(e){setActionError(e instanceof Error ? e.message : String(e));}
  finally{setStopping(value=>value.filter(taskId=>taskId!==id));setRefresh(value=>value+1);}
 };
 return <div className="task-activity" ref={root}>
  <button ref={button} type="button" className="chip-btn" aria-expanded={open} aria-controls="task-activity-dialog" onClick={()=>setOpen(value=>!value)}><Icon name="chart" size={15}/><span>任务{live.length ? ` ${live.length}` : ""}</span></button>
  {open ? <section id="task-activity-dialog" className="activity-popover" role="dialog" aria-label="任务管理">
   <header className="activity-heading"><div><strong>任务管理</strong><p className="hint">{live.length ? `${live.length} 个进行中` : "当前没有运行中的任务"}</p></div><button type="button" className="ghost sm" aria-label="刷新任务" onClick={()=>setRefresh(value=>value+1)}>刷新</button><button type="button" className="icon-button" aria-label="关闭任务管理" onClick={close}><Icon name="close" size={16}/></button></header>
   {error || actionError ? <p className="hint danger" role="alert">{actionError ?? error}</p> : null}
   <div className="activity-scroll">
    {items.length===0 && !error ? <p className="ctx-empty">发送消息后，可在这里查看任务状态与结果。</p> : null}
    {([true,false] as const).map(busy=>{
     const group=items.filter(value=>value.busy===busy);
     return group.length ? <section key={String(busy)} aria-label={busy ? "进行中的任务" : "最近结束的任务"}><h3>{busy ? "进行中" : "最近结束"}</h3>{group.map(value=><div key={value.id} className={`activity-row${selected===value.id ? " selected" : ""}`}>
      <button type="button" className="activity-select" aria-pressed={selected===value.id} onClick={()=>setSelected(value.id)}><span className={`task-dot ${value.status}`}/><span className="activity-title"><strong>{value.title}</strong><small>{value.projectName ?? "个人会话"}</small></span><span className="activity-status">{label(value)}{value.progress ? <small>{formatDuration(value.progress.elapsedMs)}</small> : null}</span></button>
      {value.busy ? <button type="button" className="activity-stop ghost sm" disabled={stopping.includes(value.id)} aria-label={`停止任务 ${value.title}`} onClick={()=>void stop(value.id)}>{stopping.includes(value.id) ? "停止中…" : "停止"}</button> : null}
     </div>)}</section> : null;
    })}
   </div>
   {item ? <section className="activity-result" aria-label="任务详情"><div className="activity-result-head"><strong>{item.title}</strong><button type="button" className="ghost sm" disabled={opening} onClick={async()=>{setOpening(true);try{await openTask(item.id);useStore.getState().setTool("workbench");close();}catch(e){setActionError(e instanceof Error ? e.message : String(e));}finally{setOpening(false);}}}>{opening ? "打开中…" : "打开会话"}</button></div><p className="hint">{item.busy ? "最近保存的回答；完整进度及待处理事项请打开会话。" : "最后保存的回答摘要，完整内容请打开会话。"}</p>{detailError ? <p className="danger" role="alert">{detailError}</p> : <pre>{detail ?? "正在读取结果…"}</pre>}<CompletionEvidence key={`evidence:${item.id}`} scope="chat" id={item.id} version={`${item.updatedAt}:${item.busy}:${item.status}:${item.completion?.checkedAt??""}`}/></section> : null}
   <footer className="hint">可停止正在运行的任务；最近结束保留 20 个会话。</footer>
  </section> : null}
 </div>;
}
