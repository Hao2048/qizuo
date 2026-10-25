import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { createHarnessCore, type HarnessCore } from '../core/harness-core.js';
import { ensureFauxRegistered, fauxModelRef } from '../pi/faux-provider.js';
let core: HarnessCore, dir: string;
async function call(name: string,input:unknown={}) { const r=await core.router.invoke(name,input); if(!r.ok)throw Error(r.error.message);return r.result as any; }
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'pih-usage-'));core=await createHarnessCore({dataDir:dir,enableFaux:true});await call('settings:set',{defaultModel:fauxModelRef(),permissionMode:'bypass',autoApproveTools:[]});});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
const begin = (workbenchId:string,roleId='r',stage:'routing'|'planning'='planning') => core.workbench.modelCalls.begin({workbenchId,requestId:'request',roleId,name:'角色名称',stage,provider:'faux',model:'one'});
it('records real routing receipts once, reads without invoking a model, and persists across restart',async()=>{
 const w=await call('workbench:create',{title:'仅咨询'});
 ensureFauxRegistered().setResponses([fauxAssistantMessage(JSON.stringify({reply:'先确认需求',action:'clarify',roleIds:[],assignments:[]}))]);
 await call('workbench:send',{id:w.id,text:'我们先讨论',requestId:'one'});
 for(let i=0;i<300&&core.workbench.get(w.id).phase!=='clarifying';i++) {
  if(core.workbench.get(w.id).messages.some(m=>m.kind==='reply')) break;
  await new Promise(r=>setTimeout(r,10));
 }
 let usage=await call('workbench:usage',{id:w.id});
 expect(usage.roles).toHaveLength(1);expect(usage.roles[0]).toMatchObject({stage:'routing',calls:1,receiptCalls:1,failedCalls:0,activeCalls:0});
 expect(usage.roles[0].lastDurationMs).toBeGreaterThanOrEqual(0);
 await call('workbench:send',{id:w.id,text:'我们先讨论',requestId:'one'});
 expect(await call('workbench:usage',{id:w.id})).toEqual(usage);
 expect(await core.tasks.listTasks()).toHaveLength(0);
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 expect(await call('workbench:usage',{id:w.id})).toEqual(usage);
});
it('sums actual input/cache without double counting and preserves unknown vs zero costs',async()=>{
 const w=await call('workbench:create',{title:'回执'}),other=await call('workbench:create',{title:'另一个任务'});
 const id=begin(w.id);core.workbench.modelCalls.settle(id,'completed',1234,{input:20,output:8,cacheRead:80,cacheWrite:10,cost:{total:0.002}});
 core.workbench.modelCalls.settle(id,'failed',999); // duplicate settlement is a no-op
 core.workbench.modelCalls.settle(begin(w.id),'failed',100);
 core.workbench.modelCalls.settle(begin(other.id),'completed',1,{input:99999});
 const [r]=(await call('workbench:usage',{id:w.id})).roles;
 expect(r).toMatchObject({calls:2,receiptCalls:1,inputTokens:110,outputTokens:8,cacheReadTokens:80,cacheReceiptCalls:1,costUSD:0.002,costReceiptCalls:1,failedCalls:1});
 const zero=begin(w.id,'free');core.workbench.modelCalls.settle(zero,'completed',1,{input:0,output:0,cacheRead:0,cost:{total:0}});
 expect((await call('workbench:usage',{id:w.id})).roles.find((r:any)=>r.roleId==='free')).toMatchObject({inputTokens:0,cacheReadTokens:0,costUSD:0,costReceiptCalls:1});
});
it('joins only owned worker receipts, keeps unrelated sessions out, and retains historical unknown prices',async()=>{
 const w=await call('workbench:create',{title:'执行'}),other=await call('workbench:create',{title:'其他'});
 const role=await call('role:create',{name:'执行角色',systemPrompt:'独立角色'});
 for(const [wb,price] of [[w.id,12],[other.id,99],[null,999]] as const) {
  const t=await call('task:create',{title:'执行',roleId:role.id});
  if(wb)core.db.prepare('INSERT INTO workbench_runs VALUES(?,?,?,?,?,?,?,?)').run(t.id,wb,role.id,'/tmp/test','{}','[]','req','{}');
  core.db.prepare('INSERT INTO usage_ledger(task_id,role_id,input_tokens,output_tokens,cache_read,cache_write,cost_usd_micros,created_at,cost_reported) VALUES(?,?,?,?,?,?,?,?,?)').run(t.id,role.id,10,4,30,5,price,1,wb===w.id?null:1);
 }
 const [r]=(await call('workbench:usage',{id:w.id})).roles;
 expect(r).toMatchObject({stage:'execution',calls:1,inputTokens:45,outputTokens:4,cacheReadTokens:30,costUSD:null,costReceiptCalls:0,lastDurationMs:null});
});
it('marks interrupted raw requests on restart without replay and cascades deletion despite late settlement',async()=>{
 const w=await call('workbench:create',{title:'中断'}),keep=await call('workbench:create',{title:'保留'});
 const id=begin(w.id);begin(keep.id);
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 expect((await call('workbench:usage',{id:w.id})).roles[0]).toMatchObject({activeCalls:0,interruptedCalls:1,receiptCalls:0,inputTokens:null,costUSD:null,lastDurationMs:null});
 await call('workbench:delete',{id:w.id});core.workbench.modelCalls.settle(id,'completed',1,{input:1});
 expect(core.db.prepare('SELECT count(*) n FROM workbench_model_calls WHERE workbench_id=?').get(w.id)).toEqual({n:0});
 expect((await call('workbench:usage',{id:keep.id})).roles).toHaveLength(1);
 await expect(call('workbench:usage',{id:w.id})).rejects.toThrow();
});
it('includes routing, both role plans and isolated execution receipts through the public workflow',async()=>{
 const roles=[] as string[];
 for(const suffix of ['a','b'])roles.push((await call('role:create',{name:'角色'+suffix,systemPrompt:'只做自己的文件',preferredModel:fauxModelRef(suffix)})).id);
 const w=await call('workbench:create',{title:'真实调用路径',roleIds:roles});
 ensureFauxRegistered().setResponses([fauxAssistantMessage(JSON.stringify({reply:'各自处理',action:'dispatch',roleIds:roles,assignments:roles.map((roleId,i)=>({roleId,instructions:'只检查自己的交付文件',files:[i+'.txt'],dependsOn:[]}))}))]);
 for(const suffix of ['a','b'])ensureFauxRegistered(suffix).setResponses([fauxAssistantMessage(JSON.stringify({plan:'独立规划',contracts:[]})),fauxAssistantMessage('已检查，无需改动')]);
 await call('workbench:send',{id:w.id,text:'分别检查文件',requestId:'run'});
 for(let i=0;i<500&&core.workbench.get(w.id).phase!=='awaiting_review';i++) {
  if(core.workbench.get(w.id).phase==='error')throw Error(core.workbench.get(w.id).messages.at(-1)?.text);
  await new Promise(r=>setTimeout(r,10));
 }
 expect(core.workbench.get(w.id).phase).toBe('awaiting_review');
 const usage=await call('workbench:usage',{id:w.id});
 expect(usage.roles).toHaveLength(5);
 for(const roleId of roles) {
  expect(usage.roles.filter((r:any)=>r.roleId===roleId).map((r:any)=>r.stage).sort()).toEqual(['execution','planning']);
  expect(usage.roles.filter((r:any)=>r.roleId===roleId).every((r:any)=>r.calls===1&&r.receiptCalls===1)).toBe(true);
 }
 expect(core.db.prepare('SELECT count(*) n FROM usage_ledger WHERE cost_reported=1').get()).toEqual({n:2});
});
it('measures first text from an actual local HTTP stream, keeps it distinct from thinking and persists round filters',async()=>{
 const {createServer}=await import('node:http');const {readFileSync,writeFileSync}=await import('node:fs');let requests=0;
 const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
 const server=createServer(async(req,res)=>{
  for await(const _chunk of req) { /* Drain input without recording prompts. */ }
  requests++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
  const frame=(delta:unknown,finish_reason:unknown=null,usage?:unknown)=>res.write('data: '+JSON.stringify({id:'timing-fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})+'\n\n');
  await pause(15);frame({role:'assistant',reasoning_content:'先理解需求'});
  await pause(45);frame({content:JSON.stringify({reply:'需求已收到',action:'clarify',roleIds:[],assignments:[]})});
  await pause(45);frame({},'stop',{prompt_tokens:100,completion_tokens:10,total_tokens:110});res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {
  const config=JSON.parse(readFileSync(core.pi.modelsPath,'utf8'));config.providers['timing-http']={api:'openai-completions',apiKey:'dummy',baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,models:[{id:'fixture',name:'fixture',reasoning:true,contextWindow:128000,maxTokens:1000,compat:{thinkingFormat:'deepseek'},cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]};
  writeFileSync(core.pi.modelsPath,JSON.stringify(config));await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
  await call('settings:set',{defaultModel:{provider:'timing-http',modelId:'fixture'},permissionMode:'ask',autoApproveTools:[]});
  const w=await call('workbench:create',{title:'流式计时'});
  for(const requestId of ['round-a','round-b']) {
    await call('workbench:send',{id:w.id,text:'只讨论需求 '+requestId,requestId});
    for(let i=0;i<300;i++) {if(core.workbench.get(w.id).messages.some(m=>m.requestId===requestId&&m.kind==='reply'))break;await pause(10);}
    const usage=await call('workbench:usage',{id:w.id,requestId});expect(usage.roles).toHaveLength(1);
    const r=usage.roles[0];expect(r.calls).toBe(1);expect(r.lastFirstResponseMs).toBeGreaterThanOrEqual(0);
    expect(r.lastFirstTextMs).toBeGreaterThan(r.lastFirstResponseMs);expect(r.lastDurationMs).toBeGreaterThan(r.lastFirstTextMs);
  }
  expect(requests).toBe(2);expect((await call('workbench:usage',{id:w.id})).roles[0].calls).toBe(2);
  const before=await call('workbench:usageCalls',{id:w.id,requestId:'round-a'});expect(before.calls).toHaveLength(1);
  await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
  expect(await call('workbench:usageCalls',{id:w.id,requestId:'round-a'})).toEqual(before);expect(requests).toBe(2);
 }finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
it('sidebar receipts follow each current worker ledger instead of stale planning usage, retaining unknown and zero across restart',async()=>{
 const roles:{id:string}[]=[];for(const name of ['设计','前端'])roles.push(await call('role:create',{name,preferredModel:fauxModelRef()}));
 const w=await call('workbench:create',{title:'缓存来源',roleIds:roles.map(r=>r.id)});
 const tasks:{id:string}[]=[];for(const r of roles){const t=await call('task:create',{roleId:r.id});tasks.push(t);core.db.prepare('UPDATE tasks SET workbench_owner=? WHERE id=?').run(w.id,t.id);core.db.prepare('INSERT INTO workbench_runs VALUES(?,?,?,?,?,?,?,?)').run(t.id,w.id,r.id,dir,'{}','[]','req','[]');}
 const body=core.workbench.get(w.id);body.usage=roles.map(r=>({roleId:r.id,percent:0.2,cacheHitPercent:68}));body.participants.forEach((p,i)=>{p.taskId=tasks[i]!.id;p.status='awaiting_review';});core.db.prepare('UPDATE workbenches SET body=? WHERE id=?').run(JSON.stringify(body),w.id);
 const receipt=(taskId:string,input:number,cache:number|null)=>core.db.prepare('INSERT INTO usage_ledger(task_id,input_tokens,output_tokens,cache_read,cache_write,cost_usd_micros,created_at) VALUES(?,?,0,?,0,0,?)').run(taskId,input,cache,Date.now());
 receipt(tasks[0]!.id,20,80);receipt(tasks[1]!.id,90,10);
 let result=await call('workbench:get',{id:w.id});expect(result.usage.find((u:any)=>u.roleId===roles[0]!.id)).toMatchObject({percent:null,cacheHitPercent:80});expect(result.usage.find((u:any)=>u.roleId===roles[1]!.id).cacheHitPercent).toBe(10);
 const unrelated=await call('task:create',{roleId:roles[0]!.id});receipt(unrelated.id,1,999);expect((await call('workbench:get',{id:w.id})).usage.find((u:any)=>u.roleId===roles[0]!.id).cacheHitPercent).toBe(80);
 receipt(tasks[0]!.id,100,null);receipt(tasks[1]!.id,100,0);
 const events:any[]=[];const off=core.router.onEvent(e=>events.push(e));core.workbench.onEvent({type:'task:roleContext',payload:{taskId:tasks[0]!.id}} as any);off();expect(events.some(e=>e.type==='workbench:changed'&&e.payload.id===w.id)).toBe(true);
 result=await call('workbench:get',{id:w.id});expect(result.usage.find((u:any)=>u.roleId===roles[0]!.id).cacheHitPercent).toBeNull();expect(result.usage.find((u:any)=>u.roleId===roles[1]!.id).cacheHitPercent).toBe(0);
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});result=await call('workbench:get',{id:w.id});expect(result.usage.find((u:any)=>u.roleId===roles[0]!.id).cacheHitPercent).toBeNull();expect(result.usage.find((u:any)=>u.roleId===roles[1]!.id).cacheHitPercent).toBe(0);
});
