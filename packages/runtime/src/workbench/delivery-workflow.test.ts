import{afterEach,beforeEach,expect,it}from'vitest';import{mkdtempSync,rmSync,readFileSync,existsSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{fauxAssistantMessage,fauxToolCall}from'@earendil-works/pi-ai';import{createHarnessCore,type HarnessCore}from'../core/harness-core.js';import{ensureFauxRegistered,fauxModelRef}from'../pi/faux-provider.js';import{deliveryToken}from'./delivery-submit.js';
let core:HarnessCore,dir:string,a:string,b:string;const json=(v:unknown)=>fauxAssistantMessage(JSON.stringify(v));const tool=(name:string,args:any)=>fauxAssistantMessage([fauxToolCall(name,args)]);
async function call(name:string,input:any={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result;}
async function end(id:string){for(let i=0;i<500;i++){const w=core.workbench.get(id);if(w.phase==='error')throw Error(w.messages.at(-1)?.text);if(w.phase==='awaiting_review'||w.phase==='stopped')return w;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'pih-delivery-flow-'));core=await createHarnessCore({dataDir:dir,enableFaux:true});await call('settings:set',{defaultModel:fauxModelRef(),permissionMode:'auto_edit',autoApproveTools:['read']});a=(await call('role:create',{name:'研究员',systemPrompt:'PRIVATE_RESEARCH',preferredModel:fauxModelRef('a')})).id;b=(await call('role:create',{name:'产品经理',systemPrompt:'PRIVATE_PRODUCT',preferredModel:fauxModelRef('b')})).id;});afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
function token(w:string,r:string,owned:string[]){const p=core.workbench.get(w).participants.find(p=>p.roleId===r)!;return deliveryToken(p.taskId!,owned,p.deliverables??[]);}
it('SDK tools reject a schema error, return precise feedback, then submit safely and hand off only the valid artifact',async()=>{
 const w=await call('workbench:create',{title:'产品交付',roleIds:[a,b]});
 ensureFauxRegistered().setResponses([json({reply:'先研究后文档',action:'dispatch',roleIds:[a,b],assignments:[{roleId:a,instructions:'产出研究JSON',files:['research.json'],dependsOn:[],deliverables:[{path:'research.json',format:'json',schema:{type:'object',required:['version'],additionalProperties:false,properties:{version:{type:'string'}}}}]},{roleId:b,instructions:'依赖研究写文档',files:['PRD.md'],dependsOn:[a],deliverables:[{path:'PRD.md',format:'text',sections:[{id:'mvp',title:'MVP范围'}]}]}]})]);
 let feedback='',downstream='';ensureFauxRegistered('a').setResponses([json({plan:'按宿主契约',contracts:[],deliverables:[{path:'research.json',format:'json',fields:[{pointer:'/invented',type:'string'}]}]}),tool('tool_search',{query:'workbench_delivery_contract',limit:1}),tool('workbench_delivery_contract',{}),tool('tool_search',{query:'workbench_submit_deliverable',limit:1}),()=>tool('workbench_submit_deliverable',{path:'research.json',contractToken:token(w.id,a,['research.json']),format:'json',data:{version:7}}),ctx=>{feedback=JSON.stringify(ctx);return tool('workbench_submit_deliverable',{path:'research.json',contractToken:token(w.id,a,['research.json']),format:'json',data:{version:'1.0'}});},fauxAssistantMessage('私有收尾 PRIVATE_RESEARCH')]);
 ensureFauxRegistered('b').setResponses([json({plan:'只使用公开研究交接',contracts:[]}),ctx=>{downstream=JSON.stringify(ctx);return tool('read',{path:'research.json'});},tool('tool_search',{query:'workbench_submit_deliverable',limit:1}),()=>tool('workbench_submit_deliverable',{path:'PRD.md',contractToken:token(w.id,b,['PRD.md']),format:'sections',sections:[{id:'mvp',content:'根据实际研究确定首版范围。'}]}),fauxAssistantMessage('私有收尾 PRIVATE_PRODUCT')]);
 await call('workbench:send',{id:w.id,text:'执行研究与PRD',requestId:'submit'});const state=await end(w.id);expect(state.phase).toBe('awaiting_review');expect(feedback).toContain('TYPE_MISMATCH');expect(feedback).toContain('/version');expect(downstream).not.toContain('PRIVATE_RESEARCH');expect(JSON.stringify(state.messages)).not.toMatch(/PRIVATE_RESEARCH|PRIVATE_PRODUCT/);expect(state.participants.every(p=>p.deliveryCheck?.status==='passed')).toBe(true);
 for(const p of state.participants){const r=await call('workbench:review',{id:w.id,roleId:p.roleId});await call('workbench:apply',{id:w.id,roleId:p.roleId,reviewToken:r.token});}
 expect(JSON.parse(readFileSync(join(dir,'personal/research.json'),'utf8'))).toEqual({version:'1.0'});expect(readFileSync(join(dir,'personal/PRD.md'),'utf8')).toContain('## MVP范围');expect(existsSync(join(dir,'personal','invented'))).toBe(false);
 const task=state.participants[0]!.taskId!;await expect(core.workbench.toolsFor(task).find(t=>t.name==='workbench_submit_deliverable')!.execute('late',{path:'research.json',contractToken:token(w.id,a,['research.json']),format:'json',data:{version:'2'}},undefined,undefined as never,undefined as never)).rejects.toThrow('暂停');
});
it('ask mode requires real approval for structured writes; denial leaves the artifact absent',async()=>{
 await call('settings:set',{permissionMode:'ask',autoApproveTools:[]});const w=await call('workbench:create',{title:'写入审批',roleIds:[a]});
 ensureFauxRegistered().setResponses([json({reply:'只交付JSON',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'提交JSON',files:['result.json'],dependsOn:[],deliverables:[{path:'result.json',format:'json'}]}]})]);
 ensureFauxRegistered('a').setResponses([json({plan:'受控提交',contracts:[]}),tool('tool_search',{query:'workbench_submit_deliverable',limit:1}),()=>tool('workbench_submit_deliverable',{path:'result.json',contractToken:token(w.id,a,['result.json']),format:'json',data:{safe:true}}),fauxAssistantMessage('尊重拒绝，不再尝试其他写入')]);
 await call('workbench:send',{id:w.id,text:'执行提交JSON',requestId:'approval'});let pending:any;
 for(let i=0;i<300;i++){const p=core.workbench.get(w.id).participants[0];if(p?.taskId){const t=await call('task:get',{taskId:p.taskId});if(t.pendingApprovals.length){pending={taskId:p.taskId,approval:t.pendingApprovals[0]};break;}}await new Promise(r=>setTimeout(r,10));}
 expect(pending.approval.toolName).toBe('workbench_submit_deliverable');expect(pending.approval.summary).toContain('提交交付文件');await call('approval:decide',{taskId:pending.taskId,toolCallId:pending.approval.toolCallId,approved:false});await end(w.id);
 const run=core.db.prepare('SELECT root FROM workbench_runs WHERE task_id=?').get(pending.taskId)as{root:string};expect(existsSync(join(run.root,'result.json'))).toBe(false);expect(existsSync(join(dir,'personal/result.json'))).toBe(false);
});
it('reads legacy empty format-specific arrays compatibly without changing real field constraints',async()=>{
 const w=await call('workbench:create',{title:'旧契约',roleIds:[a]});w.participants[0].deliverables=[{path:'result.json',format:'json',fields:[{pointer:'/version',equals:'1.0',legacyNote:'ignored'}],includes:[],schema:{unsupportedOldNote:true},legacyAnnotation:'ignored'}];core.db.prepare('UPDATE workbenches SET body=? WHERE id=?').run(JSON.stringify(w),w.id);
 const listing=await call('workbench:list',{});expect(listing.items.find((x:any)=>x.id===w.id).participants[0].deliverables).toEqual([{path:'result.json',format:'json',fields:[{pointer:'/version',equals:'1.0'}]}]);const got=await call('workbench:get',{id:w.id});expect(got.participants[0].deliverables).toEqual([{path:'result.json',format:'json',fields:[{pointer:'/version',equals:'1.0'}]}]);
});
it('repairs malformed read-only planning declarations before starting a worker, without rerouting or sharing private text',async()=>{
 const w=await call('workbench:create',{title:'个人网页制作',roleIds:[a,b]});let routingCalls=0,planningCalls=0,repairContext='';
 ensureFauxRegistered().setResponses([()=>{routingCalls++;return json({reply:'设计后再实现',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'生成内容模型',files:['design'],dependsOn:[]}]});}]);
 ensureFauxRegistered('a').setResponses([
 ()=>{planningCalls++;return json({plan:'内容模型',contracts:[],deliverables:[{path:'design/content-model.json',format:'json',fields:[{pointer:'/projects',type:'array',required:true}]}]});},
 ctx=>{planningCalls++;repairContext=JSON.stringify(ctx);expect(core.db.prepare('SELECT id FROM tasks').all()).toHaveLength(0);return json({plan:'内容模型',contracts:[],deliverables:[{path:'design/content-model.json',format:'json',schema:{type:'object',required:['projects'],properties:{projects:{type:'array'}}}}]});},
 tool('write',{path:'design/content-model.json',content:'{"projects":[]}'}),fauxAssistantMessage('PRIVATE_RESEARCH')
 ]);
 await call('workbench:send',{id:w.id,text:'执行个人网页内容设计',requestId:'planning-repair'});const state=await end(w.id);
 expect(state.phase).toBe('awaiting_review');expect(planningCalls).toBe(2);expect(routingCalls).toBe(1);expect(repairContext).toContain('/fields/0');expect(repairContext).toContain('只修正');expect(repairContext).not.toContain('PRIVATE_RESEARCH');
 expect(state.participants.find(p=>p.roleId===b)?.taskId).toBeNull();expect(state.messages.map(m=>m.text).join('\n')).not.toContain('required');
});
it('fails closed after an unsuccessful planning correction with artifact diagnostics and no worker or reroute',async()=>{
 const w=await call('workbench:create',{title:'错误规划',roleIds:[a]});let plans=0;
 ensureFauxRegistered().setResponses([json({reply:'仅设计',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'生成模型',files:['design'],dependsOn:[]}]})]);
 const invalid=()=>{plans++;return json({plan:'设计',contracts:[],deliverables:[{path:'design/content-model.json',format:'json',fields:[{pointer:'/projects',type:'PRIVATE_INVALID_TYPE'}]}]});};
 ensureFauxRegistered('a').setResponses([invalid,invalid,()=>{throw Error('unexpected third planning request');}]);
 await call('workbench:send',{id:w.id,text:'生成设计',requestId:'invalid-repair'});
 for(let i=0;i<200&&core.workbench.get(w.id).phase!=='error';i++)await new Promise(r=>setTimeout(r,5));
 const state=core.workbench.get(w.id);expect(state.phase).toBe('error');expect(plans).toBe(2);expect(core.db.prepare('SELECT id FROM tasks').all()).toHaveLength(0);
 const message=state.messages.at(-1)!.text;expect(message).toContain('design/content-model.json');expect(message).toContain('/fields/0/type');expect(message).toContain('格式修正仍未通过');expect(message).not.toContain('PRIVATE_INVALID_TYPE');
});
it('does not start a worker if the user stops while planning correction is being requested',async()=>{
 const w=await call('workbench:create',{title:'停止修正规划',roleIds:[a]});let plans=0,stopping:Promise<any>|undefined;
 ensureFauxRegistered().setResponses([json({reply:'设计',action:'dispatch',roleIds:[a],assignments:[{roleId:a,instructions:'设计',files:['design'],dependsOn:[]}]})]);
 ensureFauxRegistered('a').setResponses([()=>{plans++;return fauxAssistantMessage('invalid JSON');},async()=>{plans++;stopping=call('workbench:stop',{id:w.id});return json({plan:'已修正',contracts:[],deliverables:[{path:'design/x.json',format:'json'}]});}]);
 await call('workbench:send',{id:w.id,text:'生成设计',requestId:'stop-repair'});
 for(let i=0;i<200&&core.workbench.get(w.id).phase!=='stopped';i++)await new Promise(r=>setTimeout(r,5));
 await stopping;expect(core.workbench.get(w.id).phase).toBe('stopped');expect(core.db.prepare('SELECT id FROM tasks').all()).toHaveLength(0);expect(plans).toBe(2);
});
