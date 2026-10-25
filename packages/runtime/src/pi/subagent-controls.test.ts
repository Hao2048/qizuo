import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {createHarnessCore,type HarnessCore} from "../core/harness-core.js";
import {createAgent,type CreatedAgent} from "./agent-factory.js";
import {ensureFauxRegistered,fauxModelRef} from "./faux-provider.js";
let core:HarnessCore,agent:CreatedAgent,dir:string;
afterEach(async()=>{await agent?.shutdown();await core?.shutdown();if(dir)rmSync(dir,{recursive:true,force:true});});
it("preserves model-only subagent loader activation while deferring ordinary plugin tools",async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-subagent-controls-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});const ref=fauxModelRef();
 const file=join(dir,"plugin.ts");writeFileSync(file,`export default function(pi){
 for(const name of ['subagents_enable','subagent'])pi.registerTool({name,label:name,description:name,exposure:'direct',defaultActive:false,searchExcluded:true,parameters:{type:'object',properties:{}},execute:async()=>{pi.setActiveTools([...pi.getActiveTools(),'subagent']);return {content:[{type:'text',text:'ready'}],details:{}};}});
 }`);
 agent=await createAgent({taskId:"test",modelRuntime:core.pi.raw,agentDir:core.pi.piDir,cwd:dir,model:core.pi.getModel(ref.provider,ref.modelId)!,systemPrompt:"test",tools:["read"],resolveToolPermission:()=>"allow",requestApproval:async()=>({approved:true}),sessionDir:null,extraExtensionPaths:[file]});
 ensureFauxRegistered().setResponses([ctx=>{expect(JSON.stringify(ctx.messages)).toContain('"name":"subagents_enable"');return fauxAssistantMessage("ready");}]);await agent.session.prompt("work");expect(agent.session.messages.at(-1)).toMatchObject({stopReason:"stop"});
 const loader=agent.session.agent.state.tools.find(t=>t.name==="subagents_enable")!;await loader.execute("enable",{});
 ensureFauxRegistered().setResponses([ctx=>{expect(JSON.stringify(ctx.messages)).toContain('"name":"subagent"');return fauxAssistantMessage("ready");}]);await agent.session.prompt("delegate");expect(agent.session.messages.at(-1)).toMatchObject({stopReason:"stop"});
});
