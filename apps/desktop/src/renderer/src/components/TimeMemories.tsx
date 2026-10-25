import {useEffect,useRef,useState} from 'react';
import type {TimeMemoryInfo,TimeMemoryRule} from '@pi-harness/contracts';
import {invoke,onEvent} from '../api.js';import {useStore} from '../store.js';import {openTask} from '../data.js';
const days=['周日','周一','周二','周三','周四','周五','周六'];
const weekOrder=[1,2,3,4,5,6,0];
const hours=Array.from({length:24},(_,n)=>String(n).padStart(2,'0'));
const minutes=Array.from({length:60},(_,n)=>String(n).padStart(2,'0'));
const statuses:Record<string,string>={scheduled:'等待到点',disabled:'已停用',running:'执行中 / 等待处理',starting:'正在启动',completed:'本次执行结束',missed:'已错过',interrupted:'执行中断',failed:'执行失败'};
function ruleText(rule:TimeMemoryRule){return rule.kind==='once'?new Date(rule.at).toLocaleString():`${rule.kind==='daily'?'每天':rule.weekdays.map(d=>days[d]).join('、')} ${rule.time} · ${rule.timezone}`;}
export default function TimeMemories({roleId}:{roleId:string}){
 const [state,setState]=useState<{roleId:string;items:TimeMemoryInfo[]}>({roleId,items:[]}),[loading,setLoading]=useState(true),[error,setError]=useState(''),[creating,setCreating]=useState(false),[busy,setBusy]=useState(false);
 const query=useStore(s=>s.memoryQuery).trim().toLocaleLowerCase();
 const generation=useRef(0);const items=state.roleId===roleId?state.items.filter(i=>i.roleId===roleId&&(!query||(i.title+' '+i.instructions).toLocaleLowerCase().includes(query))):[];
 const load=async()=>{const version=++generation.current;setLoading(true);try{const result=await invoke('time-memory:list',{roleId});if(version===generation.current){setState({roleId,items:result.items});setError('');}}catch(e){if(version===generation.current)setError(String(e));}finally{if(version===generation.current)setLoading(false);}};
 useEffect(()=>{void load();const off=onEvent(e=>{if(e.type==='time-memory:changed'&&e.payload.roleId===roleId)void load();});const create=()=>setCreating(true);window.addEventListener('pih:new-time-memory',create);return()=>{generation.current++;off();window.removeEventListener('pih:new-time-memory',create);};},[roleId]);
 const act=async(fn:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await fn();await load();}catch(e){setError(String(e));}finally{setBusy(false);}};
 const open=async(taskId:string)=>{try{await openTask(taskId);useStore.getState().setTool('workbench');}catch(e){setError(String(e));}};
 return <section className="time-memories" aria-label="当前角色的时间记忆">
  <div className="time-memory-intro"><div><h2>把行动放到合适的时间</h2><p className="hint">应用运行时到点执行，每次使用这个角色的独立会话和现有权限。错过不自动补跑，同一条时间记忆未结束时不会叠加执行。</p></div><button className="primary" onClick={()=>setCreating(true)}>新增时间记忆</button></div>
  {error&&<p className="hint danger" role="alert">{error}<button className="ghost sm" onClick={()=>void load()}>刷新</button></p>}
  {loading&&!items.length?<p role="status">正在读取时间记忆…</p>:!items.length?<div className="empty-state"><h3>{state.items.length?'没有匹配的时间记忆':'还没有时间记忆'}</h3><p>例如“每天 9:00 整理项目待办”。也可以在和角色的对话中明确指定时间与行动。</p></div>:items.map(item=><article className="time-memory-card" key={item.id}>
   <div className="time-memory-heading"><h3>{item.title}</h3><span className="badge">{statuses[item.status]??item.status}</span><span className="hint">{item.enabled?'已启用':'未启用'}</span></div>
   <p className="time-memory-rule">{ruleText(item.rule)}</p><p className="time-memory-instructions">{item.instructions}</p>
   <p className="hint">{item.nextRun?`下次执行：${new Date(item.nextRun).toLocaleString()}`:'没有后续触发'}{item.projectId?' · 指定项目':' · 个人工作区'}</p>
   {item.lastError&&<p className="hint danger">{item.lastError}</p>}
   <div className="time-memory-actions">
    <button className="ghost sm" disabled={busy} onClick={()=>void act(()=>invoke('time-memory:setEnabled',{id:item.id,roleId,enabled:!item.enabled}))}>{item.enabled?'停用':'启用'}</button>
    <button className="ghost sm" disabled={busy||!!item.activeTaskId||item.status==='starting'} onClick={()=>void act(()=>invoke('time-memory:run',{id:item.id,roleId}))}>{item.status==='missed'||item.status==='interrupted'?'补执行一次':item.rule.kind==='once'?'立即执行本次':'立即执行一次'}</button>
    {(item.activeTaskId||item.lastTaskId)&&<button className="ghost sm" onClick={()=>void open((item.activeTaskId??item.lastTaskId)!)}>查看执行会话</button>}
    <button className="ghost sm danger" disabled={busy||!!item.activeTaskId||item.status==='starting'} onClick={()=>void act(()=>invoke('time-memory:remove',{id:item.id,roleId}))}>移除</button>
   </div>
  </article>)}
  <p className="hint">停用只取消后续触发；正在执行或等待批准的任务，可在执行会话中停止。任务结束不等于交付验收通过。</p>
  {creating&&<NewTimeMemory roleId={roleId} onClose={()=>setCreating(false)} onSaved={()=>{setCreating(false);void load();}}/>}
 </section>;
}
function NewTimeMemory({roleId,onClose,onSaved}:{roleId:string;onClose:()=>void;onSaved:()=>void}){
 const projects=useStore(s=>s.projects);
 const roleName=useStore(s=>s.roles.find(r=>r.id===roleId)?.name??"当前角色");
 const [title,setTitle]=useState(''),[instructions,setInstructions]=useState(''),[kind,setKind]=useState<'once'|'daily'|'weekly'>('once'),[at,setAt]=useState(''),[time,setTime]=useState('09:00'),[weekdays,setWeekdays]=useState([1]),[projectId,setProjectId]=useState(''),[enabled,setEnabled]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const dialog=useRef<HTMLDivElement>(null),returnFocus=useRef(document.activeElement as HTMLElement|null);
 useEffect(()=>()=>{if(returnFocus.current?.isConnected)returnFocus.current.focus();},[]);
 const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 const save=async()=>{setBusy(true);setError('');try{const rule:TimeMemoryRule=kind==='once'?{kind,at:new Date(at).toISOString()}:kind==='daily'?{kind,time,timezone}:{kind,time,timezone,weekdays};await invoke('time-memory:create',{roleId,title,instructions,rule,enabled,...(projectId?{projectId}:{})});onSaved();}catch(e){setError(String(e));}finally{setBusy(false);}};
 return <div className="modal-mask" onClick={busy?undefined:onClose}><div ref={dialog} className="modal time-memory-modal" role="dialog" aria-modal="true" aria-label="新增时间记忆" onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==='Escape'&&!busy)onClose();if(e.key==='Tab'){const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')??[]);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}}>
  <h2>新增时间记忆</h2><p className="hint">为{roleName}安排一次明确的行动 · {timezone}</p>
  <form onSubmit={e=>{e.preventDefault();void save();}}>
   <label>标题<input autoFocus required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/></label>
   <label>到时做什么<textarea required maxLength={16000} rows={4} value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="说明要完成的行动与交付结果"/></label>
   <fieldset className="time-memory-frequency"><legend>执行频率</legend><div className="time-memory-frequency-options">{([['once','单次执行'],['daily','每天执行'],['weekly','每周执行']] as const).map(([value,label])=><label key={value} className={kind===value?'selected':''}><input type="radio" name="time-memory-frequency" value={value} checked={kind===value} onChange={()=>setKind(value)}/>{label}</label>)}</div></fieldset>
   {kind==='once'?<label>执行日期与时间<input type="datetime-local" required value={at} onChange={e=>setAt(e.target.value)}/></label>:<>
    {kind==='weekly'&&<fieldset><legend>每周执行日（可多选）</legend><div className="time-memory-days">{weekOrder.map(index=><label key={index}><input type="checkbox" checked={weekdays.includes(index)} onChange={e=>setWeekdays(e.target.checked?[...weekdays,index].sort():weekdays.filter(d=>d!==index))}/>{days[index]}</label>)}</div></fieldset>}
    <fieldset className="time-memory-clock"><legend>{kind==='daily'?'每天执行时刻':'当天执行时刻'}（24 小时制）</legend><div className="time-memory-clock-inputs"><label>时<select aria-label="执行小时" value={time.slice(0,2)} onChange={e=>setTime(e.target.value+time.slice(2))}>{hours.map(hour=><option key={hour} value={hour}>{hour}</option>)}</select></label><span aria-hidden="true">:</span><label>分<select aria-label="执行分钟" value={time.slice(3)} onChange={e=>setTime(time.slice(0,3)+e.target.value)}>{minutes.map(minute=><option key={minute} value={minute}>{minute}</option>)}</select></label></div></fieldset>
   </>}
   <p className="hint time-memory-schedule-hint">{kind==='once'?'只在所选日期与时间执行一次。':kind==='daily'?`每天 ${time} 执行，不绑定具体日期。`:`${weekOrder.filter(day=>weekdays.includes(day)).map(day=>days[day]).join('、')||'（请选择执行日）'} ${time} 执行，每周重复。`} · {timezone}</p>
   <label>工作项目<select value={projectId} onChange={e=>setProjectId(e.target.value)}><option value="">个人工作区</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
   <label className="time-memory-enabled"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>创建后启用</label>
   {error&&<p role="alert" className="danger">{error}</p>}
   <div className="modal-actions"><button type="button" className="ghost" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||!title.trim()||!instructions.trim()||(kind==='weekly'&&!weekdays.length)}>{busy?'保存中…':'创建时间记忆'}</button></div>
  </form>
 </div></div>;
}
