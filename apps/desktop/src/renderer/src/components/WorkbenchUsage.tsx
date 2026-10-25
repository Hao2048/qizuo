import { useEffect, useRef, useState } from 'react';
import type { WorkbenchUsage as Usage, WorkbenchCall } from '@pi-harness/contracts';
import { invoke } from '../api.js';

const stages = { routing: '需求判断', planning: '工作规划', execution: '角色执行' };
const duration = (value: number | null | undefined) => value == null ? '—' : (value/1000).toFixed(2)+' 秒';
const number = (value: number | null) => value === null ? '—' : value.toLocaleString();
export function WorkbenchUsage({ id, revision }: { id: string; revision: number }) {
  const [result, setResult] = useState<{id: string; scope: string; data: Usage} | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [selection, setSelection] = useState<{id:string;requestId:string}|null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const scope = selection?.id===id ? selection.requestId : '';
  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    void invoke('workbench:usage', {id,...(scope?{requestId:scope}:{})}).then(data => {
      if (alive) setResult({id, scope, data});
    }).catch(error => { if (alive) setError(String(error)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [id, revision, retry, scope]);
  const rows = result?.id === id && result.scope===scope ? result.data.roles : [];
  return <section className="wb-model-usage" aria-label="角色模型用量">
    <div className="wb-usage-heading"><h3>角色模型用量</h3>
      <button className="ghost" disabled={loading} onClick={()=>setRetry(n=>n+1)}>
        {loading ? '读取中…' : error ? '重试用量读取' : '刷新用量'}
      </button>
    </div>
    <p className="hint">仅读取本任务的本机回执，不调用模型。输入包含缓存读取与写入；缺失字段显示 —。</p>
    <label className="wb-usage-scope">统计范围
      <select aria-label="用量统计轮次" value={scope} onChange={event=>setSelection({id,requestId:event.target.value})}>
        <option value="">全部轮次</option>
        {(result?.id===id ? result.data.rounds??[] : []).map(round=><option key={round.requestId} value={round.requestId}>
          {new Date(round.at).toLocaleString()} · {round.label}
        </option>)}
      </select>
    </label>
    {error && <p role="alert">用量读取失败：{error}</p>}
    {!loading && !error && !rows.length && <p className="hint">暂无已记录的模型调用。旧版本的需求判断与规划用量不补算。</p>}
    {rows.map(row => <div className="wb-usage-row" key={row.roleId+':'+row.stage}>
      <h4>{row.name}<small>{stages[row.stage]}</small></h4>
      <dl className="wb-usage-values">
        <div><dt>已记录调用</dt><dd>{row.calls} 次{row.activeCalls>0 ? ` · ${row.activeCalls} 次进行中` : ''}</dd></div>
        <div><dt>输入 Token</dt><dd>{number(row.inputTokens)}</dd></div>
        <div><dt>输出 Token</dt><dd>{number(row.outputTokens)}</dd></div>
        <div><dt>缓存读取 Token</dt><dd>{number(row.cacheReadTokens)}</dd></div>
        <div><dt>已知费用小计（USD）</dt><dd>{row.costUSD === null ? '—' : '$'+row.costUSD.toFixed(6)}</dd></div>
        <div><dt>最近调用正文首字</dt><dd>{duration(row.lastFirstTextMs)}</dd></div>
        <div><dt>最近调用首响应</dt><dd>{duration(row.lastFirstResponseMs)}</dd></div>
      </dl>
      <p className="hint">用量回执 {row.receiptCalls}/{row.calls} · 缓存回执 {row.cacheReceiptCalls}/{row.calls} · 费用回执 {row.costReceiptCalls}/{row.calls}
        {row.failedCalls>0 ? ` · 调用失败 ${row.failedCalls} 次` : ''}
        {row.interruptedCalls>0 ? ` · 中断 ${row.interruptedCalls} 次` : ''}
        {row.lastDurationMs === null ? '' : ` · 最近调用用时 ${(row.lastDurationMs/1000).toFixed(1)} 秒`}
      </p>
    </div>)}
    <details onToggle={event=>setDetailsOpen(event.currentTarget.open)}>
      <summary>逐次调用与响应耗时</summary>
      {detailsOpen && <CallList key={id+':'+scope+':'+revision+':'+retry} id={id} requestId={scope}/>}
    </details>
    <p className="hint">正文首字：实际发起模型请求至首个非空正文片段；首响应可为思考、工具或正文片段。无流式正文、仅调用工具或旧记录显示 —，不以完整回复耗时补算。费用为回执或 SDK 估算的已知小计；旧执行记录可能缺少失败调用及首字计时。</p>
  </section>;
}

const statuses:Record<string,string>={running:'进行中',completed:'完成',failed:'失败',interrupted:'中断',recorded:'历史回执'};
function CallList({id,requestId}:{id:string;requestId:string}) {
  const [calls,setCalls]=useState<WorkbenchCall[]>([]),[cursor,setCursor]=useState<string|null>(null);
  const [loading,setLoading]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),busy=useRef(false);
  async function load(next?:string) {
    if(busy.current)return;
    const token=generation.current;busy.current=true;setLoading(true);setError('');
    try {
      const result=await invoke('workbench:usageCalls',{id,...(requestId?{requestId}:{}),...(next?{cursor:next}:{})});
      if(token!==generation.current)return;
      setCalls(previous=>next?[...previous,...result.calls]:result.calls);setCursor(result.nextCursor);
    } catch(error) { if(token===generation.current)setError(String(error)); }
    finally { if(token===generation.current){busy.current=false;setLoading(false);} }
  }
  useEffect(()=>{generation.current++;busy.current=false;void load();return()=>{generation.current++;};},[id,requestId]);
  return <div aria-label="逐次模型调用">
    {calls.map(call=><div className="wb-usage-row" key={call.id}>
      <h4>{call.name}<small>{stages[call.stage as keyof typeof stages]??call.stage} · {statuses[call.status]??call.status}</small></h4>
      <p className="hint">{new Date(call.at).toLocaleString()} · {call.provider}/{call.model}</p>
      <dl className="wb-usage-values">
        <div><dt>正文首字</dt><dd>{duration(call.firstTextMs)}</dd></div>
        <div><dt>首响应片段</dt><dd>{duration(call.firstResponseMs)}</dd></div>
        <div><dt>完整调用</dt><dd>{duration(call.durationMs)}</dd></div>
      </dl>
    </div>)}
    {error && <p role="alert">调用记录读取失败：{error}</p>}
    {!calls.length && !loading && !error && <p className="hint">本范围暂无调用记录。</p>}
    {(cursor||error) && <button className="ghost" disabled={loading} onClick={()=>void load(cursor??undefined)}>{error?'重试调用记录':'加载更早调用'}</button>}
    {loading && <p role="status">正在读取调用记录…</p>}
  </div>;
}
