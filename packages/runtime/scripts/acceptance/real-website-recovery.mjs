/** Real provider, current desktop production IPC, disposable profile and synthetic website. No packaging. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {desktopSession,pause} from './desktop-session.mjs';
const out=resolve(process.env.PIH_WEBSITE_OUT??'docs/role-workbench-v2/acceptance/real-website-recovery');
if(existsSync(join(out,'setup.json')))throw Error('Choose a fresh evidence directory');
mkdirSync(out,{recursive:true});
const data=mkdtempSync(join(tmpdir(),'pih-real-web-')),project=join(data,'project');
mkdirSync(join(project,'acceptance'),{recursive:true});
const save=(name,v)=>writeFileSync(join(out,name+'.json'),JSON.stringify(v,null,2));
const model={provider:'deepseek',modelId:'deepseek-flash'};
let session,workbench,roles=[],last='',interruptedTask,upstreamTask,approved=0;
const control='/tmp/pih-real-website-control.json',noticed=new Set();
const approvals=[],timeline=[];
const liveCrash=process.env.PIH_WEBSITE_INTERRUPT==='crash';
const call=(name,input={})=>session.invoke(name,input);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const marker=/WEB_PRIVATE_(SPEC|FRONTEND|QA)/g;
const safeError=e=>String(e).replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]');
function checkShared(w){assert(!marker.test(JSON.stringify([w.messages,w.contracts,w.proposals])),'private marker leaked to shared state');marker.lastIndex=0;}
async function snapshot(){const w=await call('workbench:get',{id:workbench.id});checkShared(w);save('latest',w);const summary=JSON.stringify({phase:w.phase,roles:w.participants.map(p=>({name:p.name,status:p.status,stage:w.roundProgress?.roles.find(r=>r.roleId===p.roleId)?.stage})),last:w.messages.at(-1)?.text.slice(-400)});if(last!==summary){console.log(summary);timeline.push({at:new Date().toISOString(),state:JSON.parse(summary)});save('timeline',timeline);last=summary;}return w;}
async function waitFor(fn,label){const end=Date.now()+1800000;while(Date.now()<end){const result=await fn();if(result)return result;await pause(700);}throw Error('Acceptance watchdog: '+label);}
async function calls(){const all=[];let cursor;do{const page=await call('workbench:usageCalls',{id:workbench.id,...(cursor?{cursor}:{})});all.push(...page.calls);cursor=page.nextCursor;}while(cursor);return all;}
async function attention(w,{approve=false}={}){
 if(w.phase==='waiting_decision'){save('pending-contracts',w.proposals);throw Error('Unexpected contract change requiring user selection');}
 if(['error','stopped','awaiting_roles'].includes(w.phase))throw Error('Execution stopped: '+w.messages.at(-1)?.text);
 for(const p of w.participants.filter(p=>p.taskId)){
  const t=await call('task:get',{taskId:p.taskId});save('task-'+p.taskId,t);
  if(t.question)throw Error('Unexpected question: '+JSON.stringify(t.question));
  for(const a of t.pendingApprovals??[]){
   if(p.roleId!==roles[1].id)throw Error('Unexpected role approval');
   if(!approve)return {p,t,a};
   const command=a.args?.command??a.input?.command;
   save('approval-'+a.toolCallId,{role:p.name,request:a});
   if(a.toolName!=='workbench_command'||typeof command!=='string'||!/^node acceptance\/check-(?:input|site)\.mjs$/.test(command.trim())){if(!noticed.has(a.toolCallId)){noticed.add(a.toolCallId);console.log(JSON.stringify({manualApproval:true,taskId:p.taskId,toolCallId:a.toolCallId,tool:a.toolName,command,control}));}continue;}
   approvals.push({taskId:p.taskId,toolCallId:a.toolCallId,command,at:new Date().toISOString()});
   await call('approval:decide',{taskId:p.taskId,toolCallId:a.toolCallId,approved:true,reason:'隔离验收：执行已核对的本地网站检查脚本，不联网。'});approved++;save('approvals',approvals);
  }
 }
 return null;
}
writeFileSync(join(project,'acceptance/check-input.mjs'),`import assert from 'node:assert/strict';import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';const s=JSON.parse(readFileSync('spec/site.json'));assert.equal(s.version,'1');assert.equal(s.title,'拾光书店');assert.deepEqual(s.categories,['全部','文学','设计']);mkdirSync('site',{recursive:true});writeFileSync('site/command-receipt.json',JSON.stringify({checked:true,version:s.version,title:s.title}));console.log('INPUT_HANDOFF_OK');`);
writeFileSync(join(project,'acceptance/check-site.mjs'),`import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';const s=JSON.parse(readFileSync('spec/site.json'));const d=JSON.parse(readFileSync('site/books.json'));assert.equal(d.version,s.version);assert.equal(d.books.length,3);assert(d.books.every(b=>['文学','设计'].includes(b.category)));const html=readFileSync('site/index.html','utf8'),js=readFileSync('site/app.js','utf8'),css=readFileSync('site/style.css','utf8');assert(html.includes(s.title));assert(html.includes('app.js')&&html.includes('style.css'));assert(js.includes('books.json'));assert(css.includes('@media'));assert.equal(JSON.parse(readFileSync('site/command-receipt.json')).checked,true);writeFileSync('site/verification.json',JSON.stringify({passed:true,inputVersion:s.version,checks:['data','html-references','fetch-reference','responsive-css','input-command-receipt']}));console.log('WEBSITE_CHECK_OK');`);
try{
 session=await desktopSession({dataDir:data,copyAuth:true,development:true,enableFaux:false});
 await session.bridge(control);
 const provider=(await call('model:list')).providers.find(p=>p.id===model.provider);
 assert(provider?.authConfigured&&provider.models.some(m=>m.id===model.modelId),'Configured real model unavailable');
 await call('settings:set',{defaultModel:model,permissionMode:'auto_edit',autoApproveTools:['read','ls','find','grep']});
 const specs=[
  ['接口设计师','只负责spec/site.json，定义前端数据接口。文件为{version:"1",title:"拾光书店",categories:["全部","文学","设计"],books:[{id:"b1",title:"岛屿来信",category:"文学"},{id:"b2",title:"字形之间",category:"设计"},{id:"b3",title:"山间日记",category:"文学"}]}。只用文件读写工具，不运行命令、不联网。','SPEC'],
  ['前端工程师','只负责site/。依赖接口设计师，实际读取spec/site.json后先写site/progress.json记录{stage:"input-read",version:"1"}，随后必须调用workbench_command运行node acceptance/check-input.mjs，等其成功再开发页面，不可跳过或用别的工具替代这次命令。完成site/index.html、site/style.css、site/app.js、site/books.json。两次验收命令分别生成公开交接文件site/command-receipt.json和site/verification.json，不要手写或篡改它们。数据遵照spec/site.json，fetch加载books.json；页面可按分类过滤，有响应式样式、清晰空状态，不使用外链/CDN或依赖安装。实现后调用workbench_command运行node acceptance/check-site.mjs。命令待审批时等待，不要反复请求。恢复时先检查已有文件，只补做未完成步骤。','FRONTEND'],
  ['测试工程师','只负责qa/review.json与qa/review.md。依赖接口设计师和前端工程师，实际读取spec/site.json及全部site/交付文件，核对3本书数据、分类筛选实现、响应式、文件引用，读取site/command-receipt.json和site/verification.json两份公开命令回执。不要寻找或读取其他角色的私有执行日志，公开文件已提供验收所需证据。report JSON为{passed:boolean,checks:[{name,passed:boolean,evidence}],issues:[]}。至少6项独立检查，如实记录限制，未浏览器实测不可声称已实测。不修改spec/或site/；不运行命令、不联网。','QA']
 ];
 for(const [name,ability,tag] of specs)roles.push(await call('role:create',{name,intro:ability,systemPrompt:ability+`\n这是隔离验收项目，信息已足够请直接执行。规划使用submit_role_plan，contracts:[]，不要重建已有共同约定或嵌入fields/includes交付规则。你的私有标记WEB_PRIVATE_${tag}只在最后私有文字回复末尾写一次，禁止写入文件、共同约定、通知或工具参数；其他角色不应看到它。`,preferredModel:model,preferredThinking:'off'}));
 const p=await call('project:add',{dir:project});workbench=await call('workbench:create',{title:'真实模型 · 拾光书店网站恢复验收',projectId:p.id,roleIds:roles.map(r=>r.id)});
 await call('workbench:setAccess',{id:workbench.id,roleId:roles[1].id,commands:true,network:false,servers:[]});
 await call('workbench:setApprovalMode',{id:workbench.id,roleId:roles[1].id,approvalMode:'ask'});
 save('setup',{id:workbench.id,roles:roles.map(r=>({id:r.id,name:r.name})),model,currentSourceBuild:true,realModel:true,encryptedCredentialsOnly:true,isolatedProfile:true,mainBuildSHA256:hash(join(session.app,'out/main/index.js'))});
 const text=`请直接开发一个“拾光书店”微型静态网站并独立检查，任务信息已齐全，无需提问。明确要求三个现有角色都工作，不增加其他角色。接口设计师(${roles[0].id})只负责spec/，产出spec/site.json，完整字段和三本书见简介；前端工程师(${roles[1].id})只负责site/，dependsOn接口设计师，输出site/index.html、site/style.css、site/app.js、site/books.json和site/progress.json。前端必须先读真实spec/site.json，写progress.json，再通过workbench_command执行node acceptance/check-input.mjs，成功后实现界面，最后执行node acceptance/check-site.mjs，这两次为明确的本地验收命令，不安装依赖、不联网。测试工程师(${roles[2].id})只负责qa/，dependsOn前两位，必须实际读取输入和页面交付再写qa/review.json及qa/review.md。所有具体要求见各角色简介。任务助手只提交最小分工：roleId/instructions/files/dependsOn/outputs，不生成字段校验规则。各角色规划contracts:[]，不新建约定。页面要现代简洁，中文语义化HTML、分类切换、响应式，蓝白色调，不扩展需求。`;
 writeFileSync(join(out,'request.md'),text);await call('workbench:send',{id:workbench.id,text,requestId:'website-build'});
 const waiting=await waitFor(async()=>{const w=await snapshot();const approval=await attention(w);if(w.phase==='awaiting_review')throw Error('Missing mandatory approval checkpoint');return approval&&{w,...approval};},'first approval');
 save('before-interruption',waiting.w);save('first-approval',waiting.a);
 assert.equal(waiting.p.roleId,roles[1].id);upstreamTask=waiting.w.participants.find(p=>p.roleId===roles[0].id).taskId;assert(upstreamTask);
 assert.equal(waiting.w.participants.find(p=>p.roleId===roles[2].id).taskId,null,'consumer started before frontend completed');
 interruptedTask=waiting.p.taskId;
 assert(existsSync(join(waiting.a.cwd,'site/progress.json')));assert(!existsSync(join(waiting.a.cwd,'site/command-receipt.json')),'unapproved command ran');
 save('unapproved-command-check',{partialExists:true,commandRan:false});
 if(!liveCrash)await call('workbench:stop',{id:workbench.id});
 if(!liveCrash)await waitFor(async()=>!(await call('task:get',{taskId:interruptedTask})).pendingApprovals?.length,'approval cancellation');
 const stopped=await snapshot();assert.equal(stopped.phase,liveCrash?'running':'stopped');save(liveCrash?'before-live-crash':'after-stop',stopped);
 const beforeCalls=await calls();save('calls-before-restart',beforeCalls);
 await session.crash();session=await desktopSession({dataDir:data,copyAuth:false,development:true,enableFaux:false});await session.bridge(control);
 await pause(1200);const restored=await snapshot();assert.equal((await calls()).length,beforeCalls.length,'restart sent a model request');assert.equal(restored.phase,'stopped');if(liveCrash)assert.equal(restored.participants.find(p=>p.roleId===roles[1].id).status,'interrupted','stale wait status survived restart');assert.equal((await call('task:get',{taskId:interruptedTask})).pendingApprovals?.length??0,0);
 save('after-restart',restored);
 await call('workbench:send',{id:workbench.id,text:'继续',requestId:'website-resume'});
 const complete=await waitFor(async()=>{const w=await snapshot();await attention(w,{approve:true});return w.phase==='awaiting_review'&&w;},'continued website');
 assert.equal(complete.participants.find(p=>p.roleId===roles[0].id).taskId,upstreamTask,'completed producer reran');
 assert(approved>=1,'no actual command approval performed');assert(complete.participants.every(p=>p.deliveryCheck?.status==='passed'));
 save('execution-finished',complete);
 const callRecords=await calls();save('calls',callRecords);save('usage',await call('workbench:usage',{id:workbench.id}));
 const priorIds=new Set(beforeCalls.map(c=>c.id));const resumedCalls=callRecords.filter(c=>!priorIds.has(c.id));save('resumed-calls',resumedCalls);assert(resumedCalls.every(c=>c.stage==='execution'),'continuation routed or replanned');
 for(const role of complete.participants){const review=await call('workbench:review',{id:workbench.id,roleId:role.roleId});assert(!review.blockedReason&&!review.conflicts);save('review-'+role.roleId,review);await call('workbench:apply',{id:workbench.id,roleId:role.roleId,reviewToken:review.token});}
 assert.equal(JSON.parse(readFileSync(join(project,'site/progress.json'))).stage,'input-read');
 assert.equal(JSON.parse(readFileSync(join(project,'qa/review.json'))).passed,true,'independent role found product defects');
 for(const name of ['spec','site','qa','acceptance'])cpSync(join(project,name),join(out,'project',name),{recursive:true});
 for(const role of roles){const participant=complete.participants.find(p=>p.roleId===role.id);const t=await call('task:get',{taskId:participant.taskId});const content=JSON.stringify(t);const tag=specs.find(s=>s[0]===role.name)[2];for(const other of ['SPEC','FRONTEND','QA'].filter(s=>s!==tag))assert(!content.includes('WEB_PRIVATE_'+other),'cross-role private marker');save('final-task-'+tag,t);}
 assert(!marker.test(readFileSync(join(out,'project/qa/review.md'),'utf8')));marker.lastIndex=0;
 await call('workbench:verify',{id:workbench.id,commands:['node acceptance/check-input.mjs','node acceptance/check-site.mjs'],network:false});
 const verified=await waitFor(async()=>{const w=await call('workbench:get',{id:workbench.id});return w.verification?.status!=='running'&&w;},'host integration');save('verification',verified.verification);assert.equal(verified.verification.status,'passed');
 const completion=await call('completion:get',{scope:'workbench',id:workbench.id});save('completion-before-acceptance',completion);assert.equal(completion.state,'ready_for_acceptance');
 await call('workbench:finish',{id:workbench.id,completionToken:completion.token,evidence:'真实DeepSeek模型三角色分工；依赖文件读取、审批中断、重启不重放、继续后逐次审批及本地网站脚本通过，独立角色审查通过。浏览器外观另行人工验证。',memoryIds:[]});
 assert.equal((await call('completion:get',{scope:'workbench',id:workbench.id})).state,'accepted');
 const finalCallCount=(await calls()).length;await session.quit();session=await desktopSession({dataDir:data,copyAuth:false,development:true,enableFaux:false});assert.equal((await calls()).length,finalCallCount);assert.equal((await call('completion:get',{scope:'workbench',id:workbench.id})).state,'accepted');
 save('result',{passed:true,at:new Date().toISOString(),model,realModel:true,currentSourceBuild:true,isolatedProfile:true,formalTasksUntouched:true,approvalCount:approved,interruption:liveCrash?'SIGKILL-while-waiting-approval':'explicit-stop-then-SIGKILL',restartNoReplay:true,completedProducerPreserved:true,partialProgressPreserved:true,privateSharedMarkers:0,accepted:true});console.log('Real-model website recovery acceptance passed');
}catch(e){save('result',{passed:false,at:new Date().toISOString(),error:safeError(e),realModel:true});console.error(safeError(e));process.exitCode=1;}
finally{if(session&&workbench){try{for(const role of (await call('workbench:get',{id:workbench.id})).participants.filter(p=>p.taskId))save('last-task-'+role.roleId,await call('task:get',{taskId:role.taskId}));}catch{}}await session?.close();rmSync(control,{force:true});rmSync(data,{recursive:true,force:true});save('cleanup',{disposableProfileRemoved:!existsSync(data),encryptedAuthCopyRemoved:true,at:new Date().toISOString()});}
