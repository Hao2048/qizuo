import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedGithubAuthUrl, authorizeGithub } from "./github-authorization.js";
import { checkMcpServer } from "./mcp-authorization.js";
vi.mock("./mcp-authorization.js", () => ({ checkMcpServer: vi.fn().mockResolvedValue("ready"), authorizeMcpServer: vi.fn() }));
import { MarketAuthService } from "./auth-service.js";
import { McpService } from "../mcp/mcp-service.js";
import type { MarketService } from "./market-service.js";
const dirs: string[]=[];
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;});
function fixture(fail=false) {
 const dir=mkdtempSync(join(tmpdir(),"pih-github-auth-"));dirs.push(dir);
 const bin=join(dir,"bin");mkdirSync(bin);
 const shared=join(dir,"shared");mkdirSync(shared);vi.stubEnv("GH_CONFIG_DIR",shared);
 vi.mocked(checkMcpServer).mockResolvedValue("ready");
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({login:"fixture-user"}),{status:200})));
 writeFileSync(join(bin,"gh"),`#!/bin/sh
if [ -n "$GH_TOKEN" ] || [ -n "$GITHUB_TOKEN" ]; then exit 9; fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
 printf '%s\\n' '! First copy your one-time code: ABCD-1234' 'Open this URL to continue in your web browser: https://github.com/login/device' 'https://github.com.evil.test/login/device' >&2
 ${fail ? "echo 'private-failure-secret' >&2; exit 1" : 'touch "$GH_CONFIG_DIR/logged-in"; exit 0'}
elif [ "$2" = "token" ]; then
 if [ -f "$GH_CONFIG_DIR/shared-login" ]; then printf '%s' 'shared-private-token'
 elif [ -f "$GH_CONFIG_DIR/logged-in" ]; then printf '%s' 'oauth-private-value'
 else exit 1; fi
else
 exit 0
fi
`,{mode:0o755});
 vi.stubEnv("PATH",`${bin}:/usr/bin:/bin`);vi.stubEnv("GH_TOKEN","old-env-secret");
 const mcp=new McpService(dir);const open=vi.fn();
 mcp.add({name:"github",url:"https://api.githubcopilot.com/mcp/",headers:{Authorization:"Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"},description:"来自官方插件 github"});
 const service=new MarketAuthService({listInstalled:()=>({packages:[]})} as unknown as MarketService,mcp,dir,open);
 return {dir,mcp,open,service};
}
it("accepts only official GitHub browser authorization paths",()=>{
 expect(allowedGithubAuthUrl("https://github.com/login/device")).toBe(true);
 expect(allowedGithubAuthUrl("https://github.com/login/oauth/authorize?client_id=test")).toBe(true);
 for(const url of ["http://github.com/login/device","https://github.com.evil.test/login/device","https://github.com/settings/tokens","https://github.com:444/login/device","https://user:password@github.com/login/device"])expect(allowedGithubAuthUrl(url)).toBe(false);
});
it("GitHub browser login automatically saves credentials for the real MCP config and survives restart",async()=>{
 const {dir,mcp,open,service}=fixture();const source="claude:github";
 expect(service.info(source)).toMatchObject({kind:"oauth",status:"required"});
 service.start(source);
 try {
 await vi.waitFor(()=>expect(service.info(source).status).toBe("ready"),{timeout:5000});
 expect(open).toHaveBeenCalledTimes(1);expect(open).toHaveBeenCalledWith("https://github.com/login/device");
 expect(mcp.list()[0]?.missingVars).toEqual([]);
 expect(JSON.stringify(service.info(source))).not.toContain("oauth-private-value");
 expect(readFileSync(join(dir,"mcp-credentials.json"),"utf8")).toContain("oauth-private-value");
 const restarted=new MarketAuthService({} as MarketService,mcp,dir,open);
 expect(restarted.info(source)).toMatchObject({kind:"oauth",status:"ready"});restarted.dispose();
 } finally {service.dispose();}
});
it("a failed GitHub login does not save credentials or leak CLI output",async()=>{
 const {service,mcp}=fixture(true);service.start("claude:github");
 try {
 await vi.waitFor(()=>expect(service.info("claude:github").status).toBe("error"),{timeout:5000});
 expect(mcp.configuredVars()).toEqual([]);expect(JSON.stringify(service.info("claude:github"))).not.toContain("private-failure-secret");
 } finally {service.dispose();}
});
it("an aborted GitHub attempt never starts browser login",async()=>{
 const {dir,service}=fixture();const controller=new AbortController();controller.abort();
 const authorize=vi.fn();
 await expect(authorizeGithub({agentDir:dir,signal:controller.signal,authorize,progress:()=>{}})).rejects.toThrow();
 expect(authorize).not.toHaveBeenCalled();service.dispose();
});
it("a lookalike endpoint cannot use the GitHub authorization adapter",()=>{
 const {mcp,service}=fixture();
 mcp.add({name:"evil",url:"https://api.githubcopilot.com.evil.test/mcp/",headers:{Authorization:"Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"}});
 expect(mcp.githubCredential("evil")).toBeUndefined();service.dispose();
});
it("switches a bearer placeholder to OAuth only when resource discovery confirms the same service",async()=>{
 const {mcp,service,dir}=fixture();
 mcp.add({name:"notes",url:"https://notes.example/mcp",headers:{Authorization:"Bearer ${NOTES_TOKEN}","X-Version":"1"}});
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>String(url).includes("oauth-authorization-server") ? new Response(JSON.stringify({registration_endpoint:"https://auth.notes.example/register"}),{status:200}) : String(url).includes(".well-known")?new Response(JSON.stringify({resource:"https://notes.example/mcp",authorization_servers:["https://auth.notes.example"]}),{status:200,headers:{"content-type":"application/json"}}):new Response("",{status:401})));
 expect(await mcp.prepareBrowserAuth("notes")).toBe(true);
 expect(mcp.supportsBrowserAuth("notes")).toBe(true);
 const entry=JSON.parse(readFileSync(join(dir,"mcp.json"),"utf8")).mcpServers.notes;
 expect(entry.headers).toEqual({"X-Version":"1"});expect(entry.pihStaticAuthorization).toEqual({Authorization:"Bearer ${NOTES_TOKEN}"});service.dispose();
});
it("failed or hostile OAuth discovery preserves existing token configuration",async()=>{
 const {mcp,service,dir}=fixture();
 mcp.add({name:"notes",url:"https://notes.example/mcp",headers:{Authorization:"Bearer ${NOTES_TOKEN}"}});
 const before=readFileSync(join(dir,"mcp.json"),"utf8");
 vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({resource:"https://evil.example",authorization_servers:["http://auth.notes.example"]}),{status:200})));
 expect(await mcp.prepareBrowserAuth("notes")).toBe(false);
 expect(readFileSync(join(dir,"mcp.json"),"utf8")).toBe(before);service.dispose();
});

it("OAuth without registration or a configured client preserves the manual credential path",async()=>{
 const {mcp,service,dir}=fixture();mcp.add({name:"private",url:"https://private.example/mcp",headers:{Authorization:"Bearer ${PRIVATE_TOKEN}"}});
 const before=readFileSync(join(dir,"mcp.json"),"utf8");
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>new Response(JSON.stringify(String(url).includes("oauth-authorization-server")?{}:{resource:"https://private.example/mcp",authorization_servers:["https://auth.private.example"]}),{status:200})));
 expect(await mcp.prepareBrowserAuth("private")).toBe(false);expect(readFileSync(join(dir,"mcp.json"),"utf8")).toBe(before);service.dispose();
});

it("configures the pinned SDK public metadata registration for CIMD-only services",async()=>{
 const {mcp,service,dir}=fixture();mcp.add({name:"modern",url:"https://modern.example/mcp",headers:{Authorization:"Bearer ${MODERN_TOKEN}"}});
 vi.stubGlobal("fetch",vi.fn(async(url:string)=>new Response(JSON.stringify(String(url).includes("oauth-authorization-server")?{client_id_metadata_document_supported:true,token_endpoint_auth_methods_supported:["none"]}:{resource:"https://modern.example/mcp",authorization_servers:["https://auth.modern.example"]}),{status:200})));
 expect(await mcp.prepareBrowserAuth("modern")).toBe(true);
 expect(JSON.parse(readFileSync(join(dir,"mcp.json"),"utf8")).mcpServers.modern.oauth).toEqual({clientRegistration:"cimd",callbackUrl:"http://127.0.0.1/callback"});service.dispose();
});

it("automatically reuses the shared CLI account after validating actual plugin access",async()=>{
 const {dir,mcp,service,open}=fixture();writeFileSync(join(dir,"shared","shared-login"),"1");
 try {
 expect(await service.refresh("claude:github")).toMatchObject({status:"ready",message:expect.stringContaining("fixture-user")});
 expect(checkMcpServer).toHaveBeenCalledWith("github",dir,"shared-private-token");
 expect(mcp.list()[0]?.missingVars).toEqual([]);expect(open).not.toHaveBeenCalled();
 expect(JSON.stringify(service.info("claude:github"))).not.toContain("shared-private-token");
 } finally {service.dispose();}
});
it("insufficient shared CLI permissions require browser login and validate the new credential",async()=>{
 const {dir,service,open}=fixture();writeFileSync(join(dir,"shared","shared-login"),"1");
 vi.mocked(checkMcpServer).mockImplementation(async(_name,_dir,token)=>token==="shared-private-token"?"required":"ready");
 try {
 expect(await service.refresh("claude:github")).toMatchObject({status:"required"});
 expect(open).not.toHaveBeenCalled();service.start("claude:github");
 await vi.waitFor(()=>expect(service.info("claude:github").status).toBe("ready"),{timeout:5000});expect(open).toHaveBeenCalledTimes(1);
 } finally {service.dispose();}
});
it("network failure preserves existing credentials and does not open another browser login",async()=>{
 const {mcp,service,open}=fixture();mcp.setCredential("GITHUB_PERSONAL_ACCESS_TOKEN","existing-private-token");
 vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("offline-private-diagnostic");}));
 try {
 expect(await service.refresh("claude:github")).toMatchObject({status:"error"});
 service.start("claude:github");await vi.waitFor(()=>expect(service.info("claude:github").status).toBe("error"),{timeout:5000});
 expect(open).not.toHaveBeenCalled();expect(process.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("existing-private-token");
 expect(JSON.stringify(service.info("claude:github"))).not.toContain("private-diagnostic");
 } finally {service.dispose();}
});
it("GitHub login success does not count as plugin-ready when the MCP server still rejects permissions",async()=>{
 const {service,mcp,open}=fixture();vi.mocked(checkMcpServer).mockResolvedValue("required");
 try {
 service.start("claude:github");await vi.waitFor(()=>expect(service.info("claude:github").status).toBe("error"),{timeout:5000});
 expect(mcp.configuredVars()).toEqual([]);expect(open).toHaveBeenCalledTimes(1);
 } finally {service.dispose();}
});
