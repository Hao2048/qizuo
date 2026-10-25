import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HarnessCore } from "../core/harness-core.js";
import type { McpService } from "../mcp/mcp-service.js";
import { stageInstall, type InstallChange } from "./bundle-install.js";

/** Downloads remain private until resources, declarations and MCP config can all commit. */
export async function installClaudePackage(core:HarnessCore,name:string,signal:AbortSignal):Promise<{ok:boolean;message:string;files:string[]}> {
 let message="";
 try {
  await core.market.installBundle(async work=>{
   let mcpServers=await core.claude.getMcpPlugin(name,signal);
   const hasSkills=!mcpServers || await core.claude.hasPluginSkills(name,signal);
   const finalRoot=join(core.dataDir,"claude-pkg",`claude-${name}`);
   let stagedRoot:string|undefined;
   if(hasSkills)stagedRoot=await stageInstall(signal,child=>core.claude.downloadForPackage(name,join(work,"assets"),child));
   if(mcpServers && JSON.stringify(mcpServers).includes("${CLAUDE_PLUGIN_ROOT}")) {
    stagedRoot ??= await stageInstall(signal,child=>core.claude.downloadPluginAssets(name,join(work,"assets"),child));
    const resolvePaths=(value:unknown):unknown=>typeof value==="string"?value.replaceAll("${CLAUDE_PLUGIN_ROOT}",finalRoot):Array.isArray(value)?value.map(resolvePaths):value && typeof value==="object"?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,resolvePaths(child)])):value;
    mcpServers=resolvePaths(mcpServers) as NonNullable<typeof mcpServers>;
   }
   return ()=>{
    const changes:InstallChange[]=[];
    if(stagedRoot)changes.push({target:`claude-pkg/claude-${name}`,staged:stagedRoot});
    if(hasSkills)changes.push(core.market.prepareSourceDeclaration(finalRoot,join(work,"settings.next")));
    if(mcpServers) {
     const pending:Array<Parameters<McpService["add"]>[0]>=[],added:string[]=[];
     for(const [key,cfg] of Object.entries(mcpServers)) {
      const baseName=key.replace(/[^A-Za-z0-9_-]/g,"-").slice(0,64)||"plugin";
      const collision=core.mcp.list().find(server=>server.name===baseName && server.description!==`来自官方插件 ${name}`);
      const serverName=collision?`claude-${name}-${baseName}`.slice(0,64):baseName;
      if(core.mcp.list().some(server=>server.name===serverName && server.description!==`来自官方插件 ${name}`))throw new Error(`服务器名称冲突: ${serverName}，已有配置未覆盖`);
      const command=typeof cfg.command==="string"?cfg.command:undefined,url=typeof cfg.url==="string"?cfg.url:undefined;
      if(!command && !url)throw new Error(`${key}：无法解析（既无 url 也无 command），未写入服务器配置`);
      pending.push({name:serverName,command,url,args:cfg.args as string[]|undefined,env:cfg.env as Record<string,string>|undefined,headers:cfg.headers as Record<string,string>|undefined,oauth:cfg.oauth as Record<string,unknown>|undefined,description:`来自官方插件 ${name}`});
      added.push(serverName);
     }
     if(!added.length)throw new Error("插件无服务器可接入");
     const staged=join(work,"mcp.next");writeFileSync(staged,core.mcp.prepareUpsertMany(pending),{mode:0o600});
     changes.push({target:`${basename(core.pi.piDir)}/mcp.json`,staged});
     message=`已接入 MCP 服务器：${added.join("、")}（新任务中生效）`;
    }else message=`已以插件安装 ${name}（含技能）`;
    return changes;
   };
  },signal);
  return {ok:true,message,files:[]};
 }catch(error){return {ok:false,message:error instanceof Error?error.message:String(error),files:[]};}
}
