import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AnyAppEvent } from "@pi-harness/contracts";
import { createHarnessCore, type HarnessCore } from "./core/harness-core.js";
import { ensureFauxRegistered, fauxModelRef } from "./pi/faux-provider.js";
let core:HarnessCore,dir:string,events:AnyAppEvent[];
async function invoke(name:string,input:unknown):Promise<any>{const result=await core.router.invoke(name,input);if(!result.ok)throw new Error(result.error.message);return result.result;}
async function settled(taskId:string){const deadline=Date.now()+3000;while(!events.some(e=>e.type==="task:state"&&e.payload.taskId===taskId&&e.payload.status==="done")){if(Date.now()>deadline)throw new Error("not settled");await new Promise(r=>setTimeout(r,10));}}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-send-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});events=[];core.router.onEvent(e=>events.push(e as AnyAppEvent));await invoke("settings:set",{defaultModel:fauxModelRef(),autoApproveTools:["read","grep","find","ls"]});});
afterEach(()=>{core.dispose();rmSync(dir,{recursive:true,force:true});});
it("retains one timing record across sends and removes it when the conversation is deleted",async()=>{
 const task=await invoke("task:create",{title:"timing"});
 ensureFauxRegistered().setResponses([fauxAssistantMessage("ready")]);await invoke("task:prompt",{taskId:task.id,text:"hello"});await settled(task.id);
 expect((await invoke("task:get",{taskId:task.id})).progress).toMatchObject({taskId:task.id,stage:"complete"});
 events=[];ensureFauxRegistered().setResponses([fauxAssistantMessage("again")]);await invoke("task:prompt",{taskId:task.id,text:"hello again"});await settled(task.id);
 expect(core.db.prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id=? AND type='run_progress'").get(task.id)).toEqual({count:1});
 await invoke("task:delete",{taskId:task.id});expect(core.db.prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id=?").get(task.id)).toEqual({count:0});
});
it("does not wait for hidden MCP tool names when starting a plain conversation",async()=>{
 await invoke("mcp:add",{name:"unavailable",url:"http://127.0.0.1:1/mcp"});
 writeFileSync(join(dir,"pi","mcp.json"),JSON.stringify({mcpServers:{unavailable:{url:"http://127.0.0.1:1/mcp",exposure:"hidden"}}}));
 ensureFauxRegistered().setResponses([fauxAssistantMessage("ready")]);const task=await invoke("task:create",{title:"MCP startup"});
 await invoke("task:prompt",{taskId:task.id,text:"hello"});await settled(task.id);
 expect(events.some(e=>e.type==="task:progress"&&e.payload.stage==="mcp")).toBe(false);
},4000);
