import PluginResourcePolicy from "./PluginResourcePolicy.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { McpDiagnostic, McpServerInfo } from "@pi-harness/contracts";
import { invoke } from "../api.js";
import { PluginAuthModal } from "./PluginAuthModal.js";

const labels:Record<McpDiagnostic["state"],string>={unchecked:"未检测",checking:"检测中",ready:"可连接",required:"需要认证",unavailable:"连接失败",disabled:"已停用"};
export default function McpStatusPanel({revision}:{revision?:unknown}):React.ReactElement {
 const [items,setItems]=useState<McpDiagnostic[]>([]),[servers,setServers]=useState<McpServerInfo[]>([]);
 const [error,setError]=useState<string|null>(null),[source,setSource]=useState<string|null>(null);
 const [busy,setBusy]=useState<Set<string>>(new Set());
 const alive=useRef(false),sequence=useRef(0);
 const refresh=useCallback(async()=>{
  const generation=++sequence.current;
  try {
   const [status,config]=await Promise.all([invoke("mcp:diagnostics",{}),invoke("mcp:list",{})]);
   if(alive.current && sequence.current===generation){setItems(status.items);setServers(config.servers);}
  } catch {if(alive.current && sequence.current===generation)setError("状态读取失败，请刷新重试。");}
 },[]);
 useEffect(()=>{
  alive.current=true;void refresh();const timer=setInterval(()=>void refresh(),5000);
  return()=>{alive.current=false;sequence.current++;clearInterval(timer);};
 },[refresh,revision]);
 const check=async(name:string)=>{
  setError(null);setBusy(previous=>new Set(previous).add(name));
  try {await invoke("mcp:check",{name});}
  catch {if(alive.current)setError("检测未完成，请稍后重试。");}
  finally {if(alive.current){setBusy(previous=>{const next=new Set(previous);next.delete(name);return next;});void refresh();}}
 };
 return <div className="mcp-status-panel" aria-label="MCP 连接状态">
  <div className="mcp-status-heading"><div><h2>连接状态</h2><p className="hint">检测只建立连接并读取工具列表。结果为最近一次独立检测，不代表当前会话的实时连接。</p></div><button type="button" className="ghost" onClick={()=>{setError(null);void refresh();}}>刷新状态</button></div>
  {error ? <p role="alert" className="hint bad">{error}</p>:null}
  {items.length===0 ? <p className="hint">添加 MCP 服务器后，可在这里检测连接并处理认证。</p>:null}
  <div className="mcp-status-list">{items.map(item=>{
   const server=servers.find(server=>server.name===item.name);
   const working=busy.has(item.name)||item.state==="checking";
   return <article className="mcp-status-row" key={item.name}>
    <div className="mcp-status-main"><div className="mcp-status-title"><strong>{item.name}</strong><span className={`mcp-state ${item.state}`} role="status">{working ? "检测中":labels[item.state]}</span></div>
    <p>{working ? "正在连接并读取工具列表…":item.message}</p>
    <div className="mcp-status-meta">{item.kind==="stdio" ? "本地进程":"远程服务"}{item.toolCount!==null ? ` · ${item.toolCount} 个工具`:""}{item.checkedAt ? ` · ${new Date(item.checkedAt).toLocaleTimeString()} 检测`:""}</div>{server?.kind==="http"?<PluginResourcePolicy server={server} onSaved={()=>void refresh()}/>:null}</div>
    <div className="bar-actions"><button type="button" className="ghost" aria-label={`检测连接 ${item.name}`} disabled={working||item.state==="disabled"} onClick={()=>void check(item.name)}>{working ? "检测中…":"检测连接"}</button>
    {item.state!=="disabled" && server ? <button type="button" className="ghost" disabled={working} aria-label={`认证 ${item.name}`} onClick={()=>{const match=server.description?.match(/^来自官方插件 (.+)$/);setSource(match ? `claude:${match[1]}`:server.name);}}>认证</button>:null}</div>
   </article>;
  })}</div>
  {source ? <PluginAuthModal key={source} source={source} onDone={()=>{setSource(null);void refresh();}}/>:null}
 </div>;
}
