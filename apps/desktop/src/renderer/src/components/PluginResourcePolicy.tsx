import{useEffect,useState}from'react';
import type{McpServerInfo}from'@pi-harness/contracts';
import{invoke}from'../api.js';
export default function PluginResourcePolicy({server,onSaved}:{server:McpServerInfo;onSaved:()=>void}){
 const[exclusive,setExclusive]=useState(server.exclusive!==false),[group,setGroup]=useState(server.resourceGroup??''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{setExclusive(server.exclusive!==false);setGroup(server.resourceGroup??'');},[server.exclusive,server.resourceGroup]);
 return <details className="plugin-resource-policy"><summary>工作台协作使用</summary>
  <p className="hint">默认排队。角色连续操作期间独占使用，结束后轮到下一个角色。不同插件控制同一台电脑时，填写相同的共享资源名称。</p>
  <label><input type="checkbox" checked={exclusive} disabled={busy} onChange={e=>setExclusive(e.target.checked)}/>排队使用（关闭后允许并行）</label>
  <label>共享资源名称（选填）<input aria-label={`共享资源 ${server.name}`} value={group} maxLength={64} placeholder="例如 computer，留空按插件排队" disabled={busy||!exclusive} onChange={e=>setGroup(e.target.value)}/></label>
  {error&&<p role="alert" className="hint danger">{error}</p>}
  <button type="button" className="ghost" disabled={busy} onClick={async()=>{
   setBusy(true);setError('');try{await invoke('mcp:setResourcePolicy',{name:server.name,exclusive,resourceGroup:group.trim()});onSaved();}catch(error){setError(String(error));}finally{setBusy(false);}
  }}>保存使用方式</button>
 </details>;
}
