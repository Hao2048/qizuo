import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeMcpServer } from "./mcp-authorization.js";

it("prewarming executes no server and keeps later configuration and credentials fresh", async () => {
 const { readdirSync, writeFileSync } = await import("node:fs");
 const { prewarmMcpSupport, mcpExtensionOptions } = await import("./mcp-authorization.js");
 const dir = mkdtempSync(join(tmpdir(), "pih-mcp-warm-"));
 try {
 await Promise.all([prewarmMcpSupport(), prewarmMcpSupport()]);
 expect(readdirSync(dir)).toEqual([]);
 writeFileSync(join(dir,"mcp.json"), JSON.stringify({mcpServers:{fresh:{url:"https://fresh.example/mcp"}}}));
 const first = await mcpExtensionOptions(dir, false);
 expect(first.loadConfig!({cwd:dir,isProjectTrusted:()=>false} as never).servers.map(server=>server.name)).toEqual(["fresh"]);
 first.credentials!.forServer("fresh", "https://fresh.example/mcp").save({serverUrl:"https://fresh.example/mcp",tokens:{access_token:"first-fixture",token_type:"Bearer"}});
 const second = await mcpExtensionOptions(dir, false);
 expect(second.credentials).not.toBe(first.credentials);
 second.credentials!.forServer("fresh", "https://fresh.example/mcp").save({serverUrl:"https://fresh.example/mcp",tokens:{access_token:"new-fixture",token_type:"Bearer"}});
 expect((await first.credentials!.forServer("fresh", "https://fresh.example/mcp").load())?.tokens?.access_token).toBe("new-fixture");
 writeFileSync(join(dir,"mcp.json"), JSON.stringify({mcpServers:{changed:{url:"https://changed.example/mcp"}}}));
 expect(first.loadConfig!({cwd:dir,isProjectTrusted:()=>false} as never).servers.map(server=>server.name)).toEqual(["changed"]);
 } finally { rmSync(dir, {recursive:true, force:true}); }
});

it("loads the real pinned ESM-only SDK command and handles unknown servers without opening a browser", async () => {
 const dir=mkdtempSync(join(tmpdir(),"pih-mcp-sdk-"));
 const openUrl=vi.fn(); const error=vi.fn();
 try {
 const code=await authorizeMcpServer("not-installed",{cwd:dir,agentDir:dir,openUrl,log:()=>{},error});
 expect(code).toBe(1); expect(error).toHaveBeenCalled(); expect(openUrl).not.toHaveBeenCalled();
 } finally { rmSync(dir,{recursive:true,force:true}); }
});

it("real SDK probes initialization and tool listing, distinguishing auth rejection from outages",async()=>{
 const { createServer }=await import("node:http");
 const { writeFileSync }=await import("node:fs");
 const { checkMcpServer, probeMcpServer }=await import("./mcp-authorization.js");
 const dir=mkdtempSync(join(tmpdir(),"pih-mcp-probe-"));let mode=200;let toolLists=0;
 const server=createServer((req,res)=>{
 if(mode!==200){res.writeHead(mode,{"content-type":"application/json"});res.end(JSON.stringify({error:"blocked"}));return;}
 if(req.method==="DELETE"){res.writeHead(200);res.end();return;}
 let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{
 const rpc=JSON.parse(body || "{}");
 if(rpc.id===undefined){res.writeHead(202);res.end();return;}
 if(req.headers.authorization!=="Bearer fixture-token"){res.writeHead(401);res.end();return;}
 const result=rpc.method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}:{tools:[{name:"fixture_tool",inputSchema:{type:"object",properties:{}}}]};
 if(rpc.method==="tools/list")toolLists++;
 res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result}));
 });
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address() as {port:number};
 writeFileSync(join(dir,"mcp.json"),JSON.stringify({mcpServers:{fixture:{url:`http://127.0.0.1:${address.port}/mcp`,headers:{Authorization:"Bearer ${MISSING_FIXTURE_TOKEN}"}}}}));
 try {
 expect(await probeMcpServer("fixture",dir,"fixture-token")).toMatchObject({state:"ready",toolCount:1});expect(toolLists).toBeGreaterThan(0);
 mode=401;expect(await checkMcpServer("fixture",dir,"fixture-token")).toBe("required");
 mode=503;expect(await checkMcpServer("fixture",dir,"fixture-token")).toBe("unavailable");
 } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

it("reuses only matching shared Pi OAuth state through the shared store and refresh lock",async()=>{
 const {mkdirSync,writeFileSync,readFileSync}=await import("node:fs");
 const {mcpExtensionOptions}=await import("./mcp-authorization.js");
 const dir=mkdtempSync(join(tmpdir(),"pih-mcp-shared-"));const shared=join(dir,"shared");const own=join(dir,"own");mkdirSync(shared);mkdirSync(own);
 vi.stubEnv("PI_CODING_AGENT_DIR",shared);
 const url="https://matching.example/mcp";const key=`mcp__matching|${url}`;
 writeFileSync(join(shared,"mcp-auth.json"),JSON.stringify({[key]:{tokens:{access_token:"shared-fixture-token"}},"mcp__unrelated|https://other.example/mcp":{tokens:{access_token:"unrelated-private-token"}}}));
 writeFileSync(join(own,"mcp.json"),JSON.stringify({mcpServers:{matching:{url}}}));
 try {
 const options=await mcpExtensionOptions(own);const credentials=options.credentials!;
 expect((await credentials.forServer("matching",url).load())?.tokens?.access_token).toBe("shared-fixture-token");
 expect(await credentials.forServer("unrelated","https://other.example/mcp").load()).toBeUndefined();
 credentials.forServer("matching",url).save({serverUrl:url,tokens:{access_token:"refreshed-fixture-token",token_type:"Bearer"}});
 expect(JSON.parse(readFileSync(join(shared,"mcp-auth.json"),"utf8"))[key].tokens.access_token).toBe("refreshed-fixture-token");
 expect(readFileSync(join(own,"mcp-auth.json"),"utf8")).not.toContain("shared-fixture-token");
 const local=await mcpExtensionOptions(own,false);local.credentials!.forServer("matching",url).save({serverUrl:url,tokens:{access_token:"own-new-grant",token_type:"Bearer"}});
 expect((await credentials.forServer("matching",url).load())?.tokens?.access_token).toBe("own-new-grant");
 expect(JSON.parse(readFileSync(join(shared,"mcp-auth.json"),"utf8"))[key].tokens.access_token).toBe("refreshed-fixture-token");
 } finally {vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});}
});

it("real agent MCP options load the harness config and exclude untrusted project overrides",async()=>{
 const {mkdirSync,writeFileSync}=await import("node:fs");const {mcpExtensionOptions}=await import("./mcp-authorization.js");
 const dir=mkdtempSync(join(tmpdir(),"pih-mcp-config-"));const project=join(dir,"project");mkdirSync(join(project,".pi"),{recursive:true});
 writeFileSync(join(dir,"mcp.json"),JSON.stringify({mcpServers:{harness:{url:"https://harness.example/mcp"}}}));
 writeFileSync(join(project,".pi","mcp.json"),JSON.stringify({mcpServers:{untrusted:{url:"https://untrusted.example/mcp"}}}));
 try {const options=await mcpExtensionOptions(dir,false);const ctx={cwd:project,isProjectTrusted:()=>false} as Parameters<NonNullable<typeof options.loadConfig>>[0];
 expect(options.loadConfig!(ctx).servers.map(entry=>entry.name)).toEqual(["harness"]);expect(options.logPath).toBe(join(dir,"mcp.log"));
 } finally {rmSync(dir,{recursive:true,force:true});}
});

it("workbench remote bridge keeps credentials host-side and rejects local, hidden and disabled plugins",async()=>{
 const {writeFileSync}=await import("node:fs");const {callWorkbenchPlugin}=await import("./mcp-authorization.js");
 const dir=mkdtempSync(join(tmpdir(),"pih-wb-mcp-"));const calls:string[]=[];let token="";let output:Record<string,unknown>={content:[{type:"text",text:"remote result"}]};
 vi.stubGlobal("fetch",async(url:string|Request|URL,init?:RequestInit)=>{
  const req=url instanceof Request?url:new Request(url,init);token=req.headers.get("Authorization")??"";
  if(req.method==="GET")return new Response("",{status:405});
  if(req.method==="DELETE")return new Response("",{status:200});
  const rpc=JSON.parse(await req.text()||"{}");if(rpc.id===undefined)return new Response(null,{status:202});calls.push(rpc.method);
  const result=rpc.method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}:rpc.method==="tools/list"?{tools:[{name:"safe",description:"Fixture",inputSchema:{type:"object",properties:{}}},{name:"secret",inputSchema:{type:"object"}}]}:output;
  return new Response(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result}),{headers:{"content-type":"application/json"}});
 });
 writeFileSync(join(dir,"mcp.json"),JSON.stringify({mcpServers:{remote:{url:"https://fixture.example/mcp",headers:{Authorization:"Bearer host-fixture-token"},toolExposure:{secret:"hidden"}},local:{command:"touch",args:[join(dir,"must-not-exist")]},disabled:{url:"https://fixture.example/mcp",enabled:false}}}));
 try{
  const signal=new AbortController().signal;
  const list=await callWorkbenchPlugin(dir,"remote",undefined,{},signal);expect(JSON.stringify(list)).toContain("safe");expect(JSON.stringify(list)).not.toContain("secret");expect(JSON.stringify(list)).not.toContain("host-fixture-token");
  expect(await callWorkbenchPlugin(dir,"remote","safe",{},signal)).toMatchObject({content:[{type:"text",text:"remote result"}]});expect(token).toBe("Bearer host-fixture-token");expect(calls.filter(c=>c==="tools/call")).toHaveLength(1);
  await expect(callWorkbenchPlugin(dir,"remote","secret",{},signal)).rejects.toThrow();expect(calls.filter(c=>c==="tools/call")).toHaveLength(1);
  output={content:[{type:"image",data:"aW1hZ2U=",mimeType:"image/png"}],structuredContent:{count:2}};
  const image=await callWorkbenchPlugin(dir,"remote","safe",{},signal);
  expect(image.content).toContainEqual({type:"image",data:"aW1hZ2U=",mimeType:"image/png"});
  expect(image.content).toContainEqual({type:'text',text:'{"count":2}'});
  output={content:[{type:"resource",resource:{uri:"fixture://report",mimeType:"text/plain",text:"embedded report"}}]};
  expect(JSON.stringify(await callWorkbenchPlugin(dir,"remote","safe",{},signal))).toContain("embedded report");
  output={content:[{type:"audio",data:"aW1hZ2U=",mimeType:"audio/wav"}]};
  expect(JSON.stringify(await callWorkbenchPlugin(dir,"remote","safe",{},signal))).toContain("暂不支持");
  await expect(callWorkbenchPlugin(dir,"local",undefined,{},signal)).rejects.toThrow("HTTPS");await expect(callWorkbenchPlugin(dir,"disabled",undefined,{},signal)).rejects.toThrow("HTTPS");
 }finally{vi.unstubAllGlobals();rmSync(dir,{recursive:true,force:true});}
});
