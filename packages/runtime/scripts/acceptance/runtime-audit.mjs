/** Latest compiled desktop + real IPC/SDK HTTP. Disposable profile, no credentials copied. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {desktopSession,pause} from './desktop-session.mjs';
import {faultServer,configureFixture} from '../../src/stability/http-fixture.mjs';
const out=resolve('docs/role-workbench-v2/acceptance/runtime-audit');mkdirSync(out,{recursive:true});
const result={passed:false,source:'current compiled desktop (unpackaged)',isolatedProfile:true,credentialCopy:false,realModel:false,steps:[]};
const save=()=>writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2)+'\n');save();
const data=mkdtempSync(join(tmpdir(),'pih-runtime-audit-')),project=join(data,'fixture-project');mkdirSync(project);writeFileSync(join(project,'hello.txt'),'fixture original');
const http=await faultServer();configureFixture(data,http.url);
let session;const model=(modelId='worker-a')=>({provider:'stability-http',modelId});
const call=(name,input={})=>session.invoke(name,input);
async function until(check,label){for(let i=0;i<500;i++){const v=await check();if(v)return v;await pause(30);}throw Error('Timeout: '+label);}
const settled=id=>until(async()=>{const t=await call('task:get',{taskId:id});return ['done','error','cancelled'].includes(t.task.status)&&t;},'task');
async function step(name,work){await work();result.steps.push({name,passed:true});save();console.log('PASS',name);}
try{
 session=await desktopSession({dataDir:data,copyAuth:false,development:true,enableFaux:true});result.mainBuildSHA256=createHash('sha256').update(readFileSync(join(session.app,'out/main/index.js'))).digest('hex');
 let a,b,task,fork,w,backup,plugin;
 await step('settings/model/project',async()=>{
  assert((await call('health:get')).ok);assert((await call('model:list')).providers.some(p=>p.id==='stability-http'));
  await call('settings:set',{defaultModel:model(),permissionMode:'ask',autoApproveTools:['read']});
  assert.deepEqual((await call('settings:get')).defaultModel,model());const p=await call('project:add',{dir:project});assert((await call('project:list')).projects.some(x=>x.id===p.id));result.projectId=p.id;
 });
 await step('roles/create-edit-clone-archive-restore',async()=>{
  a=await call('role:create',{name:'审计前端',intro:'页面与测试',systemPrompt:'PRIVATE_ROLE_A',preferredModel:model()});
  b=await call('role:create',{name:'审计后端',intro:'接口与数据',systemPrompt:'PRIVATE_ROLE_B',preferredModel:model('worker-b')});
  const changed=await call('role:update',{roleId:a.id,intro:'页面、状态与测试'});assert.equal(changed.intro,'页面、状态与测试');
  const clone=await call('role:clone',{roleId:a.id,withMemory:false,name:'审计克隆'});await call('role:archive',{roleId:clone.id,archived:true});assert(!(await call('role:list')).roles.some(r=>r.id===clone.id));await call('role:archive',{roleId:clone.id,archived:false});
 });
 await step('memory/write-revise-version-conflict-history-forget-restore-isolation',async()=>{
  const m=await call('memory:write',{scopeType:'role',scopeId:a.id,title:'测试习惯',content:'PRIVATE_MEMORY_A'});
  const v=await call('memory:revise',{memoryId:m.id,content:'PRIVATE_MEMORY_A 优先验证关键状态',expectedVersion:m.version});assert.equal(v.version,m.version+1);
  await assert.rejects(()=>call('memory:revise',{memoryId:m.id,content:'stale',expectedVersion:m.version}));
  assert((await call('memory:history',{memoryId:m.id})).versions.length>=2);await call('memory:forget',{memoryId:m.id});assert.equal((await call('memory:list',{scopeId:a.id,status:'active'})).total,0);await call('memory:restore',{memoryId:m.id});assert.equal((await call('memory:list',{scopeId:a.id,status:'active'})).total,1);assert.equal((await call('memory:list',{scopeId:b.id})).total,0);
  const cloned=await call('role:clone',{roleId:a.id,withMemory:true,name:'含记忆克隆'});assert.equal((await call('memory:list',{scopeId:cloned.id})).total,1);
 });
 await step('market/local-install-bind-private-public-remove',async()=>{
  plugin=join(data,'fixture-package');mkdirSync(join(plugin,'skills','audit-skill'),{recursive:true});writeFileSync(join(plugin,'package.json'),JSON.stringify({name:'pih-audit-fixture',version:'1.0.0',pi:{skills:['./skills']}}));writeFileSync(join(plugin,'skills','audit-skill','SKILL.md'),'---\nname: audit-skill\ndescription: Offline audit fixture\n---\nRead-only audit instructions.\n');
  const installed=await call('market:installLocal',{path:plugin});assert(installed.ok,installed.message);
  const installedPackage=(await call('market:list')).packages.find(p=>p.installedPath===plugin);assert(installedPackage);const source=installedPackage.source;assert((await call('resource:listBindable')).items.some(p=>p.name===source));
  await call('role:update',{roleId:a.id,boundPlugins:[source]});assert((await call('market:setVisibility',{name:source,kind:'package',visibility:'private'})).ok);assert((await call('market:setVisibility',{name:source,kind:'package',visibility:'public'})).ok);assert((await call('market:remove',{source})).ok);await call('role:update',{roleId:a.id,boundPlugins:[]});assert(existsSync(plugin));
 });
 await step('mcp/configure-toggle-resource-policy-corruption-preservation',async()=>{
  await call('mcp:add',{name:'audit',url:http.url});assert((await call('mcp:list')).servers.some(x=>x.name==='audit'));await call('mcp:setEnabled',{name:'audit',enabled:false});assert.equal((await call('mcp:list')).servers.find(x=>x.name==='audit').enabled,false);await call('mcp:setResourcePolicy',{name:'audit',exclusive:true,resourceGroup:'audit-desktop'});await call('mcp:remove',{name:'audit'});
  const config=join(data,'pi/mcp.json'),valid=readFileSync(config,'utf8'),broken='{"mcpServers":';writeFileSync(config,broken);await assert.rejects(()=>call('mcp:add',{name:'new',url:http.url}));assert.equal(readFileSync(config,'utf8'),broken);writeFileSync(config,valid);
 });
 await step('chat/send-model-thinking-reference-fork-statistics',async()=>{
  task=await call('task:create',{title:'审计对话',projectId:result.projectId,roleId:a.id});await call('task:prompt',{taskId:task.id,text:'运行隔离 STABLE_audit_chat'});assert.equal((await settled(task.id)).task.status,'done');
  await call('task:setThinking',{taskId:task.id,level:'high'});await call('task:setModel',{taskId:task.id,provider:'stability-http',modelId:'worker-a'});
  const full=await call('task:get',{taskId:task.id});const reply=full.transcript.find(m=>m.role==='assistant'&&m.entryId);assert(reply);fork=await call('task:fork',{taskId:task.id,entryId:reply.entryId});assert((await call('task:get',{taskId:fork.id})).transcript.length>0);
  assert((await call('task:getContext',{taskId:task.id})).contextWindow>0);assert((await call('task:getRoleContexts',{taskId:task.id})).roles.length>0);
  const reference=await call('task:captureReference',{sourceTaskId:task.id});await call('task:prompt',{taskId:fork.id,text:'STABLE_audit_reference summarize',referenceIds:[reference.id]});assert.equal((await settled(fork.id)).task.status,'done');
 });
 await step('approval-denial-and-independent-concurrent-task',async()=>{
  const denied=join(project,'must-not-write.txt');http.scripts.set('STABLE_audit_approval',{tool:{path:denied,content:'must not exist'}});await call('task:prompt',{taskId:task.id,text:'STABLE_audit_approval'});
  const waiting=await until(async()=>{const t=await call('task:get',{taskId:task.id});return t.pendingApprovals.length&&t;},'approval');await call('task:prompt',{taskId:fork.id,text:'STABLE_audit_independent'});assert.equal((await settled(fork.id)).task.status,'done');await call('approval:decide',{taskId:task.id,toolCallId:waiting.pendingApprovals[0].toolCallId,approved:false});await settled(task.id);assert(!existsSync(denied));
 });
 await step('chat-stream-loss-retry-cancel',async()=>{
  http.scripts.set('STABLE_audit_cut',{cut:true});await call('task:prompt',{taskId:task.id,text:'STABLE_audit_cut'});assert.equal((await settled(task.id)).task.status,'error');await call('task:prompt',{taskId:task.id,text:'STABLE_audit_retry'});assert.equal((await settled(task.id)).task.status,'done');
  http.scripts.set('STABLE_audit_stall',{stall:true});await call('task:prompt',{taskId:task.id,text:'STABLE_audit_stall'});await until(()=>http.events.some(e=>e.marker==='STABLE_audit_stall'),'network stall');await call('task:abort',{taskId:task.id});assert.equal((await settled(task.id)).task.status,'cancelled');
 });
 await step('workbench-discussion-pause-role-change-and-draft',async()=>{
  await call('settings:set',{defaultModel:model('router'),permissionMode:'auto_edit',autoApproveTools:['read']});w=await call('workbench:create',{title:'审计工作台',projectId:result.projectId,roleIds:[a.id,b.id]});await call('workbench:setEnabled',{id:w.id,roleId:b.id,enabled:false});
  await call('workbench:send',{id:w.id,text:'STABLE_audit_discussion 讨论方案，不执行',requestId:'discussion'});await until(async()=>(await call('workbench:get',{id:w.id})).messages.some(m=>m.requestId==='discussion'&&m.kind==='reply'),'discussion');assert((await call('workbench:get',{id:w.id})).participants.every(p=>p.taskId===null));
  await call('workbench:setEnabled',{id:w.id,roleId:b.id,enabled:true});const changed=await call('role:update',{roleId:a.id,intro:'更新后的简介'});assert(changed);assert((await call('workbench:get',{id:w.id})).participants.find(p=>p.roleId===a.id).configurationChanged);
  const draft=await call('draft:get',{kind:'workbench',id:w.id});await call('draft:save',{kind:'workbench',id:w.id,revision:draft.revision,patch:{text:'重启后保留的工作台草稿'}});const chatDraft=await call('draft:get',{kind:'chat',id:fork.id});await call('draft:save',{kind:'chat',id:fork.id,revision:chatDraft.revision,patch:{text:'未发送文本',attachments:[{kind:'text',name:'notes.txt',data:'附件草稿'}]}});
 });
 await step('backup-create-restart-draft-persistence-no-replay',async()=>{
  backup=await call('backup:create');assert((await call('backup:list')).backups.some(b=>b.id===backup.id));const requests=http.events.length;
  await session.quit();session=await desktopSession({dataDir:data,copyAuth:false,development:true,enableFaux:true});assert.equal(http.events.length,requests);assert.equal((await call('draft:get',{kind:'workbench',id:w.id})).draft.text,'重启后保留的工作台草稿');assert.equal((await call('draft:get',{kind:'chat',id:fork.id})).draft.attachments[0].data,'附件草稿');
 });
 await step('delete-isolated-task-workbench-and-drafts',async()=>{
  await call('task:delete',{taskId:fork.id});await assert.rejects(()=>call('task:get',{taskId:fork.id}));await call('workbench:delete',{id:w.id});await assert.rejects(()=>call('workbench:get',{id:w.id}));assert((await call('task:get',{taskId:task.id})).transcript.length>0);assert.equal(readFileSync(join(project,'hello.txt'),'utf8'),'fixture original');
 });
 for(const e of http.events){if(e.model==='worker-a')assert(!e.canaries.includes('PRIVATE_ROLE_B'));if(e.model==='worker-b')assert(!e.canaries.includes('PRIVATE_ROLE_A'));}
 result.modelRequests=http.events.length;result.passed=true;save();
}catch(error){result.error=String(error);save();throw error;}
finally{await session?.close();await http.close();if(existsSync(data))rmSync(data,{recursive:true,force:true});writeFileSync(join(out,'cleanup.json'),JSON.stringify({removed:!existsSync(data)})+'\n');}
