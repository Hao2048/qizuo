import{afterEach,beforeEach,expect,it}from'vitest';
import{mkdtempSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';import{McpService}from'./mcp-service.js';
let dir:string,svc:McpService;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'pih-resource-policy-'));svc=new McpService(dir);svc.add({name:'desktop',url:'https://example.com/mcp'});});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
it('defaults to exclusive and persists shared resource policy across restart and plugin upsert',()=>{
 expect(svc.resourcePolicy('desktop')).toMatchObject({exclusive:true,resourceGroup:'desktop'});
 svc.setResourcePolicy('desktop',true,'computer');svc=new McpService(dir);expect(svc.list()[0]).toMatchObject({exclusive:true,resourceGroup:'computer'});
 svc.upsert({name:'desktop',url:'https://example.com/new'});expect(svc.resourcePolicy('desktop')).toMatchObject({exclusive:true,resourceGroup:'computer'});
 svc.setResourcePolicy('desktop',false,'');expect(svc.resourcePolicy('desktop')).toMatchObject({exclusive:false,resourceGroup:'desktop'});
});
it('rejects missing servers and invalid resource names',()=>{
 expect(()=>svc.setResourcePolicy('missing',true,'computer')).toThrow('不存在');expect(()=>svc.setResourcePolicy('desktop',true,'../outside')).toThrow('无效');
});
it('resource settings remain compatible with the actual SDK MCP configuration loader',async()=>{
 svc.setResourcePolicy('desktop',true,'computer');
 const {mcpExtensionOptions}=await import('../market/mcp-authorization.js');
 const options=await mcpExtensionOptions(dir,false);
 const loaded=options.loadConfig!({cwd:dir,isProjectTrusted:()=>false} as never);
 expect(loaded.errors).toEqual([]);expect(loaded.servers.map(server=>server.name)).toContain('desktop');
});
it('aliases of the same remote endpoint share an exclusive key without exposing URLs or tokens',()=>{
 svc.add({name:'desktop_alias',url:'https://example.com/mcp/?token=do-not-show'});
 const first=svc.resourcePolicy('desktop'),second=svc.resourcePolicy('desktop_alias');
 expect(first.resourceKey).toBe(second.resourceKey);expect(first.resourceKey).not.toContain('example.com');expect(second.resourceKey).not.toContain('do-not-show');
});
