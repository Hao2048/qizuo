import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessCore, type HarnessCore } from '../core/harness-core.js';
import { WorkbenchExecutionTiming } from './execution-timing.js';
let core:HarnessCore,dir:string,clock:number,tracker:WorkbenchExecutionTiming,w:any,task:any;
async function call(name:string,input:unknown={}) {const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result as any;}
beforeEach(async()=>{
 dir=mkdtempSync(join(tmpdir(),'pih-timing-'));core=await createHarnessCore({dataDir:dir,enableFaux:true});clock=0;tracker=new WorkbenchExecutionTiming(core.db,()=>clock);
 const role=await call('role:create',{name:'隔离角色',systemPrompt:'只做本角色'});
 w=await call('workbench:create',{title:'计时'});task=await call('task:create',{title:'工作',roleId:role.id});
 core.db.prepare('INSERT INTO workbench_runs VALUES(?,?,?,?,?,?,?,?)').run(task.id,w.id,role.id,'/tmp/timing','{}','[]','round-one','{}');
});
afterEach(async()=>{tracker.clear();await core.shutdown();rmSync(dir,{recursive:true,force:true});});
const delta=(type:string,text:string)=>({type:'message_update',assistantMessageEvent:{type,delta:text}});
it('measures text separately from thinking, ignores empty events and never substitutes message completion',()=>{
 tracker.begin(task.id);clock=30;tracker.event(task.id,delta('text_delta',''));
 clock=100;tracker.event(task.id,delta('thinking_delta','思考'));clock=400;tracker.event(task.id,delta('text_delta','第一字'));
 clock=600;tracker.event(task.id,delta('text_delta','后续字'));clock=900;
 tracker.event(task.id,{type:'message_end',message:{role:'assistant',stopReason:'stop',usage:{input:10,output:4,cacheRead:20}}});
 const [r]=core.workbench.modelUsage(w.id,'round-one').roles;
 expect(r).toMatchObject({calls:1,receiptCalls:1,lastFirstResponseMs:100,lastFirstTextMs:400,lastDurationMs:900,inputTokens:30});
 tracker.finish(task.id,'interrupted');tracker.event(task.id,delta('text_delta','晚到'));
 expect(core.workbench.modelUsage(w.id,'round-one').roles[0]).toEqual(r);
});
it('counts successive tool/model attempts, links receipts once and filters rounds without including another task',async()=>{
 tracker.begin(task.id);clock=50;tracker.event(task.id,delta('toolcall_delta','{"path":'));
 clock=100;const id=tracker.event(task.id,{type:'message_end',message:{role:'assistant',stopReason:'toolUse',usage:{input:10,output:3}}})!;
 const receipt=core.db.prepare('INSERT INTO usage_ledger(task_id,role_id,input_tokens,created_at) VALUES(?,?,?,?)').run(task.id,task.roleId,10,Date.now());tracker.link(id,Number(receipt.lastInsertRowid));
 clock=300;tracker.begin(task.id);clock=450;tracker.event(task.id,delta('text_delta','完成'));clock=600;
 tracker.event(task.id,{type:'message_end',message:{role:'assistant',stopReason:'stop',usage:{input:20,output:5}}});
 expect(core.workbench.modelUsage(w.id,'round-one').roles[0]).toMatchObject({calls:2,inputTokens:30,lastFirstTextMs:150,lastDurationMs:300});
 const first=core.workbench.modelCalls.calls(core.workbench.get(w.id),{requestId:'round-one'});
 expect(first.calls).toHaveLength(2);expect(first.calls.find(c=>c.id===id)?.firstTextMs).toBeNull();
 core.db.prepare('UPDATE workbench_runs SET request_id=? WHERE task_id=?').run('round-two',task.id);
 clock=700;tracker.begin(task.id);clock=800;tracker.finish(task.id,'failed');
 expect(core.workbench.modelUsage(w.id,'round-two').roles[0]).toMatchObject({calls:1,failedCalls:1,lastFirstTextMs:null});
 expect(core.workbench.modelUsage(w.id,'round-one').roles[0]!.calls).toBe(2);
 expect(core.workbench.modelUsage(w.id,'unrelated').roles).toEqual([]);
 const normal=await call('task:create',{title:'普通会话'});tracker.begin(normal.id);tracker.event(normal.id,delta('text_delta','不采集'));
 expect(core.workbench.modelUsage(w.id).roles[0]!.calls).toBe(3);
});
it('does not fabricate timing for tool-only failure, clears interrupted clocks and refuses to resurrect deletion',async()=>{
 tracker.begin(task.id);clock=120;tracker.event(task.id,delta('thinking_delta','思考'));
 tracker.clear();
 expect(core.workbench.modelUsage(w.id).roles[0]).toMatchObject({calls:1,interruptedCalls:1,lastFirstTextMs:null,lastFirstResponseMs:120});
 tracker.begin(task.id);await call('workbench:delete',{id:w.id});clock=500;
 tracker.event(task.id,delta('text_delta','晚到'));tracker.finish(task.id,'failed');
 expect(core.db.prepare('SELECT count(*) n FROM workbench_execution_calls').get()).toEqual({n:0});
});
it('paginates call details at equal timestamps and rejects cross-workbench or cross-round cursors',()=>{
 for(let i=0;i<56;i++) {
 const id=core.workbench.modelCalls.begin({workbenchId:w.id,requestId:'round-one',roleId:'r',name:'角色',stage:'planning',provider:'faux',model:'one'});
 core.workbench.modelCalls.settle(id,'completed',100);
 }
 core.db.prepare('UPDATE workbench_model_calls SET started_at=1').run();
 const page=core.workbench.modelCalls.calls(core.workbench.get(w.id),{requestId:'round-one'});
 expect(page.calls).toHaveLength(50);expect(page.nextCursor).toBeTruthy();
 const second=core.workbench.modelCalls.calls(core.workbench.get(w.id),{requestId:'round-one',cursor:page.nextCursor!});
 expect(second.calls).toHaveLength(6);expect(second.nextCursor).toBeNull();expect(new Set([...page.calls,...second.calls].map(c=>c.id)).size).toBe(56);
 expect(()=>core.workbench.modelCalls.calls(core.workbench.get(w.id),{requestId:'round-two',cursor:page.nextCursor!})).toThrow('分页');
 expect(()=>core.workbench.modelCalls.calls({...core.workbench.get(w.id),id:'another'},{requestId:'round-one',cursor:page.nextCursor!})).toThrow('分页');
});
