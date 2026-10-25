import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage} from "@earendil-works/pi-ai";
import {createHarnessCore,type HarnessCore} from "../core/harness-core.js";
import {ensureFauxRegistered,fauxModelRef} from "../pi/faux-provider.js";
let core:HarnessCore,dir:string;
async function invoke(name:string,input:unknown):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw new Error(r.error.message);return r.result;}
function reasoning(){const original=core.pi.getModel.bind(core.pi);vi.spyOn(core.pi,"getModel").mockImplementation((provider,id)=>{const model=original(provider,id);return model ? {...model,reasoning:true} : undefined;});}
async function done(id:string){for(let i=0;i<200;i++){const result=await invoke("task:get",{taskId:id});if(["done","error"].includes(result.task.status))return result.task;await new Promise(r=>setTimeout(r,20));}throw new Error("timeout");}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-model-mode-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});reasoning();await invoke("settings:set",{defaultModel:fauxModelRef(),permissionMode:"bypass",autoApproveTools:[]});});
afterEach(async()=>{await core?.shutdown();vi.restoreAllMocks();rmSync(dir,{recursive:true,force:true});});
it("persists manual model/thinking, then auto restores role recommendations after restart",async()=>{
 const role=await invoke("role:create",{name:"research",systemPrompt:"research",preferredModel:fauxModelRef("b"),preferredThinking:"high"});
 const task=await invoke("task:create",{roleId:role.id});expect(task.modelOverride).toBeNull();
 expect(await invoke("task:setModel",{taskId:task.id,...fauxModelRef("a")})).toMatchObject({ok:true});expect(await invoke("task:setThinking",{taskId:task.id,level:"low"})).toMatchObject({ok:true});
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});reasoning();let thinking="";
 ensureFauxRegistered("a").setResponses([(_ctx,opts)=>{thinking=opts?.reasoning ?? "";return fauxAssistantMessage("manual");}]);
 await invoke("task:prompt",{taskId:task.id,text:"manual task"});const manual=await done(task.id);expect(manual.modelOverride).toEqual(fauxModelRef("a"));expect(manual.thinkingOverride).toBe("low");expect(thinking).toBe("low");
 expect(await invoke("task:setModel",{taskId:task.id,auto:true})).toMatchObject({ok:true});expect(await invoke("task:setThinking",{taskId:task.id,level:"low"})).toMatchObject({ok:false});
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});reasoning();
 ensureFauxRegistered("b").setResponses([(_ctx,opts)=>{thinking=opts?.reasoning ?? "";return fauxAssistantMessage("auto");}]);
 await invoke("task:prompt",{taskId:task.id,text:"auto task"});const automatic=await done(task.id);expect(automatic.modelOverride).toBeNull();expect(automatic.thinkingOverride).toBeNull();expect(automatic.model).toEqual(fauxModelRef("b"));expect(thinking).toBe("high");
});
