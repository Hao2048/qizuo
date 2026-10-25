import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpDiagnostic } from "@pi-harness/contracts";
import type { McpService } from "./mcp-service.js";
import { probeMcpServer } from "../market/mcp-authorization.js";

/** Explicit, short-lived connection probes; snapshots never start a server. */
export class McpDiagnostics {
 private results = new Map<string, {fingerprint:string;value:McpDiagnostic}>();
 private pending = new Map<string, {config:string;controller:AbortController;promise:Promise<McpDiagnostic>}>();
 private disposed = false;
 constructor(private mcp:McpService, private agentDir:string, private probe = probeMcpServer) {}
 private fingerprint(credentials = true):string {
  const hash = createHash("sha256");
  for (const file of credentials ? ["mcp.json","mcp-auth.json","mcp-credentials.json"] : ["mcp.json"]) {
   try {hash.update(readFileSync(join(this.agentDir,file)));} catch {hash.update(`missing:${file}`);}
  }
  if(credentials) for(const server of this.mcp.list()) for(const variable of server.authVars ?? []) hash.update(`${variable}=${process.env[variable] ?? ""}`);
  return hash.digest("hex");
 }
 list():McpDiagnostic[] {
  const fingerprint = this.fingerprint(), config = this.fingerprint(false);
  const servers = this.mcp.list(), names = new Set(servers.map(server=>server.name));
  for(const name of this.results.keys()) if(!names.has(name)) this.results.delete(name);
  return servers.map(server=>{
   const base = {name:server.name,kind:server.kind,checkedAt:null,toolCount:null};
   if(!server.enabled)return {...base,state:"disabled",message:"已停用，不会接入新会话。"};
   if(this.pending.get(server.name)?.config===config)return {...base,state:"checking",message:"正在连接并读取工具列表…"};
   const cached = this.results.get(server.name);
   if(cached?.fingerprint===fingerprint)return cached.value;
   if(server.missingVars?.length)return {...base,state:"required",message:"所需配置变量尚未提供，请认证或检查服务器配置。"};
   return {...base,state:"unchecked",message:"尚未检测或配置已变化，点击检测连接。"};
  });
 }
 check(name:string):Promise<McpDiagnostic> {
  if(this.disposed)return Promise.reject(new Error("MCP 检测服务已关闭"));
  const current=this.list().find(item=>item.name===name);
  if(!current)return Promise.reject(new Error("MCP 服务器不存在"));
  if(current.state==="disabled")return Promise.resolve(current);
  const config=this.fingerprint(false), previous=this.pending.get(name);
  if(previous?.config===config)return previous.promise;
  previous?.controller.abort();
  if(this.pending.size>=4 && !previous)return Promise.reject(new Error("正在检测的服务器较多，请稍后重试"));
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15_000);timer.unref?.();
  let rejectAbort!:(error:Error)=>void;
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const onAbort=()=>rejectAbort(new Error("MCP 检测取消或超时"));
  controller.signal.addEventListener("abort",onAbort,{once:true});
  const promise=Promise.race([Promise.resolve().then(()=>this.probe(name,this.agentDir,undefined,controller.signal)),aborted]).then(result=>{
   if(this.disposed || this.fingerprint(false)!==config || controller.signal.aborted)return {...current,state:"unchecked" as const,message:"检测已取消、超时或配置已变化，请重新检测。",checkedAt:null,toolCount:null};
   const value:McpDiagnostic={...current,...result,checkedAt:Date.now()};
   this.results.set(name,{fingerprint:this.fingerprint(),value});return value;
  }).catch(()=>{
   const value:McpDiagnostic={...current,state:"unavailable",message:"检测失败或超时，请检查配置与网络后重试。",checkedAt:Date.now(),toolCount:null};
   if(!this.disposed && this.fingerprint(false)===config && this.pending.get(name)?.controller===controller)this.results.set(name,{fingerprint:this.fingerprint(),value});
   return value;
  }).finally(()=>{clearTimeout(timer);controller.signal.removeEventListener("abort",onAbort);if(this.pending.get(name)?.controller===controller)this.pending.delete(name);});
  this.pending.set(name,{config,controller,promise});return promise;
 }
 dispose():void {this.disposed=true;for(const pending of this.pending.values())pending.controller.abort();this.results.clear();}
 async shutdown():Promise<void> {this.dispose();await Promise.allSettled([...this.pending.values()].map(item=>item.promise));}
}
