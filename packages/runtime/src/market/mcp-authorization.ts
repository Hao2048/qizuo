import { dirname, join } from "node:path";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { LoadedMcpConfig, McpExtensionOptions, McpServerEntry } from "@earendil-works/pi-coding-agent";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { sharedPreparation } from "../pi/resource-prewarm.js";

type Options = { cwd: string; agentDir: string; openUrl(url: string): void; log(line: string): void; error(line: string): void };
export type McpAccess = "ready" | "required" | "unavailable";
const sdk = sharedPreparation(async () => {
 const root = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
 const load = (path: string) => import(pathToFileURL(join(root, path)).href);
 const [cli, oauth, storage, config, runtime, defaults] = await Promise.all([load("extensions/mcp/cli.js"), load("extensions/mcp/oauth.js"), load("core/auth-storage.js"), load("extensions/mcp/config.js"), load("extensions/mcp/runtime.js"), load("config.js")]);
 return { ...cli, ...oauth, ...storage, ...config, ...runtime, ...defaults };
});
/** Import support code without reading credentials, connecting servers or opening authorization. */
export async function prewarmMcpSupport(): Promise<void> { await sdk(); }
/** Use the same explicit credential store in the guide, permission probe, and real agent sessions. */
export async function mcpExtensionOptions(agentDir: string, allowShared = true): Promise<McpExtensionOptions> {
 const modules = await sdk();
 const local = new modules.McpOAuthCredentialStore(new modules.FileAuthStorageBackend(join(agentDir, "mcp-auth.json")), agentDir);
 let credentials = local;
 const sharedDir = modules.getAgentDir(); const sharedPath = join(sharedDir, "mcp-auth.json");
 if (allowShared && sharedDir !== agentDir && existsSync(sharedPath)) {
 const shared = new modules.McpOAuthCredentialStore(new modules.FileAuthStorageBackend(sharedPath), sharedDir);
 const configured = modules.loadMcpConfig({ agentDir, cwd: agentDir, projectTrusted: false }) as LoadedMcpConfig;
 const allowed = new Set(configured.servers.filter(entry => "url" in entry.config && !Object.keys(entry.config.headers ?? {}).some(header => header.toLowerCase() === "authorization")).map(entry => `${entry.name}|${new URL((entry.config as {url:string}).url).href}`));
 const select = (name: string, url: string) => {
 try { return !local.tokens(name, url) && allowed.has(`${name}|${new URL(url).href}`) && shared.tokens(name, url) ? shared : local; } catch { return local; }
 };
 // Share the SDK's refresh lock and backing store instead of copying rotating refresh tokens.
 credentials = new Proxy(local, { get(target, property) {
 if (property === "forServer" || property === "tokens") return (name: string, url: string) => select(name, url)[property](name, url);
 const value = target[property]; return typeof value === "function" ? value.bind(target) : value;
 } });
 }
 return {
 credentials,
 loadConfig: ctx => modules.loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }) as LoadedMcpConfig,
 logPath: join(agentDir, "mcp.log"),
 };
}
export async function checkMcpServer(name: string, agentDir: string, token?: string): Promise<McpAccess> {
 return (await probeMcpServer(name, agentDir, token)).state;
}
export async function probeMcpServer(name: string, agentDir: string, token?: string, signal?: AbortSignal): Promise<{state:McpAccess;message:string;toolCount:number|null}> {
 signal?.throwIfAborted();
 const modules = await sdk();
 signal?.throwIfAborted();
 const loaded = modules.loadMcpConfig({ agentDir, cwd: agentDir, projectTrusted: false }) as LoadedMcpConfig;
 const entry = loaded.servers.find(server => server.name === name);
 if (!entry || entry.config.enabled === false) return {state:"unavailable",message:"服务器已移除或停用。",toolCount:null};
 const config = { ...entry.config, timeout: 10 };
 if (token && "url" in config) {
 const headers = { ...config.headers };
 for (const key of Object.keys(headers)) if (key.toLowerCase() === "authorization") delete headers[key];
 headers.Authorization = `Bearer ${token}`; config.headers = headers;
 }
 const extension = await mcpExtensionOptions(agentDir);
 let authRejected = false;
 const createTransport = (...args: unknown[]) => {
 const transport = modules.createDefaultTransport(...args);
 // Preserve structured HTTP status before the SDK wraps transport errors in plain messages.
 return new Proxy(transport, { get(target, property) {
 const value = target[property];
 if (typeof value !== "function") return value;
 if (property !== "send" && property !== "start") return value.bind(target);
 return async (...params: unknown[]) => {
 try { return await value.apply(target, params); }
 catch (error) {
 const status = (error as { status?: number } | null)?.status;
 if (status === 401 || status === 403) authRejected = true;
 throw error;
 }
 };
 } });
 };
 const connection = new modules.McpServerConnection({ entry: { ...entry, config } as McpServerEntry, cwd: agentDir, createTransport,
 credentials: extension.credentials, onTools: () => {},
 });
 const close = () => { void connection.close().catch(() => {}); };
 signal?.addEventListener("abort", close, {once:true});
 try {
 signal?.throwIfAborted();
 await connection.getClient(); signal?.throwIfAborted();
 return {state:"ready",message:"连接及工具列表读取成功。",toolCount:connection.tools.length};
 } catch {
 const required = authRejected || connection.state === "needs-auth" || /\b(?:401|403)\b|unauthoriz|forbidden|insufficient.scope/i.test(connection.error ?? "");
 // Raw transport errors may contain headers, command arguments or secrets.
 return {state:required ? "required" : "unavailable",message:required ? "授权缺失、已失效或访问权限不足，请重新认证。" : "url" in entry.config ? "服务器无法连接或响应超时。请检查网络及服务地址后重试。" : "本地服务启动或握手失败。请检查运行环境、命令和参数后重试。",toolCount:null};
 } finally { signal?.removeEventListener("abort",close); await connection.close(); }
}
/** Pinned SDK reconnects with saved tokens and refreshes them before starting browser sign-in. */
export async function authorizeMcpServer(name: string, options: Options): Promise<number> {
 const modules = await sdk();
 const status = await checkMcpServer(name, options.agentDir);
 if (status === "ready") return 0;
 if (status === "unavailable") { options.error("MCP server is temporarily unavailable"); return 1; }
 // New grants belong to this application, even when the previous shared grant was insufficient.
 const extension = await mcpExtensionOptions(options.agentDir, false);
 return modules.runMcpCommand(["login", name, "--timeout", "300"], { ...options, credentials: extension.credentials });
}

/** On-demand official GLM vision service. Credentials remain in the child environment. */
export async function analyzeZaiImage(agentDir:string,apiKey:string,chinese:boolean,image:import("@earendil-works/pi-ai").ImageContent,prompt:string,signal:AbortSignal):Promise<string> {
 const modules=await sdk();signal.throwIfAborted();
 const extension=await mcpExtensionOptions(agentDir,false);
 const entry={name:"harness-zai-vision",source:"extension",scope:"extension",config:{command:process.platform==="win32" ? "npx.cmd" : "npx",args:["-y","@z_ai/mcp-server@0.1.2"],env:{Z_AI_API_KEY:apiKey,PLATFORM_MODE:chinese ? "ZHIPU" : "ZAI",Z_AI_MODE:chinese ? "ZHIPU" : "ZAI",Z_AI_BASE_URL:chinese ? "https://open.bigmodel.cn/api/paas/v4/" : "https://api.z.ai/api/paas/v4/"},timeout:90}};
 signal.throwIfAborted();
 const suffix=image.mimeType==="image/png" ? ".png" : image.mimeType==="image/jpeg" ? ".jpg" : null;
 if(!suffix)throw new Error("智谱视觉服务支持 PNG/JPEG 图片，请转换格式后重试。");
 const folder=await mkdtemp(join(tmpdir(),"pih-vision-"));
 const connection=new modules.McpServerConnection({entry,cwd:agentDir,createTransport:modules.createDefaultTransport,credentials:extension.credentials,onTools:()=>{}});
 const close=()=>{void connection.close().catch(()=>{});};signal.addEventListener("abort",close,{once:true});
 try {
  const path=join(folder,`image${suffix}`);await writeFile(path,Buffer.from(image.data,"base64"),{mode:0o600});signal.throwIfAborted();
  const result=await connection.callTool("analyze_image",{image_source:path,prompt},{signal});
  signal.throwIfAborted();
  const text=result.content?.filter((item:{type:string})=>item.type==="text").map((item:{text:string})=>item.text).join("\n") ?? "";
  if(result.isError || !text.trim())throw new Error("视觉分析失败，请检查智谱视觉服务额度与连接。");
  return text;
 } catch {if(signal.aborted)throw new Error("视觉分析已取消或超时。");throw new Error("智谱视觉服务无法完成分析，请检查 Node.js/npx、网络及账号视觉服务权限。");}
 finally {signal.removeEventListener("abort",close);await connection.close().catch(()=>{});await rm(folder,{recursive:true,force:true});}
}

/** Workbench bridge: only explicitly granted remote servers; never start a local plugin process. */
export async function callWorkbenchPlugin(agentDir:string,name:string,tool:string|undefined,args:Record<string,unknown>,signal:AbortSignal):Promise<{content:(TextContent|ImageContent)[];details:Record<string,unknown>}>{
 signal.throwIfAborted();const modules=await sdk();const extension=await mcpExtensionOptions(agentDir);
 // Ignore project MCP files: they are editable by model-generated code.
 const loaded=modules.loadMcpConfig({agentDir,cwd:agentDir,projectTrusted:false}) as LoadedMcpConfig;
 const entry=loaded.servers.find(s=>s.name===name && s.config.enabled!==false && "url" in s.config);
 if(!entry || !("url" in entry.config) || !entry.config.url.startsWith("https://"))throw new Error("只允许已授权的 HTTPS 远程 MCP 插件，本地插件进程未开放");
 const connection=new modules.McpServerConnection({entry:{...entry,config:{...entry.config,timeout:30}},cwd:agentDir,createTransport:modules.createDefaultTransport,credentials:extension.credentials,onTools:()=>{}});
 const abort=()=>{void connection.close().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
 try{signal.throwIfAborted();await connection.getClient();signal.throwIfAborted();
 if(!tool)return {content:[{type:"text",text:JSON.stringify(connection.tools.filter((t:{name:string})=>entry.config.toolExposure?.[t.name]!=="hidden" && entry.config.exposure!=="hidden").map((t:{name:string;description?:string;inputSchema:unknown})=>({name:t.name,description:t.description,inputSchema:t.inputSchema}))).slice(0,24000)}],details:{}};
 if(entry.config.exposure==="hidden" || entry.config.toolExposure?.[tool]==="hidden" || !connection.tools.some((t:{name:string})=>t.name===tool))throw new Error("插件工具不存在或不可用");
 const result=await connection.callTool(tool,args,{signal});signal.throwIfAborted();
 if(result.isError)throw new Error("插件返回执行失败");
 const content:(TextContent|ImageContent)[]=[];
 let remaining=24000, imageBytes=0;
 const addText=(text:string)=>{if(remaining>0){content.push({type:"text",text:text.slice(0,remaining)});remaining-=text.length;}};
 for(const item of result.content??[]){
   if(item.type==="text")addText(item.text);
   else if(item.type==="image"){
     imageBytes+=item.data.length;
     if(imageBytes>14_000_000)throw new Error("插件图片结果过大");
     content.push({type:"image",data:item.data,mimeType:item.mimeType});
   }else if(item.type==="resource" && typeof item.resource?.text==="string")addText(item.resource.text);
   else addText(`[插件返回暂不支持的内容类型：${item.type}；未读取外部资源]`);
 }
 if(result.structuredContent!==undefined)addText(JSON.stringify(result.structuredContent));
 if(!content.length)addText("插件执行完成，未返回内容。");
 return {content,details:{}};
 }catch{if(signal.aborted)throw new Error("插件调用已取消");throw new Error("插件调用失败，请检查授权、参数和网络；未自动重试");}
 finally{signal.removeEventListener("abort",abort);await connection.close().catch(()=>{});}
}
