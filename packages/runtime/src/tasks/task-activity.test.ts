import { afterEach,beforeEach,expect,it } from "vitest";
import { mkdtempSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage,fauxToolCall } from "@earendil-works/pi-ai";
import { createHarnessCore,type HarnessCore } from "../core/harness-core.js";
import { ensureFauxRegistered,fauxModelRef } from "../pi/faux-provider.js";
let dir:string,core:HarnessCore;
async function invoke(name:string,input:unknown={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw new Error(r.error.message);return r.result;}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),"pih-activity-"));core=await createHarnessCore({dataDir:dir,enableFaux:true});await invoke("settings:set",{defaultModel:fauxModelRef(),permissionMode:"ask",autoApproveTools:[]});});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
it("keeps older live tasks visible beyond the recent limit and excludes untouched drafts",async()=>{
 const old=await invoke("task:create",{title:"older live"});
 core.db.prepare("UPDATE tasks SET status='waiting_user',updated_at=1 WHERE id=?").run(old.id);
 for(let i=0;i<25;i++){const t=await invoke("task:create",{title:`done ${i}`});core.db.prepare("UPDATE tasks SET status='done',updated_at=? WHERE id=?").run(100+i,t.id);}
 await invoke("task:create",{title:"idle"});
 const {items}=await invoke("task:listActivity");
 expect(items).toHaveLength(21);expect(items[0]).toMatchObject({id:old.id,busy:true,status:"waiting_user"});
 expect(items.some((item:{title:string})=>item.title==="idle")).toBe(false);
 expect(items.some((item:{title:string})=>item.title==="done 0")).toBe(false);
});
it("stops a task waiting for approval without affecting another conversation",async()=>{
 const t=await invoke("task:create",{title:"awaiting"}),other=await invoke("task:create",{title:"other"});
 ensureFauxRegistered().setResponses([fauxAssistantMessage([fauxToolCall("write",{path:join(dir,"forbidden.txt"),content:"bad"})]),fauxAssistantMessage("stopped")]);
 await invoke("task:prompt",{taskId:t.id,text:"写入文件"});
 for(let i=0;i<300;i++){if((await invoke("task:get",{taskId:t.id})).task.status==="waiting_approval")break;await new Promise(r=>setTimeout(r,10));}
 expect((await invoke("task:listActivity")).items.find((item:{id:string})=>item.id===t.id)).toMatchObject({busy:true,status:"waiting_approval"});
 expect(await invoke("task:abort",{taskId:t.id})).toEqual({ok:true});
 for(let i=0;i<300;i++){if(!(await invoke("task:listActivity")).items.find((item:{id:string})=>item.id===t.id).busy)break;await new Promise(r=>setTimeout(r,10));}
 expect((await invoke("task:listActivity")).items.find((item:{id:string})=>item.id===t.id)).toMatchObject({busy:false,status:"cancelled"});
 expect((await invoke("task:get",{taskId:other.id})).task.status).toBe("draft");
});
it("returns a bounded last assistant result and removes deleted tasks",async()=>{
 const t=await invoke("task:create",{});

 core.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(t.id);
 core.db.prepare("INSERT INTO task_events(task_id,type,payload,created_at) VALUES(?,'transcript_snapshot',?,1)").run(t.id,JSON.stringify([{id:"answer",role:"assistant",text:"x".repeat(7000)}]));
 const result=await invoke("task:activityResult",{taskId:t.id});expect(result).toEqual({text:"x".repeat(6000),truncated:true});
 await invoke("task:delete",{taskId:t.id});expect((await invoke("task:listActivity")).items).toEqual([]);
 await expect(invoke("task:activityResult",{taskId:t.id})).rejects.toThrow("任务不存在");
});
