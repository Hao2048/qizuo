import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {createHarnessCore,type HarnessCore} from '../core/harness-core.js';
import {TimeMemoryService,nextTime} from './time-memory.js';import {ensureFauxRegistered,fauxModelRef} from '../pi/faux-provider.js';
let core:HarnessCore,service:TimeMemoryService,dir:string,role:string,now:number;
async function call(name:string,input:unknown={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result;}
async function until(taskId:string,status:string){for(let i=0;i<300;i++){const t=await call('task:get',{taskId});if(t.task.status===status)return t;await new Promise(r=>setTimeout(r,10));}throw Error('timeout '+status);}
const options=()=>({db:core.db,tasks:core.tasks,roles:core.roles,emit:(type:string,payload:unknown)=>core.router.emit(type,payload),now:()=>now});
const once=()=>({roleId:role,title:'整理事项',instructions:'简短总结今天的事项，不执行工具。',rule:{kind:'once' as const,at:new Date(now+5000).toISOString()}});
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'pih-time-'));core=await createHarnessCore({dataDir:dir,enableFaux:true});await core.timeMemories.shutdown();now=Date.parse('2027-01-01T00:00:00Z');service=new TimeMemoryService(options());role=(await call('role:create',{name:'分析师',preferredModel:fauxModelRef('a')})).id;await call('settings:set',{defaultModel:fauxModelRef(),permissionMode:'auto_edit',autoApproveTools:['read']});});
afterEach(async()=>{await service.shutdown();await core.shutdown();rmSync(dir,{recursive:true,force:true});});
it('fires once into its own role session, claims concurrent ticks once and keeps future jobs out of other roles',async()=>{
 const other=await call('role:create',{name:'另一个角色'});await call('memory:write',{scopeType:'role',scopeId:other.id,title:'私有数据',content:'OTHER_ROLE_PRIVATE_CANARY'});
 let context='';ensureFauxRegistered('a').setResponses([ctx=>{context=JSON.stringify(ctx);return fauxAssistantMessage('已整理。');}]);
 const item=service.create(once());expect(service.list(other.id).items).toHaveLength(0);now+=5000;await Promise.all([service.tick(),service.tick(),service.tick()]);
 const run=service.list(role).items[0]!;expect(run.activeTaskId).toBeTruthy();const task=await until(run.activeTaskId!,'done');await service.tick();
 expect(task.task.roleId).toBe(role);expect(context).not.toContain('OTHER_ROLE_PRIVATE_CANARY');expect(context).toContain('简短总结今天的事项');expect(service.list(role).items[0]).toMatchObject({enabled:false,status:'completed',activeTaskId:null});
 await service.tick();expect(core.db.prepare('SELECT count(*) n FROM time_memory_runs WHERE schedule_id=?').get(item.id)).toEqual({n:1});
 expect(()=>service.setEnabled(item.id,other.id,true)).toThrow('当前角色');expect(()=>service.remove(item.id,other.id)).toThrow('当前角色');
});
it('missed occurrences never run on startup and require explicit one-off execution',async()=>{
 const item=service.create(once());await service.shutdown();now+=3600000;service=new TimeMemoryService(options());await service.tick();
 expect(service.list(role).items[0]).toMatchObject({status:'missed',enabled:false,nextRun:null});expect(await core.tasks.listTasks()).toHaveLength(0);
 ensureFauxRegistered('a').setResponses([fauxAssistantMessage('手动补做。')]);const run=await service.run(item.id,role);await until(run.taskId,'done');await service.tick();expect(service.list(role).items[0]!.status).toBe('completed');
});
it('honors task approvals, does not overlap while pending, and disabling prevents subsequent repeats',async()=>{
 await call('settings:set',{permissionMode:'ask',autoApproveTools:['read']});
 ensureFauxRegistered('a').setResponses([fauxAssistantMessage([fauxToolCall('write',{path:'scheduled-proof.txt',content:'approved'})]),fauxAssistantMessage('完成')]);
 const item=service.create({...once(),rule:{kind:'daily',time:'00:01',timezone:'UTC'}});now=Date.parse('2027-01-01T00:01:00Z');await service.tick();const taskId=service.list(role).items[0]!.activeTaskId!;const waiting=await until(taskId,'waiting_approval');
 service.setEnabled(item.id,role,false);now+=86400000;await service.tick();expect(service.list(role).items[0]!.activeTaskId).toBe(taskId);expect(()=>service.remove(item.id,role)).toThrow('尚未结束');
 await call('approval:decide',{taskId,toolCallId:waiting.pendingApprovals[0].toolCallId,approved:true});await until(taskId,'done');await service.tick();expect(service.list(role).items[0]).toMatchObject({enabled:false,nextRun:null});service.remove(item.id,role);expect(service.list(role).items).toEqual([]);
});
it('stops unavailable roles and does not silently substitute the default role',async()=>{
 const item=service.create(once());core.db.prepare("UPDATE roles SET status='archived' WHERE id=?").run(role);now+=5000;await service.tick();expect(service.list(role).items[0]).toMatchObject({enabled:false,status:'failed'});expect(await core.tasks.listTasks()).toHaveLength(0);expect(service.list(role).items[0]!.id).toBe(item.id);
});
it('conversation tools bind ownership and explicit current-request evidence, deduplicate retries, and reject recursive scheduling',async()=>{
 const task=await call('task:create',{roleId:role});const request={text:'明天上午9点整理今天的事项',review:false};const tools=service.toolsFor(task.id,()=>request),save=tools.find(t=>t.name==='save_time_memory')!;
 const input={title:'明日整理',instructions:'整理今天的事项',rule:{kind:'once',at:'2027-01-02T09:00:00+08:00'},evidence:request.text};
 await save.execute('same',input,undefined as never,undefined as never,undefined as never);await save.execute('retry',input,undefined as never,undefined as never,undefined as never);expect(service.list(role).items).toHaveLength(1);
 await expect(save.execute('bad',{...input,evidence:'其他历史消息'},undefined as never,undefined as never,undefined as never)).rejects.toThrow('本轮用户');request.review=true;await expect(save.execute('bad',input,undefined as never,undefined as never,undefined as never)).rejects.toThrow('当前角色');
 request.review=false;ensureFauxRegistered('a').setResponses([fauxAssistantMessage('完成')]);const run=await service.run(service.list(role).items[0]!.id,role);expect(service.toolsFor(run.taskId,()=>request)).toEqual([]);await until(run.taskId,'done');
});
it('creates time memory through the actual agent tool path only after an explicit conversation request',async()=>{
 core.tasks.setTimeMemoryTools((id,request)=>service.toolsFor(id,request));const task=await call('task:create',{roleId:role});
 ensureFauxRegistered('a').setResponses([fauxAssistantMessage([fauxToolCall('tool_search',{query:'save_time_memory',limit:1})]),fauxAssistantMessage([fauxToolCall('save_time_memory',{title:'固定时间整理',instructions:'整理事项',rule:{kind:'once',at:'2027-01-02T09:00:00+08:00'},evidence:'明天上午9点整理事项'})]),fauxAssistantMessage('已创建时间记忆。')]);
 await call('task:prompt',{taskId:task.id,text:'明天上午9点整理事项'});const result=await until(task.id,'done');expect(service.list(role).items,JSON.stringify(result.transcript)).toHaveLength(1);expect(service.list(role).items[0]!.sourceTaskId).toBe(task.id);
});
it('recurrence respects timezone, weekly days and DST gaps/folds without duplicate local-day execution',()=>{
 expect(new Date(nextTime({kind:'weekly',time:'09:00',timezone:'Asia/Shanghai',weekdays:[1]},Date.parse('2027-01-01T00:00:00Z'))).toISOString()).toBe('2027-01-04T01:00:00.000Z');
 expect(new Date(nextTime({kind:'daily',time:'01:30',timezone:'America/New_York'},Date.parse('2026-11-01T05:31:00Z'))).toISOString()).toBe('2026-11-02T06:30:00.000Z');
 expect(new Date(nextTime({kind:'daily',time:'02:30',timezone:'America/New_York'},Date.parse('2026-03-08T06:00:00Z'))).toISOString()).toBe('2026-03-09T06:30:00.000Z');
 expect(()=>nextTime({kind:'once',at:'2027-01-01T09:00'},now)).toThrow('时区');
});
it('restart interrupts an approval-waiting scheduled run without recreating or auto-resuming it',async()=>{
 await call('settings:set',{permissionMode:'ask',autoApproveTools:['read']});ensureFauxRegistered('a').setResponses([fauxAssistantMessage([fauxToolCall('write',{path:'restart-proof.txt',content:'must wait'})])]);
 const item=service.create(once());const {taskId}=await service.run(item.id,role);await until(taskId,'waiting_approval');await service.shutdown();await core.shutdown();
 core=await createHarnessCore({dataDir:dir,enableFaux:true});await core.timeMemories.shutdown();service=new TimeMemoryService(options());await service.tick();
 expect(service.list(role).items[0]).toMatchObject({status:'interrupted',enabled:false,activeTaskId:null,lastTaskId:taskId});expect((await call('task:get',{taskId})).pendingApprovals).toEqual([]);expect(await core.tasks.listTasks()).toHaveLength(1);
});
it('deleted projects do not fall back to another workspace and invalid calendar dates are rejected',async()=>{
 const p=await call('project:add',{dir});const item=service.create({...once(),projectId:p.id});core.db.prepare('DELETE FROM projects WHERE id=?').run(p.id);now+=5000;await service.tick();
 expect(service.list(role).items[0]).toMatchObject({id:item.id,status:'failed',enabled:false});expect(await core.tasks.listTasks()).toHaveLength(0);
 expect(()=>nextTime({kind:'once',at:'2027-02-30T09:00:00+08:00'},now)).toThrow('日期无效');
});
it('keeps an already-finished run completed when the app exits before the next status tick',async()=>{
 ensureFauxRegistered('a').setResponses([fauxAssistantMessage('已完成')]);const item=service.create(once());const run=await service.run(item.id,role);await until(run.taskId,'done');await service.shutdown();service=new TimeMemoryService(options());
 expect(service.list(role).items[0]).toMatchObject({status:'completed',activeTaskId:null,enabled:false});expect(await core.tasks.listTasks()).toHaveLength(1);
});
