import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {createHarnessCore,type HarnessCore} from '../core/harness-core.js';
import {ensureFauxRegistered,fauxModelRef} from '../pi/faux-provider.js';
let core:HarnessCore,dir:string,a:string,b:string;let revealedArtifact='',openedDocument='';
const json=(v:unknown)=>fauxAssistantMessage(JSON.stringify(v));
const tool=(name:string,args:Parameters<typeof fauxToolCall>[1])=>fauxAssistantMessage([fauxToolCall(name,args)]);
async function call(name:string,input:unknown={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result;}
async function until(id:string,p:(w:any)=>boolean){for(let i=0;i<500;i++){const w=core.workbench.get(id);if(p(w))return w;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');}
beforeEach(async()=>{revealedArtifact='';openedDocument='';dir=mkdtempSync(join(tmpdir(),'pih-kernel-'));core=await createHarnessCore({dataDir:dir,enableFaux:true,revealWorkbenchFile:path=>{revealedArtifact=path;},openWorkbenchDocument:async path=>{openedDocument=path;}});await call('settings:set',{defaultModel:fauxModelRef(),permissionMode:'bypass',autoApproveTools:[]});a=(await call('role:create',{name:'设计',preferredModel:fauxModelRef('a')})).id;b=(await call('role:create',{name:'前端',preferredModel:fauxModelRef('b')})).id;});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
function dispatch(){ensureFauxRegistered().setResponses([json({reply:'设计后前端',action:'dispatch',roleIds:[a,b],assignments:[{roleId:a,instructions:'输出设计',files:['design/'],dependsOn:[]},{roleId:b,instructions:'依据设计实现',files:['site/'],dependsOn:[a]}]})]);}
it('continues a stopped downstream after restart without routing or replanning, preserves upstream and deletes host records with the workbench',async()=>{
 const w=await call('workbench:create',{title:'网站',roleIds:[a,b]});dispatch();
 ensureFauxRegistered('a').setResponses([json({plan:'设计',contracts:[]}),tool('write',{path:'design/spec.txt',content:'design-v1'}),fauxAssistantMessage('完成')]);
 ensureFauxRegistered('b').setResponses([json({plan:'前端',contracts:[]}),tool('write',{path:'site/partial.txt',content:'saved'}),tool('workbench_command',{command:'echo blocked'})]);
 await call('workbench:send',{id:w.id,text:'开发网站',requestId:'first'});let stopped=await until(w.id,x=>x.phase==='stopped');
 const upstream=stopped.participants.find((p:any)=>p.roleId===a)!.taskId;
 delete stopped.roundProgress;core.db.prepare('UPDATE workbenches SET body=? WHERE id=?').run(JSON.stringify(stopped),w.id);
 await call('workbench:setAccess',{id:w.id,roleId:b,commands:true,network:false,servers:[]});
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 let rerouted=false,replanned=false,input='';
 ensureFauxRegistered().setResponses([()=>{rerouted=true;return fauxAssistantMessage('must not route');}]);
 ensureFauxRegistered('a').setResponses([()=>{replanned=true;return fauxAssistantMessage('must not wake upstream');}]);
 ensureFauxRegistered('b').setResponses([tool('read',{path:'site/partial.txt'}),tool('read',{path:'design/spec.txt'}),ctx=>{input=JSON.stringify(ctx);return tool('write',{path:'site/result.txt',content:'done'});},fauxAssistantMessage('完成')]);
 await call('workbench:send',{id:w.id,text:'继续',requestId:'continue'});
 const result=await until(w.id,x=>['awaiting_review','error'].includes(x.phase));
 expect(result.phase).toBe('awaiting_review');expect(rerouted).toBe(false);expect(replanned).toBe(false);expect(input).toContain('saved');expect(input).toContain('design-v1');
 expect(result.participants.find((p:any)=>p.roleId===a)!.taskId).toBe(upstream);
 const down=result.participants.find((p:any)=>p.roleId===b)!,receipt=core.db.prepare('SELECT body FROM workbench_run_receipts WHERE task_id=?').get(down.taskId) as {body:string};
 expect(JSON.parse(receipt.body).inputs[0]).toMatchObject({roleId:a,taskId:upstream});
 await call('workbench:send',{id:w.id,text:'继续',requestId:'finished'});expect(rerouted).toBe(false);
 await call('workbench:delete',{id:w.id});
 expect(core.db.prepare('SELECT * FROM workbench_plans').all()).toHaveLength(0);expect(core.db.prepare('SELECT * FROM workbench_run_receipts').all()).toHaveLength(0);
});
it('accepts minimal native structured planning and registers objective file evidence',async()=>{
 const w=await call('workbench:create',{title:'原生规划',roleIds:[a]});
 ensureFauxRegistered().setResponses([tool('submit_workbench_plan',{reply:'执行设计',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'生成JSON',files:['design/'],outputs:['design/content.json'],dependsOn:[]}]})]);
 ensureFauxRegistered('a').setResponses([tool('submit_role_plan',{plan:'产出内容文件',contracts:[]}),tool('write',{path:'design/content.json',content:'{"projects":[]}'}),fauxAssistantMessage('完成')]);
 await call('workbench:send',{id:w.id,text:'执行设计',requestId:'native'});
 const result=await until(w.id,x=>['awaiting_review','error'].includes(x.phase));expect(result.phase).toBe('awaiting_review');
 expect(result.participants[0]!.deliverables).toEqual([{path:'design/content.json',format:'json'}]);
 expect(result.participants[0]!.deliveryCheck?.status).toBe('passed');
});
it('uses a standard shared business schema separately from dispatch, and repairs only the failed producer on continuation',async()=>{
 const w=await call('workbench:create',{title:'数据接口',roleIds:[a,b]});
 ensureFauxRegistered().setResponses([tool('submit_workbench_plan',{reply:'设计后文档',action:'dispatch',assignments:[{roleId:a,instructions:'提供JSON数据',files:['data/'],outputs:['data/content.json'],dependsOn:[]},{roleId:b,instructions:'根据数据生成文档',files:['docs/'],outputs:['docs/result.md'],dependsOn:[a]}]})]);
 ensureFauxRegistered('a').setResponses([tool('submit_role_plan',{plan:'提供版本字段',contracts:[{id:'content-format',title:'内容数据',roles:[a,b],content:{$id:'data/content.json',type:'object',required:['version'],properties:{version:{type:'string'}}}}]}),tool('write',{path:'data/content.json',content:'{}'}),fauxAssistantMessage('声明结束')]);
 ensureFauxRegistered('b').setResponses([tool('submit_role_plan',{plan:'生成文档',contracts:[]})]);
 await call('workbench:send',{id:w.id,text:'开发数据接口',requestId:'schema'});
 let state=await until(w.id,x=>['error','stopped'].includes(x.phase));
 expect(state.participants.find((p:any)=>p.roleId===b)!.taskId).toBeNull();
 expect(state.participants.find((p:any)=>p.roleId===a)!.deliveryCheck?.status).toBe('failed');
 let routed=false;ensureFauxRegistered().setResponses([()=>{routed=true;return fauxAssistantMessage('must not route');}]);
 ensureFauxRegistered('a').setResponses([tool('write',{path:'data/content.json',content:'{"version":"1"}'}),fauxAssistantMessage('修正结束')]);
 ensureFauxRegistered('b').setResponses([tool('read',{path:'data/content.json'}),tool('write',{path:'docs/result.md',content:'已经核对版本字段'}),fauxAssistantMessage('完成')]);
 await call('workbench:send',{id:w.id,text:'请继续',requestId:'fix-producer'});
 state=await until(w.id,x=>['awaiting_review','error'].includes(x.phase));expect(state.phase).toBe('awaiting_review');expect(routed).toBe(false);
 expect(state.participants.every((p:any)=>p.deliveryCheck?.status==='passed')).toBe(true);
});
it('keeps confirmed checks when later routing and planning emit malformed declarations',async()=>{
 const w=await call('workbench:create',{title:'已确认契约',roleIds:[a]});
 const fixed={path:'data/result.json',format:'json',schema:{type:'object',required:['version'],properties:{version:{const:'1'}}}};
 ensureFauxRegistered().setResponses([json({reply:'执行',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'生成数据',files:['data/'],dependsOn:[],deliverables:[fixed]}]})]);
 ensureFauxRegistered('a').setResponses([json({plan:'执行',contracts:[]}),tool('write',{path:'data/result.json',content:'{"version":"1"}'}),fauxAssistantMessage('结束')]);
 await call('workbench:send',{id:w.id,text:'生成数据',requestId:'fixed'});await until(w.id,x=>x.phase==='awaiting_review');
 const invalid={path:'data/result.json',format:'json',fields:[{pointer:'/',required:true}]};
 ensureFauxRegistered().setResponses([json({reply:'修改',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'更新说明',files:['data/'],dependsOn:[],deliverables:[invalid]}]})]);
 ensureFauxRegistered('a').setResponses([json({plan:'只修改内容',contracts:[],deliverables:[invalid]}),tool('write',{path:'data/result.json',content:'{"version":"wrong"}'}),fauxAssistantMessage('结束')]);
 await call('workbench:send',{id:w.id,text:'更新数据说明',requestId:'preserve'});
 const state=await until(w.id,x=>['awaiting_review','error'].includes(x.phase));expect(state.phase).toBe('awaiting_review');
 expect(state.participants[0]!.deliverables).toEqual([fixed]);expect(state.participants[0]!.deliveryCheck?.status).toBe('failed');
});
it('pins actual input versions and marks only consumers stale when an upstream artifact changes',async()=>{
 const c=(await call('role:create',{name:'独立研究',preferredModel:fauxModelRef('c')})).id;
 const w=await call('workbench:create',{title:'版本交接',roleIds:[a,b,c]});
 ensureFauxRegistered().setResponses([json({reply:'分工',action:'dispatch',roleIds:[a,b,c],assignments:[{roleId:a,instructions:'设计',files:['design/'],dependsOn:[]},{roleId:b,instructions:'实现',files:['site/'],dependsOn:[a]},{roleId:c,instructions:'研究',files:['research/'],dependsOn:[]}]})]);
 ensureFauxRegistered('a').setResponses([json({plan:'设计',contracts:[]}),tool('write',{path:'design/spec.txt',content:'v1'}),fauxAssistantMessage('结束')]);
 ensureFauxRegistered('b').setResponses([json({plan:'实现',contracts:[]}),tool('read',{path:'design/spec.txt'}),tool('write',{path:'site/index.txt',content:'uses v1'}),fauxAssistantMessage('结束')]);
 ensureFauxRegistered('c').setResponses([json({plan:'研究',contracts:[]}),tool('write',{path:'research/result.txt',content:'independent'}),fauxAssistantMessage('结束')]);
 await call('workbench:send',{id:w.id,text:'开始',requestId:'versions'});let state=await until(w.id,x=>x.phase==='awaiting_review');
 const consumer=state.participants.find((p:any)=>p.roleId===b)!.taskId,independent=state.participants.find((p:any)=>p.roleId===c)!.taskId;
 const producer=state.participants.find((p:any)=>p.roleId===a)!.taskId;
 const root=(core.db.prepare('SELECT root FROM workbench_runs WHERE task_id=?').get(producer) as {root:string}).root;
 writeFileSync(join(root,'design/spec.txt'),'external-change');
 expect((await call('workbench:review',{id:w.id,roleId:b})).blockedReason).toContain('版本已变化');
 // Restore the registered artifact, then make a normal explicit upstream modification.
 writeFileSync(join(root,'design/spec.txt'),'v1');
 ensureFauxRegistered().setResponses([json({reply:'只改设计',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'更新设计到v2',files:['design/'],dependsOn:[]}]})]);
 ensureFauxRegistered('a').setResponses([json({plan:'更新',contracts:[]}),tool('write',{path:'design/spec.txt',content:'v2'}),fauxAssistantMessage('结束')]);
 await call('workbench:send',{id:w.id,text:'只更新设计方案',requestId:'v2'});state=await until(w.id,x=>x.phase==='awaiting_review');
 expect(state.participants.find((p:any)=>p.roleId===b)).toMatchObject({taskId:consumer,status:'needs_update'});
 expect(state.participants.find((p:any)=>p.roleId===c)).toMatchObject({taskId:independent,status:'awaiting_review'});
});
it('replans only after a user-confirmed business interface change and binds its new schema version',async()=>{
 const w=await call('workbench:create',{title:'接口变更',roleIds:[a]});
 const schema=(version:string)=>({$id:'data/result.json',type:'object',required:['version'],properties:{version:{const:version}}});
 const decision=()=>tool('submit_workbench_plan',{reply:'更新数据',action:'dispatch',assignments:[{roleId:a,instructions:'按已确认接口产出数据',files:['data/'],outputs:['data/result.json'],dependsOn:[]}]});
 ensureFauxRegistered().setResponses([decision()]);
 ensureFauxRegistered('a').setResponses([tool('submit_role_plan',{plan:'建立接口',contracts:[{id:'data-api',title:'数据接口',roles:[a],content:schema('1')}]}),tool('write',{path:'data/result.json',content:'{"version":"1"}'}),fauxAssistantMessage('结束')]);
 await call('workbench:send',{id:w.id,text:'建立接口',requestId:'api1'});await until(w.id,x=>x.phase==='awaiting_review');
 await call('workbench:propose',{id:w.id,roleId:a,contractId:'data-api',baseVersion:1,content:JSON.stringify(schema('2')),reason:'用户确认升级版本'});
 let state=core.workbench.get(w.id);
 await call('workbench:choose',{id:w.id,proposalId:state.proposals.at(-1)!.id,revision:state.revision});
 let routed=0;ensureFauxRegistered().setResponses([()=>{routed++;return decision();}]);
 ensureFauxRegistered('a').setResponses([tool('submit_role_plan',{plan:'按新版本更新',contracts:[]}),tool('write',{path:'data/result.json',content:'{"version":"2"}'}),fauxAssistantMessage('结束')]);
 await call('workbench:send',{id:w.id,text:'继续',requestId:'api2'});
 state=await until(w.id,x=>['awaiting_review','error'].includes(x.phase));expect(state.phase).toBe('awaiting_review');expect(routed).toBe(1);
 expect(state.participants[0]!.deliveryCheck?.status).toBe('passed');expect(state.participants[0]!.deliverables?.[0]?.schema).toMatchObject({properties:{version:{const:'2'}}});
});
it('does not resume an older completed plan when a newer unconfirmed implementation plan failed',async()=>{
 const w=await call('workbench:create',{title:'规划边界',roleIds:[a]});
 const decision=()=>json({reply:'执行',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'完成文档',files:['docs/'],dependsOn:[]}]});
 ensureFauxRegistered().setResponses([decision()]);ensureFauxRegistered('a').setResponses([json({plan:'文档',contracts:[]}),tool('write',{path:'docs/result.txt',content:'done'}),fauxAssistantMessage('结束')]);
 await call('workbench:send',{id:w.id,text:'完成文档',requestId:'done'});await until(w.id,x=>x.phase==='awaiting_review');
 ensureFauxRegistered().setResponses([decision()]);ensureFauxRegistered('a').setResponses([fauxAssistantMessage('bad plan'),fauxAssistantMessage('bad plan')]);
 await call('workbench:send',{id:w.id,text:'新增一份实现说明',requestId:'unconfirmed'});await until(w.id,x=>x.phase==='error');
 await expect(call('workbench:send',{id:w.id,text:'继续',requestId:'no-old-replay'})).rejects.toThrow('尚未确认');
});
it('does not revive an old plan after a new routing failure, while history questions remain read-only',async()=>{
 const w=await call('workbench:create',{title:'需求边界',roleIds:[a]});
 ensureFauxRegistered().setResponses([json({reply:'执行',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'写文档',files:['docs/'],dependsOn:[]}]})]);
 ensureFauxRegistered('a').setResponses([json({plan:'写文档',contracts:[]}),tool('write',{path:'docs/result.txt',content:'original'}),fauxAssistantMessage('结束')]);
 await call('workbench:send',{id:w.id,text:'写文档',requestId:'original'});await until(w.id,x=>x.phase==='awaiting_review');
 ensureFauxRegistered().setResponses([fauxAssistantMessage('invalid'),fauxAssistantMessage('invalid')]);
 await call('workbench:send',{id:w.id,text:'新增一个页面',requestId:'failed-new'});await until(w.id,x=>x.phase==='error');
 await expect(call('workbench:send',{id:w.id,text:'继续',requestId:'no-guess'})).rejects.toThrow('尚未确认');
 ensureFauxRegistered().setResponses([json({reply:'仅总结已有文档',action:'clarify',roleIds:[],assignments:[]})]);
 await call('workbench:send',{id:w.id,text:'之前做了什么',requestId:'history'});
 await until(w.id,x=>x.messages.some((m:any)=>m.requestId==='history'&&m.kind==='reply'));
 expect(core.db.prepare('SELECT COUNT(*) n FROM tasks').get()).toEqual({n:1});
});
it.each(['waiting_approval','waiting_user'] as const)('marks a persisted %s role interrupted on startup without replay or changing finished roles',async(status)=>{
 const w=await call('workbench:create',{title:'异常退出恢复',roleIds:[a,b]});
 w.phase='running';w.participants[0].status=status;w.participants[1].status='awaiting_review';
 core.db.prepare('UPDATE workbenches SET body=? WHERE id=?').run(JSON.stringify(w),w.id);
 await core.shutdown();let requested=false;ensureFauxRegistered('a').setResponses([()=>{requested=true;return fauxAssistantMessage('must not replay');}]);
 core=await createHarnessCore({dataDir:dir,enableFaux:true});
 const restored=await call('workbench:get',{id:w.id});
 expect(restored.phase).toBe('stopped');expect(restored.participants[0].status).toBe('interrupted');
 expect(restored.participants[1].status).toBe('awaiting_review');expect(requested).toBe(false);
});
it('opens only current role-owned artifacts without applying them or running models, and closes previews on deletion',async()=>{
 const w=await call('workbench:create',{title:'网页成果',roleIds:[a,b]});
 ensureFauxRegistered().setResponses([tool('submit_workbench_plan',{reply:'制作网页',action:'dispatch',assignments:[{roleId:a,instructions:'输出网页',files:['site/'],outputs:['site/index.html'],dependsOn:[]}]})]);
 ensureFauxRegistered('a').setResponses([tool('submit_role_plan',{plan:'制作网页',contracts:[]}),tool('write',{path:'site/index.html',content:'<!doctype html><h1>角色成果</h1>'}),fauxAssistantMessage('完成')]);
 await call('workbench:send',{id:w.id,text:'制作网页',requestId:'web'});await until(w.id,x=>x.phase==='awaiting_review');
 const review=await call('workbench:review',{id:w.id,roleId:a}),count=core.db.prepare('SELECT count(*) n FROM workbench_model_calls').get();
 const args={id:w.id,roleId:a,token:review.token,path:'site/index.html'};
 const {url}=await call('workbench:preview',args);const auth=await fetch(url,{redirect:'manual'}),cookie=auth.headers.get('set-cookie')!.split(';')[0];
 const target=new URL(url);target.search='';expect(await(await fetch(target,{headers:{cookie}})).text()).toContain('角色成果');
 expect(core.workbench.get(w.id).participants[0]!.status).toBe('awaiting_review');expect(core.db.prepare('SELECT count(*) n FROM workbench_model_calls').get()).toEqual(count);
 await expect(call('workbench:preview',{...args,roleId:b})).rejects.toThrow();
 await expect(call('workbench:preview',{...args,path:'../private.html'})).rejects.toThrow();
 await expect(call('workbench:revealFile',{...args,token:'old'})).rejects.toThrow('已变化');
 expect(core.workbench.artifactFile(w.id,a,review.token,'site/index.html').path).toContain('site/index.html');
 expect(await call('workbench:revealFile',args)).toEqual({ok:true});expect(revealedArtifact).toContain('site/index.html');
 await call('workbench:delete',{id:w.id});await expect(fetch(target,{headers:{cookie}})).rejects.toThrow();
});

it('opens Office files only through the role and version checked read-only document adapter',async()=>{
 const w=await call('workbench:create',{title:'文档成果',roleIds:[a,b]});
 ensureFauxRegistered().setResponses([tool('submit_workbench_plan',{reply:'制作文档',action:'dispatch',assignments:[{roleId:a,instructions:'交付文档',files:['docs/'],outputs:['docs/report.docx'],dependsOn:[]}]})]);
 ensureFauxRegistered('a').setResponses([tool('submit_role_plan',{plan:'文档',contracts:[]}),tool('write',{path:'docs/report.docx',content:'fixture'}),tool('write',{path:'docs/run.sh',content:'echo never-execute'}),fauxAssistantMessage('完成')]);
 await call('workbench:send',{id:w.id,text:'制作文档',requestId:'doc'});await until(w.id,x=>x.phase==='awaiting_review');
 const review=await call('workbench:review',{id:w.id,roleId:a}),args={id:w.id,roleId:a,token:review.token,path:'docs/report.docx'};
 await expect(call('workbench:openDocument',{...args,roleId:b})).rejects.toThrow();expect(openedDocument).toBe('');
 await expect(call('workbench:openDocument',{...args,token:'old'})).rejects.toThrow();
 await expect(call('workbench:openDocument',{...args,path:'docs/run.sh'})).rejects.toThrow();expect(openedDocument).toBe('');
 expect(await call('workbench:openDocument',args)).toEqual({ok:true});expect(openedDocument).toContain('docs/report.docx');
 expect(core.workbench.get(w.id).phase).toBe('awaiting_review');
 const {url}=await call('workbench:preview',{...args,download:true});const cookie=await fetch(url,{redirect:'manual'}).then(r=>r.headers.get('set-cookie')!.split(';')[0]);const target=new URL(url);target.search='';const file=await fetch(target,{headers:{cookie}});expect(file.headers.get('content-disposition')).toContain('attachment');expect(await file.text()).toBe('fixture');
});

it('includes nested built website outputs in delivery receipts and the artifact viewer without copying source caches',async()=>{
 const w=await call('workbench:create',{title:'构建网页',roleIds:[a,b]});
 ensureFauxRegistered().setResponses([tool('submit_workbench_plan',{reply:'交付静态构建',action:'dispatch',assignments:[{roleId:a,instructions:'生成构建文件',files:['dist/'],outputs:['dist/index.html','dist/assets/main.css'],dependsOn:[]}]})]);
 ensureFauxRegistered('a').setResponses([tool('submit_role_plan',{plan:'生成文件',contracts:[]}),tool('write',{path:'dist/index.html',content:'<link rel="stylesheet" href="/assets/main.css"><h1>Built website</h1>'}),tool('write',{path:'dist/assets/main.css',content:'body{color:green}'}),fauxAssistantMessage('完成')]);
 await call('workbench:send',{id:w.id,text:'生成静态构建',requestId:'dist'});await until(w.id,x=>{if(['error','stopped'].includes(x.phase))throw Error(JSON.stringify(x.messages.slice(-2)));return x.phase==='awaiting_review';});
 const review=await call('workbench:review',{id:w.id,roleId:a});expect(review.files.map((f:any)=>f.path)).toEqual(['dist/assets/main.css','dist/index.html']);
 const {url}=await call('workbench:preview',{id:w.id,roleId:a,token:review.token,path:'dist/index.html'});const cookie=(await fetch(url,{redirect:'manual'})).headers.get('set-cookie')!.split(';')[0];expect(await(await fetch(new URL(url).origin+'/assets/main.css',{headers:{cookie}})).text()).toBe('body{color:green}');
});
