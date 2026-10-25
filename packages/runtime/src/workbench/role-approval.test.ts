import {beforeEach,afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {createHarnessCore,type HarnessCore} from '../core/harness-core.js';
import {ensureFauxRegistered,fauxModelRef} from '../pi/faux-provider.js';
let core:HarnessCore,dir:string,a:string,b:string;
const json=(x:unknown)=>fauxAssistantMessage(JSON.stringify(x));
const tool=(name:string,input:Parameters<typeof fauxToolCall>[1])=>fauxAssistantMessage([fauxToolCall(name,input)]);
async function call(name:string,input:unknown={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result;}
async function until(id:string,test:(w:any)=>boolean){for(let i=0;i<500;i++){const w=core.workbench.get(id);if(test(w))return w;await new Promise(r=>setTimeout(r,10));}throw Error('timed out');}
beforeEach(async()=>{
 dir=mkdtempSync(join(tmpdir(),'pih-role-approval-'));core=await createHarnessCore({dataDir:dir,enableFaux:true});
 await call('settings:set',{defaultModel:fauxModelRef(),permissionMode:'bypass',autoApproveTools:[]});
 a=(await call('role:create',{name:'前端',preferredModel:fauxModelRef('a')})).id;
 b=(await call('role:create',{name:'后端',preferredModel:fauxModelRef('b')})).id;
});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
async function setup(mode?:'ask'|'auto'|'allow',grant=true){
 const w=await call('workbench:create',{title:'审批模式',roleIds:[a,b]});
 if(grant)await call('workbench:setAccess',{id:w.id,roleId:a,commands:true,network:false,servers:[]});
 if(mode)await call('workbench:setApprovalMode',{id:w.id,roleId:a,approvalMode:mode});
 ensureFauxRegistered().setResponses([json({reply:'只交给前端',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'检查并完成文件',files:['owned/'],dependsOn:[]}]})]);
 return w;
}
it.skipIf(process.platform!=='darwin').each([
 [undefined,'pwd',true],['ask','pwd',true],['auto','pwd',false],['auto','printf written > owned/result.txt',true],['auto','node --version',true],['allow','printf written > owned/result.txt',false],
] as const)('mode %s command %s asks=%s',async(mode,command,asks)=>{
 const w=await setup(mode);
 ensureFauxRegistered('a').setResponses([json({plan:'执行本角色职责',contracts:[]}),tool('write',{path:'owned/seed.txt',content:'seed'}),tool('workbench_command',{command}),fauxAssistantMessage('完成')]);
 await call('workbench:send',{id:w.id,text:'开始检查',requestId:'run'});
 const result=await until(w.id,x=>x.participants.some((p:any)=>p.status==='waiting_approval')||['awaiting_review','error'].includes(x.phase));
 const worker=result.participants.find((p:any)=>p.roleId===a)!,record=await call('task:get',{taskId:worker.taskId});
 expect(record.pendingApprovals.length).toBe(asks?1:0);
 expect(result.participants.find((p:any)=>p.roleId===b)!.taskId).toBeNull();
 if(!asks){expect(result.phase).toBe('awaiting_review');if(command.includes('>')){const run=core.db.prepare('SELECT root FROM workbench_runs WHERE task_id=?').get(worker.taskId) as {root:string};expect(readFileSync(join(run.root,'owned/result.txt'),'utf8')).toBe('written');}}
 else await call('workbench:stop',{id:w.id});
});
it('full allowance never grants missing command or plugin access',async()=>{
 for(const name of ['workbench_command','workbench_plugin']){
  const w=await setup('allow',false);
  ensureFauxRegistered('a').setResponses([json({plan:'执行',contracts:[]}),tool(name,name==='workbench_command'?{command:'echo forbidden'}:{server:'ungranted',tool:'write',args:{}})]);
  await call('workbench:send',{id:w.id,text:'执行',requestId:name});
  const result=await until(w.id,x=>['stopped','error'].includes(x.phase));
  expect(result.participants.find((p:any)=>p.roleId===a)!.status).toBe('blocked');
  expect(result.access?.find((x:any)=>x.roleId===a)).toMatchObject({commands:false,network:false,servers:[],approvalMode:'allow'});
 }
});
it.skipIf(process.platform!=='darwin')('switching a live role affects later operations without silently approving the pending request',async()=>{
 const w=await setup('ask');
 ensureFauxRegistered('a').setResponses([json({plan:'执行',contracts:[]}),tool('write',{path:'owned/seed.txt',content:'seed'}),tool('workbench_command',{command:'pwd'}),tool('workbench_command',{command:'printf after > owned/after.txt'}),fauxAssistantMessage('完成')]);
 await call('workbench:send',{id:w.id,text:'执行',requestId:'live'});
 let result=await until(w.id,x=>x.participants.some((p:any)=>p.status==='waiting_approval'));
 const taskId=result.participants.find((p:any)=>p.roleId===a)!.taskId;
 const before=await call('task:get',{taskId});
 await call('workbench:setApprovalMode',{id:w.id,roleId:a,approvalMode:'allow'});
 const after=await call('task:get',{taskId});expect(after.pendingApprovals).toEqual(before.pendingApprovals);
 expect(core.workbench.get(w.id).access?.some(x=>x.roleId===b)).toBe(false);
 await call('approval:decide',{taskId,toolCallId:after.pendingApprovals[0].toolCallId,approved:true});
 result=await until(w.id,x=>x.phase==='awaiting_review');
 const run=core.db.prepare('SELECT root FROM workbench_runs WHERE task_id=?').get(taskId) as {root:string};
 expect(readFileSync(join(run.root,'owned/after.txt'),'utf8')).toBe('after');
 expect((await call('task:get',{taskId})).pendingApprovals).toHaveLength(0);
});
it('persists each role mode without widening grants, and preserves it when grants change',async()=>{
 const w=await setup('auto');
 await call('workbench:setAccess',{id:w.id,roleId:a,commands:true,network:true,servers:['fixture']});
 await call('workbench:setApprovalMode',{id:w.id,roleId:b,approvalMode:'allow'});
 await expect(call('workbench:setApprovalMode',{id:w.id,roleId:'other',approvalMode:'allow'})).rejects.toThrow('未加入');
 await expect(call('workbench:setApprovalMode',{id:w.id,roleId:a,approvalMode:'invalid'})).rejects.toThrow();
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 const saved=core.workbench.get(w.id);
 expect(saved.access?.find(x=>x.roleId===a)).toMatchObject({approvalMode:'auto',commands:true,network:true,servers:['fixture']});
 expect(saved.access?.find(x=>x.roleId===b)).toMatchObject({approvalMode:'allow',commands:false,network:false,servers:[]});
});
it('auto mode asks for authorized plugins whose risk cannot be determined',async()=>{
 const w=await setup('auto');
 await call('workbench:setAccess',{id:w.id,roleId:a,commands:true,network:false,servers:['fixture']});
 ensureFauxRegistered('a').setResponses([json({plan:'检查插件',contracts:[]}),tool('workbench_plugin',{server:'fixture',tool:'unknown_operation',args:{}})]);
 await call('workbench:send',{id:w.id,text:'检查',requestId:'plugin'});
 const result=await until(w.id,x=>x.participants.some((p:any)=>p.status==='waiting_approval'));
 const record=await call('task:get',{taskId:result.participants.find((p:any)=>p.roleId===a)!.taskId});
 expect(record.pendingApprovals[0].toolName).toBe('workbench_plugin');
 await call('workbench:stop',{id:w.id});
});
it('full allowance still blocks writes outside the role responsibility',async()=>{
 const w=await setup('allow');
 ensureFauxRegistered('a').setResponses([json({plan:'执行',contracts:[]}),tool('write',{path:'other/forbidden.txt',content:'forbidden'}),fauxAssistantMessage('结束')]);
 await call('workbench:send',{id:w.id,text:'检查边界',requestId:'scope'});
 const result=await until(w.id,x=>['awaiting_review','error'].includes(x.phase));
 const taskId=result.participants.find((p:any)=>p.roleId===a)!.taskId;
 const run=core.db.prepare('SELECT root FROM workbench_runs WHERE task_id=?').get(taskId) as {root:string};
 expect(existsSync(join(run.root,'other/forbidden.txt'))).toBe(false);
});
