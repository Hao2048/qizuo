import {useEffect,useRef,useState} from "react";
import type {CompletionReport} from "@pi-harness/contracts";
import {invoke} from "../api.js";
const states:Record<CompletionReport["state"],string>={in_progress:"进行中",needs_attention:"需核对",reply_ended:"回复结束",ready_for_acceptance:"待用户验收",accepted:"已验收"};
const statuses={passed:"通过",pending:"待处理",failed:"未通过",not_applicable:"未自动检查"};
const kinds={execution:"执行记录",artifact:"交付文件",contract:"共同约定",verification:"联调记录",user_confirmation:"人工确认"};
/** Fetch only when viewed. This component has no execution or file-opening capability. */
export default function CompletionEvidence({scope,id,version,onReport}:{scope:CompletionReport["scope"];id:string;version:string|number;onReport?:(value:CompletionReport|null)=>void}):React.ReactElement {
 const [value,setValue]=useState<CompletionReport|null>(null),[error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false);
 const details=useRef<HTMLDetailsElement>(null),sequence=useRef(0),callback=useRef(onReport);callback.current=onReport;
 const evidenceDetails=useRef<HTMLDetailsElement>(null);
 const [selectedEvidence,setSelectedEvidence]=useState<string[]|null>(null);
 async function load(){const current=++sequence.current;setLoading(true);setSelectedEvidence(null);setError(null);try{const result=await invoke("completion:get",{scope,id});if(current!==sequence.current)return;setValue(result);callback.current?.(result);}catch(e){if(current===sequence.current){setError(e instanceof Error?e.message:String(e));setValue(null);callback.current?.(null);}}finally{if(current===sequence.current)setLoading(false);}}
 useEffect(()=>{sequence.current++;setValue(null);setSelectedEvidence(null);setError(null);setLoading(false);callback.current?.(null);return()=>{sequence.current++;};},[scope,id,version]);
 return <details className="completion-evidence" ref={details} onToggle={e=>{if(e.currentTarget.open&&!value&&!loading)void load();}}>
  <summary>完成条件与交付证据{value?` · ${states[value.state]}`:""}</summary>
  <div className="completion-evidence-body">
   <p className="hint">执行结束、文件检查、联调与人工验收分别记录。哈希一致只证明文件对应，不证明业务效果或审美达标。</p>
   <button type="button" className="ghost sm" disabled={loading} onClick={()=>void load()}>{loading?"正在核对…":"刷新证据"}</button>
   {error?<p role="alert">{error}</p>:null}{!value&&!loading&&!error?<p className="hint">请刷新以核对当前记录。任务更新后不会在后台反复扫描文件。</p>:null}
   {value?<><ul aria-label="完成条件">{value.conditions.map(c=><li key={c.id}><strong>{statuses[c.status]}</strong> · {c.label}{c.evidenceIds.length?<button type="button" className="ghost sm" onClick={()=>{setSelectedEvidence(c.evidenceIds);if(evidenceDetails.current)evidenceDetails.current.open=true;window.requestAnimationFrame?.(()=>evidenceDetails.current?.scrollIntoView?.({block:"nearest"}));}}>查看 {c.evidenceIds.length} 项证据</button>:null}</li>)}</ul>
    <details ref={evidenceDetails}><summary>证据明细 · {value.evidence.length} 项</summary>{selectedEvidence?<button type="button" className="ghost sm" onClick={()=>setSelectedEvidence(null)}>显示全部证据</button>:null}<ul aria-label="交付证据">{value.evidence.filter(e=>!selectedEvidence||selectedEvidence.includes(e.id)).map(e=><li key={e.id}>
     <strong>{kinds[e.kind]}</strong> · {e.status==="current"?"当前有效":e.status==="stale"?"已过期 / 需重新核对":"待验证"}<p>{e.summary}</p>
     {e.path?<code>{e.path}</code>:null}{e.hash?<small title={e.hash}> · SHA-256 {e.hash.slice(0,12)}…</small>:null}
     {e.reference?<small> · 记录 {e.reference}</small>:null}
    </li>)}</ul></details>
   </>:null}
  </div>
 </details>;
}
