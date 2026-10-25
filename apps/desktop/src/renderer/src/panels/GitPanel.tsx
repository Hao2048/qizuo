import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GitStatus, GitDiff, GitAction } from "@pi-harness/contracts";
import { invoke, onEvent } from "../api.js";
import { useStore } from "../store.js";

export default function GitPanel(): React.ReactElement | null {
 const taskId=useStore(s=>s.currentTaskId), taskStatus=useStore(s=>s.taskStatus);
 const [open,setOpen]=useState(false), [state,setState]=useState<GitStatus|null>(null), [error,setError]=useState<string|null>(null);
 const [selected,setSelected]=useState<string[]>([]), [file,setFile]=useState<string|null>(null), [scope,setScope]=useState<"all"|"working"|"staged">("all");
 const [diff,setDiff]=useState<GitDiff|null>(null), [commit,setCommit]=useState<string|null>(null);
 const [busy,setBusy]=useState(false), [loading,setLoading]=useState(false), [confirm,setConfirm]=useState(false);
 const [message,setMessage]=useState(""), [branch,setBranch]=useState(""), [chosenBranch,setChosenBranch]=useState("");
 const button=useRef<HTMLButtonElement>(null), refreshVersion=useRef(0);
 const running=["running","waiting_approval","waiting_user","waiting_recommend"].includes(taskStatus??"");
 useEffect(()=>{
 let cancelled=false, timer:ReturnType<typeof setTimeout>|undefined;
 setState(null); setSelected([]); setFile(null); setDiff(null); setCommit(null); setConfirm(false); setError(null); setMessage(""); setBranch(""); setChosenBranch("");
 if(!taskId) return;
 const refresh=async()=>{
 const version=++refreshVersion.current;
 try { const next=await invoke("git:status",{taskId}); if(!cancelled&&version===refreshVersion.current) {
 setState(next); setConfirm(false); setSelected(old=>old.filter(p=>next.files.some(f=>f.path===p)));
 setFile(old=>next.files.some(f=>f.path===old)?old:next.files[0]?.path??null);
 }} catch(e) { if(!cancelled) setError(String(e)); }
 };
 void refresh();
 const unsubscribe=onEvent(event=>{
 if((event.type==="git:changed"||event.type==="task:state"||event.type==="task:stream")&&event.payload.taskId===taskId) {
 if(event.type==="task:stream"&&event.payload.kind!=="tool_execution_end") return;
 clearTimeout(timer); timer=setTimeout(()=>void refresh(),300);
 }
 });
 return()=>{cancelled=true;clearTimeout(timer);unsubscribe();++refreshVersion.current;};
 },[taskId]);
 useEffect(()=>{ if(!open) return; const close=(e:KeyboardEvent)=>{if(e.key==="Escape"){setOpen(false);button.current?.focus();}}; window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close);},[open]);
 const paths=selected.length?selected:file?[file]:[];
 const pathKey=JSON.stringify(paths);
 useEffect(()=>{
 let cancelled=false; setDiff(null);
 if(!open||!taskId||!state?.repository||(!paths.length&&!commit)) return;
 setLoading(true);
 void invoke("git:diff",{taskId,paths:commit?[]:paths,scope,commit:commit??undefined}).then(next=>{if(!cancelled)setDiff(next);}).catch(e=>{if(!cancelled)setError(String(e));}).finally(()=>{if(!cancelled)setLoading(false);});
 return()=>{cancelled=true;};
 },[open,taskId,pathKey,scope,commit,state?.head,state?.files]);
 if(!taskId) return null;
 const mutate=async(action:GitAction["action"])=>{
 if(busy||running||!taskId)return;
 const activeTask=taskId;setBusy(true);setError(null);
 try {
 const next=await invoke("git:mutate",{taskId,action,paths:selected,version:diff?.version,message,branch:action==="switch_branch"?chosenBranch:branch});
 if(useStore.getState().currentTaskId!==activeTask) return;
 ++refreshVersion.current;setState(next);setSelected([]);setFile(next.files[0]?.path??null);setCommit(null);setConfirm(false);setMessage("");
 } catch(e){if(useStore.getState().currentTaskId===activeTask)setError(e instanceof Error?e.message:String(e));}
 finally {setBusy(false);}
 };
 const canEdit=!!selected.length&&!!diff&&!loading&&!busy&&!running&&!commit;
 return <>
 <button ref={button} type="button" className="chip-btn" aria-expanded={open} onClick={()=>setOpen(v=>!v)} title="查看项目差异、提交与管理 Git 分支">Git{state?.branch?` · ${state.branch}`:""}{state?.files.length?` · ${state.files.length}`:""}</button>
 {open&&createPortal(<aside className="git-review" aria-label="Git 项目版本">
 <header className="git-review-head"><div><h2>项目版本</h2><span className="hint">{state?.branch??(state?.head?"分离的 HEAD":"本机 Git")}</span></div><button type="button" className="ghost sm" aria-label="关闭项目版本" onClick={()=>{setOpen(false);button.current?.focus();}}>关闭</button></header>
 {error&&<p role="alert" className="hint bad">{error}</p>}
 {!state?<p role="status" className="hint">正在检测本机 Git…</p>:!state.repository?<div className="git-empty"><p>{state.message}</p>{state.available&&state.message?.includes("初始化")&&<button type="button" className="primary" disabled={busy||running} onClick={()=>void mutate("init")}>初始化项目 Git</button>}</div>:<>
 <div className="git-branches"><label>本地分支<select aria-label="本地分支" value={chosenBranch} onChange={e=>setChosenBranch(e.target.value)}><option value="">选择分支</option>{state.branches.map(b=><option key={b}>{b}</option>)}</select></label><button type="button" className="ghost sm" disabled={busy||running||!chosenBranch||chosenBranch===state.branch} onClick={()=>void mutate("switch_branch")}>切换分支</button><input aria-label="新分支名称" placeholder="新分支名称" value={branch} onChange={e=>setBranch(e.target.value)}/><button type="button" className="ghost sm" disabled={busy||running||!branch} onClick={()=>void mutate("create_branch")}>创建分支</button></div>
 <div className="git-scope" role="group" aria-label="差异范围">{(["all","working","staged"] as const).map((value,i)=><button type="button" key={value} aria-pressed={scope===value&&!commit} className={scope===value&&!commit?"primary sm":"ghost sm"} onClick={()=>{setScope(value);setCommit(null);}}>{["全部未提交","未暂存","已暂存"][i]}</button>)}</div>
 <p className="hint git-explain">显示项目当前修改，包含你和其他任务的未提交内容。选择文件后可暂存、提交或撤销。</p>
 {running&&<p className="hint" role="status">任务执行中可查看差异；结束后可操作版本。</p>}
 <div className="git-files">{state.files.length?state.files.map(f=><div className={`git-file${file===f.path&&!commit?" active":""}`} key={f.path}><input type="checkbox" aria-label={`选择 ${f.path}`} checked={selected.includes(f.path)} disabled={busy} onChange={e=>{setConfirm(false);setSelected(old=>e.target.checked?[...old,f.path]:old.filter(p=>p!==f.path));setCommit(null);}}/><button type="button" className="git-file-name" onClick={()=>{setSelected([]);setFile(f.path);setCommit(null);setError(null);}} title={f.path}>{f.path}</button><code title={f.conflicted?"合并冲突":"Git 文件状态"}>{f.status}</code></div>):<p className="hint">工作区没有待提交修改。</p>}</div>
 <div className="git-actions"><button type="button" className="ghost sm" disabled={!canEdit} onClick={()=>void mutate("stage")}>暂存选中</button><button type="button" className="ghost sm" disabled={!canEdit} onClick={()=>void mutate("unstage")}>取消暂存</button><button type="button" className="ghost sm danger-text" disabled={!canEdit} onClick={()=>{setScope("all");setConfirm(true);}}>撤销选中修改</button></div>
 {confirm&&<div className="git-confirm" role="group" aria-label="确认撤销"><p>选中文件将恢复至最近提交，包含已暂存修改；未跟踪的新文件将被删除。</p><button type="button" className="ghost sm" onClick={()=>setConfirm(false)}>取消</button><button type="button" className="danger sm" disabled={!canEdit} onClick={()=>void mutate("discard")}>确认撤销</button></div>}
 <div className="git-commit"><input aria-label="提交说明" placeholder="提交说明" value={message} maxLength={1000} onChange={e=>setMessage(e.target.value)}/><button type="button" className="primary sm" disabled={!canEdit||!message.trim()} onClick={()=>void mutate("commit")}>{busy?"处理中…":`提交选中${selected.length?` (${selected.length})`:""}`}</button></div>
 <div className="git-diff" aria-label="文件差异" aria-busy={loading}>{loading?<p role="status">正在加载差异…</p>:diff?<><pre>{diff.text?diff.text.split("\n").map((line,index)=><span className={line.startsWith("+")?"git-added":line.startsWith("-")?"git-removed":""} key={index}>{line}{"\n"}</span>):"此范围没有差异。"}</pre>{diff.truncated&&<p className="hint">差异较大，已截断显示，请在编辑器中查看完整文件。</p>}</>:<p className="hint">选择一个文件查看差异。</p>}</div>
 <details className="git-history"><summary>最近提交 · {state.commits.length}</summary>{state.commits.map(c=><button type="button" className="git-history-row" key={c.id} onClick={()=>{setCommit(c.id);setSelected([]);}}><code>{c.id.slice(0,7)}</code><span>{c.message}</span></button>)}</details>
 </>}
 </aside>,document.body)}
 </>;
}
