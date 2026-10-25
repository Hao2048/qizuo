import * as workspace from "./workspace.js";
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
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
afterEach(async()=>{vi.restoreAllMocks();await core.shutdown();rmSync(dir,{recursive:true,force:true});});
const output={path:'brief/brief.json',format:'json',fields:[{pointer:'/duration',type:'number',equals:30}]} as const;
it.each(['missing','empty','json','field'])('upstream completion with %s output never starts downstream execution',async(kind)=>{
 const w=await call('workbench:create',{title:'交付检查',roleIds:[a,b]});
 route([{...assignment(a,['brief/']),deliverables:[output]},assignment(b,['delivery/'],[a])]);
 const writes=kind==='missing'?[]:[tool('write',{path:'brief/brief.json',content:kind==='empty'?'':kind==='json'?'{broken':'{"duration":15}'})];
 ensureFauxRegistered('a').setResponses([plan(),...writes,fauxAssistantMessage('我完成了')]);
 let ran=false;ensureFauxRegistered('b').setResponses([plan(),()=>{ran=true;return fauxAssistantMessage('不应该执行');}]);
 await call('workbench:send',{id:w.id,text:'制作30秒内容',requestId:'invalid'});
 const state=await until(w.id,x=>x.phase==='error');
 expect(ran).toBe(false);expect(state.participants.find((p:any)=>p.roleId===b)).toMatchObject({status:'blocked',taskId:null});
 expect(state.participants.find((p:any)=>p.roleId===a)?.deliveryCheck?.status).toBe('failed');
 expect(state.messages.at(-1)?.text).toContain('修复交付物');
 const review=await call('workbench:review',{id:w.id,roleId:a});
 await expect(call('workbench:apply',{id:w.id,roleId:a,reviewToken:review.token})).rejects.toThrow('交付物检查未通过');
});
it('copies validated artifacts before starting downstream and persists receipts across restart',async()=>{
 const w=await call('workbench:create',{title:'正常交接',roleIds:[a,b]});
 route([{...assignment(a,['brief/']),deliverables:[output]},assignment(b,['delivery/'],[a])]);
 ensureFauxRegistered('a').setResponses([plan(),tool('write',{path:'brief/brief.json',content:'{"duration":30}'}),fauxAssistantMessage('完成')]);
 let handed='';ensureFauxRegistered('b').setResponses([plan(),tool('read',{path:'brief/brief.json'}),ctx=>{handed=JSON.stringify(ctx);return tool('write',{path:'delivery/result.txt',content:'read actual input'});},fauxAssistantMessage('完成')]);
 await call('workbench:send',{id:w.id,text:'制作30秒内容',requestId:'valid'});
 const state=await until(w.id,x=>['awaiting_review','error'].includes(x.phase));expect(state.phase).toBe('awaiting_review');expect(handed).toContain('30');
 expect(state.participants[0]?.deliveryCheck).toMatchObject({status:'passed',files:[{path:'brief/brief.json'}]});
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 expect(core.workbench.get(w.id).participants[0]!.deliveryCheck?.status).toBe('passed');
});
it('a worker cannot weaken the coordinator exact-value requirement in its plan',async()=>{
 const w=await call('workbench:create',{title:'约定冲突',roleIds:[a,b]});
 route([{...assignment(a,['brief/']),deliverables:[output]},assignment(b,['delivery/'],[a])]);
 ensureFauxRegistered('a').setResponses([json({plan:'改成15秒',contracts:[],deliverables:[{...output,fields:[{pointer:'/duration',equals:15}]}]})]);
 await call('workbench:send',{id:w.id,text:'制作30秒内容',requestId:'conflict'});
 const state=await until(w.id,x=>x.phase==='error');expect(state.messages.at(-1)?.text).toContain('分工不一致');
 expect(state.participants.every((p:any)=>p.taskId===null)).toBe(true);
});
it('does not start the consumer if the isolated copied artifact differs from the validated source',async()=>{
 const w=await call('workbench:create',{title:'复制一致性',roleIds:[a,b]});
 route([{...assignment(a,['brief/']),deliverables:[output]},assignment(b,['delivery/'],[a])]);
 ensureFauxRegistered('a').setResponses([plan(),tool('write',{path:'brief/brief.json',content:'{"duration":30}'}),fauxAssistantMessage('完成')]);
 let ran=false;ensureFauxRegistered('b').setResponses([plan(),()=>{ran=true;return fauxAssistantMessage('不能开始');}]);
 const apply=workspace.applyWorkspace;
 vi.spyOn(workspace,'applyWorkspace').mockImplementation((root,target,base,owned)=>{
  const paths=apply(root,target,base,owned);
  if(target.includes('/'+b+'/'))writeFileSync(join(target,'brief/brief.json'),'{"duration":15}');
  return paths;
 });
 await call('workbench:send',{id:w.id,text:'制作',requestId:'copy-race'});
 const state=await until(w.id,x=>x.phase==='error');expect(ran).toBe(false);expect(state.messages.at(-1)?.text).toContain('复制期间发生变化');
 expect(state.participants.find((p:any)=>p.roleId===b)).toMatchObject({status:'blocked',taskId:null});
});
it('rechecks changed artifacts at application rather than accepting a saved passed receipt',async()=>{
 const w=await call('workbench:create',{title:'应用复查',roleIds:[a]});
 route([{...assignment(a,['brief/']),deliverables:[output]}]);
 ensureFauxRegistered('a').setResponses([plan(),tool('write',{path:'brief/brief.json',content:'{"duration":30}'}),fauxAssistantMessage('完成')]);
 await call('workbench:send',{id:w.id,text:'制作',requestId:'recheck'});
 const state=await until(w.id,x=>x.phase==='awaiting_review');expect(state.participants[0]?.deliveryCheck?.status).toBe('passed');
 const run=core.db.prepare('SELECT root FROM workbench_runs WHERE task_id=?').get(state.participants[0]!.taskId) as {root:string};
 writeFileSync(join(run.root,'brief/brief.json'),'{"duration":15}');
 const review=await call('workbench:review',{id:w.id,roleId:a});
 await expect(call('workbench:apply',{id:w.id,roleId:a,reviewToken:review.token})).rejects.toThrow('交付物检查未通过');
 expect(existsSync(join(dir,'personal/brief/brief.json'))).toBe(false);
});
