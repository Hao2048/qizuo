/** Real-model positive handoff through packaged production IPC; no execution budget. */
import{desktopSession,pause}from'./desktop-session.mjs';
import{mkdirSync,writeFileSync,existsSync,cpSync}from'node:fs';import{resolve,join}from'node:path';
const out=resolve('docs/role-workbench-v2/acceptance/dependency-handoff');
if(existsSync(out))throw Error('Evidence already exists');mkdirSync(out,{recursive:true});
const save=(name,data)=>writeFileSync(join(out,name+'.json'),JSON.stringify(data,null,2));
const session=await desktopSession();
try{
 const call=session.invoke,model={provider:'deepseek',modelId:'deepseek-flash'};
 await call('settings:set',{defaultModel:model,permissionMode:'auto_edit',autoApproveTools:['read','ls','grep','find']});
 const project=join(session.data,'handoff-project');mkdirSync(project);
 const p=await call('project:add',{dir:project});
 const producer=await call('role:create',{name:'规格设计师',preferredModel:model,preferredThinking:'off',systemPrompt:'只负责spec/，交付spec/clip.json={"duration":30,"fps":30}，不运行命令、不联网。只做这一个小交付，不扩展。规划返回结构化deliverables：json，/duration和/fps均number且equals30。'});
 const consumer=await call('role:create',{name:'交付整理员',preferredModel:model,preferredThinking:'off',systemPrompt:'只负责delivery/，先用read读取spec/clip.json实际输入，再写delivery/result.txt，必须包含duration=30和fps=30。不运行命令、不联网，不修改spec/。规划返回text类型deliverables及includes这两个文本条件。'});
 const w=await call('workbench:create',{title:'真实模型：校验后交接',projectId:p.id,roleIds:[producer.id,consumer.id]});
 save('setup',{id:w.id,model,roleIds:[producer.id,consumer.id],formalProfileUntouched:true});
 await call('workbench:send',{id:w.id,requestId:'validated-handoff',text:`执行一个小任务：规格设计师（${producer.id}）只负责spec/，写spec/clip.json，字段duration和fps均为数字30；在分工deliverables和规划中明确format=json、fields为/pointer字段指针/duration和/fps、type=number、equals=30。然后交付整理员（${consumer.id}）只负责delivery/，dependsOn必须填前者ID。读取真实clip.json后写delivery/result.txt，包含duration=30与fps=30，text deliverables的includes明确这两个片段。不做视频、不运行命令、不联网、不加其他角色。可直接执行，无需询问。双方沿用同一个约定或contracts:[]，不要各自重写同义约定。注意fields对象键名是pointer，不是path。`});
 let previous='';let state;
 while(true){
  state=await call('workbench:get',{id:w.id});save('latest',state);
  const line=JSON.stringify({phase:state.phase,roles:state.participants.map(p=>[p.name,p.status])});if(line!==previous){console.log(line);previous=line;}
  if(['awaiting_review','error','stopped','waiting_decision','awaiting_roles'].includes(state.phase))break;
  for(const role of state.participants.filter(p=>p.taskId)){
   const t=await call('task:get',{taskId:role.taskId});
   if(t.pendingApprovals?.length || t.question){save('needs-attention',t);throw Error('Unexpected user approval/question; no automatic bypass');}
  }
  await pause(1000);
 }
 save('state-before-application',state);
 for(const role of state.participants.filter(p=>p.taskId))save('task-'+role.roleId,await call('task:get',{taskId:role.taskId}));
 if(state.phase!=='awaiting_review')throw Error('Real handoff did not complete: '+state.phase);
 if(!state.participants.every(p=>p.deliverables?.length && p.deliveryCheck?.status==='passed'))throw Error('Missing structured delivery or checked receipt');
 for(const role of state.participants){const review=await call('workbench:review',{id:w.id,roleId:role.roleId});if(review.conflicts||review.blockedReason)throw Error('Review blocked');await call('workbench:apply',{id:w.id,roleId:role.roleId,reviewToken:review.token});}
 cpSync(join(project,'spec'),join(out,'project/spec'),{recursive:true});cpSync(join(project,'delivery'),join(out,'project/delivery'),{recursive:true});
 save('final',await call('workbench:get',{id:w.id}));save('usage',await call('workbench:usage',{id:w.id}));
 console.log('Real model structured output, dependency check, copied input and normal application passed');
}finally{await session.close();save('cleanup',{disposableProfileRemoved:!existsSync(session.data),at:new Date().toISOString()});}
