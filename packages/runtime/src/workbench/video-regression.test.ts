import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createHarnessCore, type HarnessCore } from '../core/harness-core.js';
import { ensureFauxRegistered, fauxModelRef } from '../pi/faux-provider.js';
let core: HarnessCore, dir: string, a: string, b: string;
const json = (x: unknown) => fauxAssistantMessage(JSON.stringify(x));
const tool = (name: string, input: Record<string, any>) => fauxAssistantMessage([fauxToolCall(name, input)]);
async function call(name: string, input: unknown = {}): Promise<any> {
  const r = await core.router.invoke(name, input);
  if (!r.ok) throw Error(r.error.message);
  return r.result;
}
async function until(id: string, test: (w: any) => boolean) {
  for (let i=0; i<500; i++) {
    const w=core.workbench.get(id);
    if (test(w)) return w;
    await new Promise(r=>setTimeout(r,10));
  }
  throw Error('timeout: '+JSON.stringify(core.workbench.get(id)));
}
const assignment = (roleId: string, files: string[], dependsOn: string[] = []) => ({roleId, files, dependsOn, instructions:'完成负责文件'});
function route(assignments: object[]) {
  ensureFauxRegistered().setResponses([json({reply:'按职责实施',action:'dispatch',roleIds:assignments.map((x:any)=>x.roleId),assignments})]);
}
const plan = () => json({plan:'按职责交付',contracts:[]});
beforeEach(async()=>{
  dir=mkdtempSync(join(tmpdir(),'pih-video-regression-'));
  core=await createHarnessCore({dataDir:dir,enableFaux:true});
  await call('settings:set',{defaultModel:fauxModelRef(),permissionMode:'bypass',autoApproveTools:[]});
  a=(await call('role:create',{name:'策划',preferredModel:fauxModelRef('a')})).id;
  b=(await call('role:create',{name:'剪辑',preferredModel:fauxModelRef('b')})).id;
});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
it('续作缩小本轮文件清单时仍保留原职责、未应用成果和下游交接',async()=>{
  const w=await call('workbench:create',{title:'视频',roleIds:[a,b]});
  route([assignment(a,['brief/','contracts/video.json'])]);
  ensureFauxRegistered('a').setResponses([plan(),tool('write',{path:'brief/brief.json',content:'15'}),tool('write',{path:'brief/README.md',content:'handoff'}),tool('write',{path:'contracts/video.json',content:JSON.stringify('contract')}),fauxAssistantMessage('完成')]);
  await call('workbench:send',{id:w.id,text:'制作15秒',requestId:'first'});
  await until(w.id,x=>['awaiting_review','error'].includes(x.phase));
  route([assignment(a,['brief/brief.json']),assignment(b,['delivery/'],[a])]);
  ensureFauxRegistered('a').setResponses([plan(),tool('write',{path:'brief/brief.json',content:'30'}),fauxAssistantMessage('30秒完成')]);
  let handed='';
  ensureFauxRegistered('b').setResponses([plan(),tool('read',{path:'brief/README.md'}),(ctx)=>{handed=JSON.stringify(ctx);return tool('write',{path:'delivery/result.txt',content:'30秒'});},fauxAssistantMessage('完成')]);
  await call('workbench:send',{id:w.id,text:'改成30秒，接续制作',requestId:'second'});
  const result=await until(w.id,x=>['awaiting_review','error'].includes(x.phase));
  expect(result.phase).toBe('awaiting_review');
  expect(handed).toContain('handoff');
  for(const roleId of [a,b]) {
    const review=await call('workbench:review',{id:w.id,roleId});
    expect(review.blockedReason).toBeFalsy();
    await call('workbench:apply',{id:w.id,roleId,reviewToken:review.token});
  }
  expect(readFileSync(join(dir,'personal/brief/brief.json'),'utf8')).toBe('30');
  expect(JSON.parse(readFileSync(join(dir,'personal/contracts/video.json'),'utf8'))).toBe('contract');
});
it('累计用量不停止工作；手动停止只终止活跃角色，已完成成果仍可审阅应用',async()=>{
  const w=await call('workbench:create',{title:'视频',roleIds:[a,b]});
  await call('workbench:setAccess',{id:w.id,roleId:b,commands:true,network:false,servers:[]});
  route([assignment(a,['brief/']),assignment(b,['delivery/'],[a])]);
  ensureFauxRegistered('a').setResponses([plan(),tool('write',{path:'brief/brief.json',content:'30'}),fauxAssistantMessage('完成')]);
  ensureFauxRegistered('b').setResponses([plan(),tool('workbench_command',{command:'echo pending'}),fauxAssistantMessage('完成')]);
  await call('workbench:send',{id:w.id,text:'制作',requestId:'stop'});
  const pending=await until(w.id,x=>x.participants.some((p:any)=>p.status==='waiting_approval'));
  expect(pending.participants.find((p:any)=>p.roleId===a)!.status).toBe('awaiting_review');
  core.workbench.onEvent({type:'task:stream',ts:Date.now(),payload:{taskId:pending.participants.find((p:any)=>p.roleId===b)!.taskId!,kind:'assistant_message_end',usage:{input:999999999,output:0}}});
  await new Promise(r=>setTimeout(r,30));
  expect(core.workbench.get(w.id).phase).toBe('running');
  expect(core.workbench.get(w.id).participants.find(p=>p.roleId===b)!.status).toBe('waiting_approval');
  await call('workbench:stop',{id:w.id});
  expect(core.workbench.get(w.id).participants.find(p=>p.roleId===a)!.status).toBe('awaiting_review');
  const review=await call('workbench:review',{id:w.id,roleId:a});
  await call('workbench:apply',{id:w.id,roleId:a,reviewToken:review.token});
  await call('workbench:stop',{id:w.id});
  expect(core.workbench.get(w.id).participants.find(p=>p.roleId===a)!.status).toBe('applied');
});
it.each(['workbench_command','workbench_plugin'])('缺少授权时停止当前角色循环，保留文件并明确提示，不运行后续模型或工具：%s',async(name)=>{
  const w=await call('workbench:create',{title:'权限',roleIds:[a]});
  route([assignment(a,['brief/'])]);
  let retried=false;
  ensureFauxRegistered('a').setResponses([plan(),tool('write',{path:'brief/partial.txt',content:'saved'}),tool(name,name==='workbench_command'?{command:'echo forbidden'}:{server:'ungranted'}),()=>{retried=true;return tool('write',{path:'brief/unsafe.txt',content:'unexpected'});},fauxAssistantMessage('完成')]);
  await call('workbench:send',{id:w.id,text:'制作',requestId:'denied'});
  const result=await until(w.id,x=>['stopped','error','awaiting_review'].includes(x.phase));
  expect(retried).toBe(false);
  expect(result.phase).toBe('stopped');
  expect(result.participants[0]!.status).toBe('blocked');
  expect(result.messages.some((m:any)=>m.text.includes('授权'))).toBe(true);
  const run=core.db.prepare('SELECT root FROM workbench_runs WHERE task_id=?').get(result.participants[0]!.taskId) as {root:string};
  expect(readFileSync(join(run.root,'brief/partial.txt'),'utf8')).toBe('saved');
  expect(existsSync(join(run.root,'brief/unsafe.txt'))).toBe(false);
});

it('旧版职责已收窄的未应用任务可恢复；从未授权的文件仍被拦截',async()=>{
  const w=await call('workbench:create',{title:'旧任务',roleIds:[a,b]});
  route([assignment(a,['brief/'])]);
  ensureFauxRegistered('a').setResponses([plan(),tool('write',{path:'brief/brief.json',content:'15'}),tool('write',{path:'brief/README.md',content:'preserve'}),fauxAssistantMessage('完成')]);
  await call('workbench:send',{id:w.id,text:'制作',requestId:'old1'});
  let current=await until(w.id,x=>x.phase==='awaiting_review');
  const oldTask=current.participants[0]!.taskId!;
  // Historical DB fixture: old host recorded a narrow scope despite restoring README.
  const evidence=await call('task:create',{roleId:a,title:'历史范围记录'});
  core.db.prepare('INSERT INTO workbench_runs SELECT ?,workbench_id,role_id,root,baseline,?,request_id,contract_versions FROM workbench_runs WHERE task_id=?').run(evidence.id,JSON.stringify(['brief/']),oldTask);
  core.db.prepare('UPDATE workbench_runs SET owned_paths=? WHERE task_id=?').run(JSON.stringify(['brief/brief.json']),oldTask);
  route([assignment(b,['brief/README.md'])]);
  await call('workbench:send',{id:w.id,text:'让其他角色接手旧文件',requestId:'overlap'});
  const overlap=await until(w.id,x=>x.phase==='error');
  expect(overlap.messages.at(-1)?.text).toContain('其他角色负责');
  route([assignment(a,['brief/brief.json'])]);
  ensureFauxRegistered('a').setResponses([plan(),tool('write',{path:'brief/brief.json',content:'30'}),fauxAssistantMessage('完成')]);
  await call('workbench:send',{id:w.id,text:'接续',requestId:'old2'});
  current=await until(w.id,x=>['awaiting_review','error'].includes(x.phase));
  expect(current.phase,JSON.stringify(current.messages.at(-1))).toBe('awaiting_review');
  const review=await call('workbench:review',{id:w.id,roleId:a});
  expect(review.blockedReason).toBeFalsy();
  const root=(core.db.prepare('SELECT root FROM workbench_runs WHERE task_id=?').get(current.participants[0]!.taskId) as {root:string}).root;
  const {writeFileSync}=await import('node:fs');
  writeFileSync(join(root,'not-owned.txt'),'tampered');
  route([assignment(a,['brief/brief.json'])]);
  ensureFauxRegistered('a').setResponses([plan(),fauxAssistantMessage('不得启动')]);
  await expect(call('workbench:send',{id:w.id,text:'继续',requestId:'old3'})).rejects.toThrow('职责外文件');
  expect(existsSync(join(dir,'personal/not-owned.txt'))).toBe(false);
});

it.skipIf(process.platform!=='darwin')('授权恢复复用已确认职责与隔离文件，不再路由或重新规划，仍等待操作审批',async()=>{
  const w=await call('workbench:create',{title:'授权恢复',roleIds:[a,b]});
  route([assignment(b,['design/']),assignment(a,['brief/'],[b])]);
  ensureFauxRegistered('b').setResponses([plan(),tool('write',{path:'design/spec.txt',content:'upstream-design'}),fauxAssistantMessage('完成')]);
  ensureFauxRegistered('a').setResponses([plan(),tool('write',{path:'brief/partial.txt',content:'saved'}),tool('workbench_command',{command:'echo blocked'})]);
  await call('workbench:send',{id:w.id,text:'完成文件',requestId:'initial'});
  const stopped=await until(w.id,x=>x.phase==='stopped');
  const originalTask=stopped.participants[0]!.taskId;
  const upstreamTask=stopped.participants.find((p:any)=>p.roleId===b)!.taskId;
  await expect(call('workbench:resume',{id:w.id,roleId:b,requestId:'wrong'})).rejects.toThrow();
  await expect(call('workbench:resume',{id:w.id,roleId:a,requestId:'ungranted'})).rejects.toThrow('权限');
  await call('workbench:setAccess',{id:w.id,roleId:a,commands:true,network:false,servers:[]});
  // Reproduce the intervening malformed routing round seen in production.
  ensureFauxRegistered().setResponses([fauxAssistantMessage('MALFORMED_ROUTER'),fauxAssistantMessage('MALFORMED_ROUTER')]);
  await call('workbench:send',{id:w.id,roleId:a,text:'继续检查新增要求',requestId:'malformed'});
  await until(w.id,x=>x.phase==='error');
  let routed=false,workerInput='';
  ensureFauxRegistered().setResponses([()=>{routed=true;return fauxAssistantMessage('must not route');}]);
  ensureFauxRegistered('a').setResponses([tool('read',{path:'brief/partial.txt'}),tool('read',{path:'design/spec.txt'}),(ctx)=>{workerInput=JSON.stringify(ctx);return tool('workbench_command',{command:'printf resumed > brief/resumed.txt'});},fauxAssistantMessage('完成')]);
  await call('workbench:resume',{id:w.id,roleId:a,requestId:'resume'});
  await call('workbench:resume',{id:w.id,roleId:a,requestId:'resume'});
  const pending=await until(w.id,x=>x.participants.some((p:any)=>p.status==='waiting_approval'));
  const taskId=pending.participants.find((p:any)=>p.roleId===a)!.taskId;
  const record=await call('task:get',{taskId});
  const run=core.db.prepare('SELECT root FROM workbench_runs WHERE task_id=?').get(taskId) as {root:string};
  expect(routed).toBe(false);expect(workerInput).toContain('saved');expect(workerInput).toContain('upstream-design');
  expect(readFileSync(join(run.root,'brief/partial.txt'),'utf8')).toBe('saved');
  expect(existsSync(join(run.root,'brief/resumed.txt'))).toBe(false);
  expect(pending.participants.find((p:any)=>p.roleId===b)!.taskId).toBe(upstreamTask);
  expect(taskId).not.toBe(originalTask);
  expect(record.pendingApprovals).toHaveLength(1);
  await call('approval:decide',{taskId,toolCallId:record.pendingApprovals[0].toolCallId,approved:true});
  await until(w.id,x=>x.phase==='awaiting_review');
  expect(readFileSync(join(run.root,'brief/resumed.txt'),'utf8')).toBe('resumed');
  await expect(call('workbench:resume',{id:w.id,roleId:a,requestId:'again'})).rejects.toThrow();
});
