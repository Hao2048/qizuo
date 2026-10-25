import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHarnessCore,type HarnessCore} from "../core/harness-core.js";
import {createAgent,type CreatedAgent} from "./agent-factory.js";
import {ensureFauxRegistered,fauxModelRef} from "./faux-provider.js";
let dir:string,core:HarnessCore,agent:CreatedAgent;
afterEach(async()=>{await agent?.shutdown();await core?.shutdown();if(dir)rmSync(dir,{recursive:true,force:true});});
it("ordinary conversation does not declare every installed plugin tool",async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-lazy-tools-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});
 const extension=join(dir,"large-plugin.ts");
 writeFileSync(extension,`export default function(pi){for(let i=0;i<80;i++)pi.registerTool({name:'fixture_'+i,label:'fixture',description:'long plugin description '.repeat(200),parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'ok'}],details:{}})});}`);
 const ref=fauxModelRef();agent=await createAgent({taskId:"test",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:core.pi.getModel(ref.provider,ref.modelId)!,systemPrompt:"test",tools:["read"],resolveToolPermission:()=>"allow",requestApproval:async()=>({approved:true}),sessionDir:null,deferExecution:true,extraExtensionPaths:[extension]});
 expect(agent.session.getAllTools().filter(t=>t.name.startsWith("fixture_"))).toHaveLength(80);
 expect(agent.session.agent.state.tools.filter(t=>t.name.startsWith("fixture_"))).toHaveLength(0);
});

it("deferred plugin tools are discoverable and callable, then reset for a new user turn",async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-tool-search-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});
 const extension=join(dir,"search-plugin.ts");
 writeFileSync(extension,`export default function(pi){pi.registerTool({name:'fixture_lookup',label:'fixture',description:'fixture lookup weather',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'lookup result'}],details:{}})});}`);
 const ref=fauxModelRef();agent=await createAgent({taskId:"test",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:core.pi.getModel(ref.provider,ref.modelId)!,systemPrompt:"test",tools:["read"],resolveToolPermission:()=>"allow",requestApproval:async()=>({approved:true}),sessionDir:null,extraExtensionPaths:[extension]});
 agent.session.sessionManager.appendMessage({role:"toolResult",toolCallId:"own-image",toolName:"screenshot",content:[{type:"image",data:"fixture-image",mimeType:"image/png"}],isError:false,timestamp:1});
 const imageReader=agent.session.agent.state.tools.find(tool=>tool.name==="read_tool_image")!;
 expect(await imageReader.execute("image",{toolCallId:"own-image",imageIndex:0})).toMatchObject({content:[{type:"image",data:"fixture-image"}]});
 expect(await imageReader.execute("image",{toolCallId:"other-branch-image",imageIndex:0})).toMatchObject({isError:true});
 const search=agent.session.agent.state.tools.find(tool=>tool.name==="tool_search")!;
 await search.execute("search",{query:"fixture lookup",limit:1});
 expect(agent.session.agent.state.tools.some(tool=>tool.name==="fixture_lookup")).toBe(true);
 const selected=agent.session.agent.state.tools.find(tool=>tool.name==="fixture_lookup")!;
 expect(await selected.execute("lookup",{})).toMatchObject({content:[{text:"lookup result"}]});
 ensureFauxRegistered().setResponses([fauxAssistantMessage("hello")]);await agent.session.prompt("hello");
 expect(agent.session.agent.state.tools.some(tool=>tool.name==="fixture_lookup")).toBe(false);
});
it("unused MCP servers never connect; selecting one keeps discovery deferred",async()=>{
 const {createServer}=await import("node:http");let requests=0;
 const server=createServer((_req,res)=>{requests++;res.writeHead(401);res.end();});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 try {
 dir=mkdtempSync(join(tmpdir(),"pih-lazy-mcp-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});
 core.mcp.add({name:"fixture",url:`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`});
 const ref=fauxModelRef();agent=await createAgent({taskId:"test",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:core.pi.getModel(ref.provider,ref.modelId)!,systemPrompt:"test",tools:["read"],resolveToolPermission:()=>"allow",requestApproval:async()=>({approved:true}),sessionDir:null,enableMcp:true});
 ensureFauxRegistered().setResponses([fauxAssistantMessage("hello")]);await agent.session.prompt("hello");
 await new Promise(resolve=>setTimeout(resolve,100));expect(requests).toBe(0);
 const connect=agent.session.agent.state.tools.find(tool=>tool.name==="harness_connect_mcp")!;
 await connect.execute("list",{});expect(requests).toBe(0);
 await connect.execute("connect",{name:"fixture"});
 await vi.waitFor(()=>expect(requests).toBeGreaterThan(0),{timeout:3000});
 } finally {await agent?.shutdown();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it("the host MCP path excludes the duplicate adapter lifecycle",async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-adapter-exclusion-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});
 const {mkdirSync}=await import("node:fs");const root=join(dir,"pi-mcp-adapter");mkdirSync(root);const path=join(root,"index.ts");
 writeFileSync(path,`export default function(pi){pi.on('session_start',()=>{throw new Error('duplicate MCP startup');});pi.registerTool({name:'adapter_fixture',description:'duplicate',label:'duplicate',parameters:{type:'object',properties:{}},execute:async()=>({content:[],details:{}})});}`);
 const ref=fauxModelRef();agent=await createAgent({taskId:"test",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:core.pi.getModel(ref.provider,ref.modelId)!,systemPrompt:"test",tools:["read"],resolveToolPermission:()=>"allow",requestApproval:async()=>({approved:true}),sessionDir:null,enableMcp:true,extraExtensionPaths:[path]});
 expect(agent.session.getAllTools().some(tool=>tool.name==="adapter_fixture")).toBe(false);
});

it("keeps optional host tool schemas out of ordinary requests, while search can activate them",async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-host-tools-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});const ref=fauxModelRef();
 agent=await createAgent({taskId:"test",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:core.pi.getModel(ref.provider,ref.modelId)!,systemPrompt:"test",tools:["read"],resolveToolPermission:()=>"allow",requestApproval:async()=>({approved:true}),sessionDir:null,saveMemory:async()=>({ok:true,message:"saved"})});
 const optional=["harness_subagent","save_memory"];
 console.info("ordinary declared tools",agent.session.getActiveToolNames());
 expect(agent.session.getActiveToolNames().filter(name=>optional.includes(name))).toEqual([]);
 expect(agent.session.getAllTools().filter(tool=>optional.includes(tool.name))).toHaveLength(2);
 const search=agent.session.agent.state.tools.find(t=>t.name==="tool_search")!;
 for(const name of optional){await search.execute("discover",{query:name,limit:1});expect(agent.session.getActiveToolNames()).toContain(name);}
 ensureFauxRegistered().setResponses([fauxAssistantMessage("hello")]);await agent.session.prompt("hello");
 expect(agent.session.getActiveToolNames().filter(name=>optional.includes(name))).toEqual([]);
});
