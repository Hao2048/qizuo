import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessCore, type HarnessCore } from '../core/harness-core.js';
// @ts-expect-error Offline fixture is shared with the packaged-app acceptance script.
import { faultServer, configureFixture } from './http-fixture.mjs';

let core:HarnessCore,dir:string,http:any;
const model=(modelId='worker-a')=>({provider:'stability-http',modelId});
async function call(name:string,input:unknown={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result;}
async function until(check:()=>unknown|Promise<unknown>,ms=25000):Promise<any>{const end=Date.now()+ms;while(Date.now()<end){const v=await check();if(v)return v;await new Promise(r=>setTimeout(r,15));}throw Error('Stability condition timed out');}
async function settled(taskId:string){return until(async()=>{const t=await call('task:get',{taskId});return ['done','error','cancelled'].includes(t.task.status)?t:false;});}
beforeEach(async()=>{http=await faultServer();dir=mkdtempSync(join(tmpdir(),'pih-stability-'));configureFixture(dir,http.url);core=await createHarnessCore({dataDir:dir,enableFaux:true});await call('settings:set',{defaultModel:model(),permissionMode:'ask',autoApproveTools:[]});});
afterEach(async()=>{http?.disconnect();await core?.shutdown();await http?.close();rmSync(dir,{recursive:true,force:true});});

it('network stream loss becomes an error, preserves user history and allows a new explicit request',async()=>{
 const task=await call('task:create',{title:'断网恢复'});http.scripts.set('STABLE_cut',{cut:true});
 await call('task:prompt',{taskId:task.id,text:'STABLE_cut'});const failed=await settled(task.id);
 expect(failed.task.status).toBe('error');expect(failed.transcript.filter((m:any)=>m.role==='user')).toHaveLength(1);
 await call('task:prompt',{taskId:task.id,text:'STABLE_retry'});const resumed=await settled(task.id);
 expect(resumed.task.status).toBe('done');expect(resumed.transcript.some((m:any)=>m.text?.includes('DONE_STABLE_retry'))).toBe(true);
 expect(resumed.transcript.filter((m:any)=>m.role==='user')).toHaveLength(2);
},45000);

it('cancelling one stalled connection does not cancel another role and releases network resources',async()=>{
 http.scripts.set('STABLE_stall',{stall:true});http.scripts.set('STABLE_other',{delay:80});
 const a=await call('task:create',{}),b=await call('task:create',{model:model('worker-b')});
 await call('task:prompt',{taskId:a.id,text:'STABLE_stall'});await until(()=>http.events.some((e:any)=>e.marker==='STABLE_stall'));
 await call('task:prompt',{taskId:b.id,text:'STABLE_other'});await until(()=>http.active===2);await call('task:abort',{taskId:a.id});
 expect((await settled(a.id)).task.status).toBe('cancelled');expect((await settled(b.id)).task.status).toBe('done');
 await until(()=>http.active===0);expect(http.peak).toBeGreaterThanOrEqual(2);
},45000);

it('concurrent repeated turns keep role prompts, sessions, receipts and deletion isolated',async()=>{
 const roles=await Promise.all(['A','B','C'].map((x,i)=>call('role:create',{name:'压力角色 '+x,systemPrompt:'PRIVATE_ROLE_'+x,preferredModel:model(['worker-a','worker-b','worker-c'][i])})));
 await Promise.all(roles.map((r:any,i:number)=>call('memory:write',{scopeType:'role',scopeId:r.id,title:'运行隔离',content:'PRIVATE_MEMORY_'+['A','B','C'][i]})));
 const tasks=await Promise.all(roles.map((r:any)=>call('task:create',{roleId:r.id})));
 for(let round=0;round<12;round++){
  await Promise.all(tasks.map((t:any,i:number)=>call('task:prompt',{taskId:t.id,text:`运行隔离 STABLE_turn_${round}_${i}`})));
  const completed=await Promise.all(tasks.map((t:any)=>settled(t.id)));
  for(let i=0;i<completed.length;i++){expect(completed[i].task.status).toBe('done');expect(completed[i].transcript.filter((m:any)=>m.role==='user')).toHaveLength(round+1);}
 }
 for(const e of http.events){const role=({'worker-a':'A','worker-b':'B','worker-c':'C'} as any)[e.model];expect(e.canaries).toEqual(['PRIVATE_ROLE_'+role]);expect(e.memoryCanaries).toEqual(['PRIVATE_MEMORY_'+role]);}
 expect(http.events).toHaveLength(36);await until(()=>http.active===0);
 await call('task:delete',{taskId:tasks[0].id});
 expect((await call('task:get',{taskId:tasks[1].id})).transcript.filter((m:any)=>m.role==='user')).toHaveLength(12);
 expect(core.db.pragma('integrity_check')).toEqual([{integrity_check:'ok'}]);expect(core.db.pragma('foreign_key_check')).toEqual([]);
},60000);

it('workbench route interruption can be stopped, restarted without replay, and retried explicitly',async()=>{
 await call('settings:set',{defaultModel:model('router'),permissionMode:'ask',autoApproveTools:[]});http.scripts.set('STABLE_wbstall',{stall:true});
 const w=await call('workbench:create',{title:'工作台中断'});
 await call('workbench:send',{id:w.id,text:'STABLE_wbstall',requestId:'stalled'});
 await until(()=>http.events.some((e:any)=>e.marker==='STABLE_wbstall'));
 await call('workbench:stop',{id:w.id});expect(core.workbench.get(w.id).phase).toBe('stopped');
 const calls=http.events.length;await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 expect(core.workbench.get(w.id).phase).toBe('stopped');expect(http.events).toHaveLength(calls);
 await call('workbench:send',{id:w.id,text:'STABLE_wbresume',requestId:'resumed'});
 await until(()=>core.workbench.get(w.id).messages.some(m=>m.requestId==='resumed'&&m.kind==='reply'));
 expect(core.workbench.modelUsage(w.id).roles.some(r=>r.activeCalls>0)).toBe(false);
},45000);

it('an upstream network failure never starts the dependent executor or affects another workbench',async()=>{
 await call('settings:set',{defaultModel:model('router'),permissionMode:'ask',autoApproveTools:[]});
 const a=await call('role:create',{name:'上游',systemPrompt:'PRIVATE_ROLE_A',preferredModel:model('worker-a')}),b=await call('role:create',{name:'下游',systemPrompt:'PRIVATE_ROLE_B',preferredModel:model('worker-b')});
 const w=await call('workbench:create',{title:'依赖故障',roleIds:[a.id,b.id]}),other=await call('workbench:create',{title:'独立任务'});
 http.scripts.set('STABLE_dependency_fail',{decision:{reply:'先上游后下游',action:'dispatch',roleIds:[a.id,b.id],assignments:[{roleId:a.id,instructions:'产出上游',files:['upstream/'],dependsOn:[]},{roleId:b.id,instructions:'等待上游',files:['downstream/'],dependsOn:[a.id]}]},models:{'worker-a':{cut:'execution'}}});
 await call('workbench:send',{id:w.id,text:'STABLE_dependency_fail',requestId:'upstream-failure'});
 await call('workbench:send',{id:other.id,text:'STABLE_independent',requestId:'independent'});
 await until(()=>core.workbench.get(other.id).messages.some(m=>m.kind==='reply'));
 await until(()=>core.workbench.get(w.id).phase==='error');
 expect(http.events.filter((e:any)=>e.marker==='STABLE_dependency_fail'&&e.model==='worker-b'&&e.hasTools)).toEqual([]);
 expect(core.workbench.get(other.id).messages.some(m=>m.text.includes('ACK_STABLE_independent'))).toBe(true);
 expect(core.workbench.get(w.id).participants.every(p=>!p.pluginResources?.length)).toBe(true);
},45000);

it('shutdown during cold session initialization drains it before closing SQLite',async()=>{
 const task=await call('task:create',{title:'初始化中退出'});
 const pending=call('task:prompt',{taskId:task.id,text:'STABLE_shutdown_start'}).catch(error=>({error:String(error)}));
 await core.shutdown();
 const result=await pending;
 expect(result.error??'').not.toMatch(/database|connection.*closed|not open/i);
 await until(()=>http.active===0);
 core=await createHarnessCore({dataDir:dir,enableFaux:true});
 const recovered=await call('task:get',{taskId:task.id});
 expect(['draft','cancelled','done','error']).toContain(recovered.task.status);
 expect(core.db.pragma('integrity_check')).toEqual([{integrity_check:'ok'}]);
},30000);

it('waits for an in-flight SDK resource load to cancel and release before closing the database',async()=>{
 const task=await call('task:create',{title:'资源加载中退出'});
 let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const original=DefaultResourceLoader.prototype.reload;
 const spy=vi.spyOn(DefaultResourceLoader.prototype,'reload').mockImplementation(async function(this:DefaultResourceLoader){entered();await gate;return original.call(this);});
 let pending:Promise<any>|undefined,closing:Promise<void>|undefined;
 try {
  pending=call('task:prompt',{taskId:task.id,text:'STABLE_initializing'}).catch(error=>({error:String(error)}));
  await ready;
  let closed=false;closing=core.shutdown().then(()=>{closed=true;});
  await new Promise(r=>setTimeout(r,30));
  expect(closed).toBe(false);
  expect(core.db.pragma('integrity_check')).toEqual([{integrity_check:'ok'}]);
  release();const result=await pending;await closing;
  expect(result.error??'').not.toMatch(/database|connection.*closed|not open/i);
  expect(http.events).toHaveLength(0);
 } finally {release();spy.mockRestore();await pending;await closing;}
},30000);

it('also drains a restored session being opened for manual compaction before shutdown',async()=>{
 const task=await call('task:create',{title:'压缩初始化退出'});
 await call('task:prompt',{taskId:task.id,text:'STABLE_history'});await settled(task.id);
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const original=DefaultResourceLoader.prototype.reload;
 const spy=vi.spyOn(DefaultResourceLoader.prototype,'reload').mockImplementation(async function(this:DefaultResourceLoader){entered();await gate;return original.call(this);});
 let compacting:Promise<any>|undefined,closing:Promise<void>|undefined;
 try {
  compacting=call('task:compact',{taskId:task.id});await ready;
  let closed=false;closing=core.shutdown().then(()=>{closed=true;});
  await new Promise(r=>setTimeout(r,30));expect(closed).toBe(false);
  release();const result=await compacting;await closing;
  expect(result.ok).toBe(false);expect(result.message).not.toMatch(/database|connection.*closed|not open/i);
 } finally {release();spy.mockRestore();await compacting;await closing;}
},30000);

it('ordinary chats and two workbenches execute together without sharing role context or session identity',async()=>{
 await call('settings:set',{defaultModel:model('router'),permissionMode:'ask',autoApproveTools:[]});
 const names=['A','B','C'],models=['worker-a','worker-b','worker-c'];
 const roles=await Promise.all(names.map((x,i)=>call('role:create',{name:'混合并发 '+x,systemPrompt:'PRIVATE_ROLE_'+x,preferredModel:model(models[i])})));
 await Promise.all(roles.map((r:any,i:number)=>call('memory:write',{scopeType:'role',scopeId:r.id,title:'运行隔离',content:'PRIVATE_MEMORY_'+names[i]})));
 const chats=await Promise.all(roles.map((r:any)=>call('task:create',{roleId:r.id})));
 const workbenches=await Promise.all([0,1].map(i=>call('workbench:create',{title:'混合工作台 '+i,roleIds:roles.slice(0,2).map((r:any)=>r.id)})));
 const decision={reply:'独立协作',action:'dispatch',roleIds:roles.slice(0,2).map((r:any)=>r.id),assignments:roles.slice(0,2).map((r:any,i:number)=>({roleId:r.id,instructions:'运行隔离',files:[`owned-${i}/`],dependsOn:[]}))};
 chats.forEach((_:any,i:number)=>http.scripts.set('STABLE_mixed_chat_'+i,{delay:300}));
 workbenches.forEach((_:any,i:number)=>http.scripts.set('STABLE_mixed_wb_'+i,{decision,delay:60}));
 await Promise.all([...chats.map((t:any,i:number)=>call('task:prompt',{taskId:t.id,text:'运行隔离 STABLE_mixed_chat_'+i})),...workbenches.map((w:any,i:number)=>call('workbench:send',{id:w.id,text:'运行隔离 STABLE_mixed_wb_'+i,requestId:'mixed-'+i}))]);
 await Promise.all([...chats.map((t:any)=>settled(t.id)),...workbenches.map((w:any)=>until(()=>core.workbench.get(w.id).phase==='awaiting_review'))]);
 expect(http.peak).toBeGreaterThan(3);
 for(const e of http.events.filter((e:any)=>e.model!=='router')){const own=names[models.indexOf(e.model)];expect(e.canaries).toEqual(e.hasTools?['PRIVATE_ROLE_'+own]:[]);expect(e.memoryCanaries).toEqual(e.hasTools?['PRIVATE_MEMORY_'+own]:[]);}
 const workerIds=workbenches.flatMap((w:any)=>core.workbench.get(w.id).participants.map(p=>p.taskId));
 const ids=[...chats.map((t:any)=>t.id),...workerIds];expect(new Set(ids).size).toBe(7);
 const sessions=core.db.prepare(`SELECT pi_session_id FROM tasks WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids) as {pi_session_id:string|null}[];
 expect(sessions).toHaveLength(7);expect(sessions.every(s=>!!s.pi_session_id)).toBe(true);
 expect(new Set(sessions.map(t=>t.pi_session_id)).size).toBe(7);
 await until(()=>http.active===0);
},30000);
