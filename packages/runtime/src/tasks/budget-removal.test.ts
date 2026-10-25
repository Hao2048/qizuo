import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHarnessCore,type HarnessCore} from "../core/harness-core.js";
let core:HarnessCore|undefined,dir:string;
afterEach(async()=>{await core?.shutdown();if(dir)rmSync(dir,{recursive:true,force:true});});
it("retires persisted execution budgets while retaining concurrency and approvals across restart",async()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-budget-retirement-"));
 core=await createHarnessCore({dataDir:dir,enableFaux:true});
 core.db.setMeta("app_settings",JSON.stringify({autoApproveTools:["read"],permissionMode:"ask",agentLimits:{maxConcurrent:2,maxMembers:5,maxTokens:1,maxCalls:1,maxDurationMs:100,maxCostUSD:.01}}));
 await core.shutdown();core=undefined;
 core=await createHarnessCore({dataDir:dir,enableFaux:true});
 expect(core.tasks.getSettings()).toMatchObject({autoApproveTools:["read"],permissionMode:"ask",agentLimits:{maxConcurrent:2,maxMembers:5}});
 expect(JSON.parse(core.db.getMeta("app_settings")!).agentLimits).toEqual({maxConcurrent:2,maxMembers:5});
 const next=core.tasks.setSettings({...core.tasks.getSettings(),agentLimits:{maxConcurrent:1,maxMembers:4,maxTokens:1} as never});
 expect(next.agentLimits).toEqual({maxConcurrent:1,maxMembers:4});
 expect(JSON.parse(core.db.getMeta("app_settings")!).agentLimits).toEqual({maxConcurrent:1,maxMembers:4});
});
