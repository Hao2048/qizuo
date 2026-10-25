/** Genuine product-team PRD acceptance through packaged IPC; disposable profile and synthetic inputs. */
import {desktopSession,pause} from './desktop-session.mjs';
import {mkdirSync,copyFileSync,cpSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const out=resolve(process.env.PIH_PRODUCT_ACCEPTANCE_OUT??'docs/role-workbench-v2/acceptance/product-team-prd');
if(existsSync(join(out,'setup.json')))throw Error('Evidence directory already has a run; choose a new PIH_PRODUCT_ACCEPTANCE_OUT');
mkdirSync(out,{recursive:true});const save=(name,v)=>writeFileSync(join(out,name+'.json'),JSON.stringify(v,null,2));
const privateProbe=process.env.PIH_PRODUCT_PRIVATE_PROBE==='1';
const control='/tmp/pih-product-prd-control.json',close='/tmp/pih-product-prd-close';if(existsSync(close))throw Error('Remove the previous test close marker first');
let session;
try{
 session=await desktopSession();await session.bridge(control);const call=session.invoke,model={provider:'deepseek',modelId:'deepseek-flash'};
 const providers=(await call('model:list')).providers;const available=providers.find(p=>p.id===model.provider);
 if(!available?.authConfigured||!available.models.some(m=>m.id===model.modelId))throw Error('DeepSeek Flash credentials/model unavailable in isolated profile');
 await call('settings:set',{defaultModel:model,permissionMode:'auto_edit',autoApproveTools:['read','ls','grep','find'],agentLimits:{maxConcurrent:3,maxMembers:6}});
 const project=join(session.data,'product-project');mkdirSync(join(project,'source'),{recursive:true});mkdirSync(join(project,'acceptance'));
 cpSync(join(out,'inputs'),join(project,'source'),{recursive:true});copyFileSync(join(out,'verify.mjs'),join(project,'acceptance/verify.mjs'));if(existsSync(join(out,'review-method.mjs')))copyFileSync(join(out,'review-method.mjs'),join(project,'acceptance/review-method.mjs'));
 const p=await call('project:add',{dir:project});
 const specs=[
 ['用户研究员','从source/user-feedback.json收集和归纳用户场景与痛点；只负责research/users.json。输出{kind:"synthetic",needs:[{id:"U01",problem,priority,rationale}],limitations:[...]}，至少6项needs，id使用输入的U01—U12。明确是合成观察，不能当真实访谈、人数比例或付费意愿；不替产品经理写PRD。'],
 ['竞品研究员','从source/market-sources.json收集竞品事实和机会边界；只负责research/market.json。输出{sources:[{id,url,product,facts:[...]}],opportunities:[...],unknowns:[...]}。保留S1—S3的三个来源与URL，各提取2—3条相关事实，区分文档事实与自己的推断，不转载原文、不编造价格、市场规模或满意度；不写PRD。'],
 ['技术分析师','从source/technical-sources.json与产品目标收集技术约束；只负责research/technical.json。输出{mode:"local-first",constraints:[{id,requirement,evidenceIds:[...]}],dataModel:{...},risks:[...]}；至少4项约束和3项风险。首版不依赖外部登录；同步只做未来选择，清楚说明失败、授权、敏感数据和恢复边界；产品要求改为完全离线时mode改为local-only-mvp。'],
 ['产品经理','依赖并实际读取三份research/*.json后，只负责delivery/PRD.md和delivery/traceability.json。产出完整中文PRD，不能把合成样本写为真实调研结论。追溯JSON={version:"1.0",requirements:[{id:"R01",description,priority:"P0",sourceIds:["U01","S1"],acceptance:["具体可验证条件"]}],assumptions:[...]}；至少8项唯一R编号，sourceIds只能使用输入U01—U12、S1—S5。PRD逐项引用R编号、来源和假设，不能给不存在的用户研究补数字。修改要求时更新版本1.1并保持需求追溯。'],
 ['产品验收员','依赖并实际读取PRD、追溯JSON及三份研究结果；只负责validation/review.json和validation/review.md。独立核对来源可信度、需求编号、范围、验收可执行性、离线边界与隐私。JSON={passed:true或false,checks:[{id,passed:boolean,note}],issues:[...]}，至少8项检查；有问题如实passed=false并记录，不能替产品经理修改delivery/。不运行命令、不自称程序自动验收通过。'],
 ['视频设计师','只负责视频分镜与视觉动效，当前产品调研PRD任务不相关，保持休眠，不参与本轮。']
 ];
 const roles=[];for(let i=0;i<specs.length;i++)roles.push(await call('role:create',{name:specs[i][0],intro:specs[i][1],systemPrompt:specs[i][1]+`\n你的私有标记PRODUCT_PRIVATE_${i}仅用于隔离测试，禁止写到共享文件、约定、通知和回复。只读取已提供的公开来源与交接产出；没有联网、命令或插件权限，不尝试申请。调用文件工具写实际文件，不只在回复里粘贴成稿。所有角色规划contracts:[]，沿用任务明确的固定数据格式，不创建同义约定。JSON简洁有效，避免占位符和重复自检。`,preferredModel:model,preferredThinking:'off',...(privateProbe?{systemPrompt:specs[i][1]+`\n这是私有执行上下文。测试标记PRODUCT_PRIVATE_${i}与PRIVATE_MEMORY_${i}不得写入文件、共同约定、通知或工具参数。仅在你最后一条私有文字回复中附上这两个测试标记，用于验收宿主不会自动共享私有回复。只用文件工具写实际交付物，不联网、不运行命令、不调用插件。按任务中的精确格式、职责和验收条件执行。`}:{})}));
 const privateMemories=[];if(privateProbe)for(let i=0;i<roles.length;i++)privateMemories.push(await call('memory:write',{scopeType:'role',scopeId:roles[i].id,title:'反馈罗盘 PRD研究与验收经验',content:`PRIVATE_MEMORY_${i}：仅用于本角色测试；依据来源区分事实与假设，不把合成反馈说成真实访谈。`}));
 const w=await call('workbench:create',{title:'反馈罗盘 · 多角色产品团队 PRD 验收',projectId:p.id,roleIds:roles.map(r=>r.id)});
 const spec={id:w.id,project,model,roles:roles.map((r,i)=>({id:r.id,name:r.name,owned:[['research/users.json'],['research/market.json'],['research/technical.json'],['delivery/'],['validation/'],[]][i]})),privateMemoryIds:privateMemories.map(m=>m.id),isolatedProfile:true,encryptedAuthOnly:true,sourceType:'official-document-summaries plus explicitly synthetic user observations',privateProbe,appAsarSHA256:createHash('sha256').update(readFileSync(join(session.app,'Contents/Resources/app.asar'))).digest('hex')};save('setup',spec);
 const ids=roles.map(r=>r.id);
 const text=`为3—10人的小型产品团队设计“反馈罗盘”：先把分散的用户反馈收集、整理和优先级决策做好，最终交付一篇可实施、可追溯、可验收的中文PRD，而不是开发代码。现在开始执行，无需再询问。\n信息来源：source/user-feedback.json是合成用户观察，source/market-sources.json是官方竞品资料摘要，source/technical-sources.json是官方技术资料摘要与设计约束。角色自行阅读归纳，不把合成样本当真实需求验证，不声称已联网采集或已有付费客户。不要使用资料以外的未验证数字。\n分工：${roles[0].name}(${ids[0]})只写research/users.json；${roles[1].name}(${ids[1]})只写research/market.json；${roles[2].name}(${ids[2]})只写research/technical.json。这三位可并行、dependsOn均为空。${roles[3].name}(${ids[3]})只写delivery/PRD.md与delivery/traceability.json，dependsOn必须包含前三位实际ID；必须读实际上游文件再写，不能提前编写。${roles[4].name}(${ids[4]})只写validation/review.json和validation/review.md，dependsOn包含前三位和产品经理实际ID，验证证据与需求是否对得上。${roles[5].name}不得被唤醒。\n各JSON精确格式见角色简介，信息编号只用U01—U12与S1—S5。每个分工必须声明实际文件deliverables；JSON使用format=json、fields使用pointer键，至少核对关键数组类型；PRD用format=text、includes包含“背景与问题”“MVP范围”“验收标准”“合成”；注意pointer而非path。任务经理只需给各角色分工，不代替他们写成品。角色规划contracts:[]，不新建约定。\nPRD请约3000中文字，必须有以下十二个清楚的章节：背景与问题、目标用户、信息来源与可信度、产品目标与非目标、MVP范围、核心流程、功能需求、数据与权限、异常与边界、指标与验证、验收标准、风险与待确认。必须在正文列出唯一R编号及各需求的明确验收条件，追溯JSON至少8项同编号需求并关联真实来源ID；设定的指标只能是未来验证目标。首版无外部账号也能工作，本地优先；外部同步只作为未来可选项。不要写市场规模或收益保证。所有角色只用现有文件工具，不运行命令、不联网、不调用插件，尽量直接读写必要资料。`;
 writeFileSync(join(out,'request.md'),text);await call('workbench:send',{id:w.id,text,requestId:'product-prd-build'});console.log(JSON.stringify({started:true,id:w.id,roleCount:roles.length,control}));
 let prior='';const approvals=new Set();
 while(!existsSync(close)){
  const state=await call('workbench:get',{id:w.id});save('latest',state);
  if(privateProbe&&/PRODUCT_PRIVATE_[0-5]|PRIVATE_MEMORY_[0-5]/.test(JSON.stringify([state.messages,state.contracts,state.proposals])))throw Error('Private marker reached shared state');
  const compact=JSON.stringify({phase:state.phase,roles:state.participants.map(p=>[p.name,p.status]),last:state.messages.at(-1)?.text.slice(-200)});
  if(compact!==prior){console.log(compact);prior=compact;}
  for(const role of state.participants.filter(p=>p.taskId)){
   const task=await call('task:get',{taskId:role.taskId});if(!['running','waiting_approval','waiting_user'].includes(task.task.status))save('task-'+role.taskId,task);
   for(const a of task.pendingApprovals??[])if(!approvals.has(a.toolCallId)){approvals.add(a.toolCallId);save('approval-'+a.toolCallId,{role:role.name,request:a});console.log(JSON.stringify({approval:true,role:role.name,tool:a.toolName}));}
   if(task.question)save('question-'+role.taskId,task.question);
  }
  await pause(2000);
 }
 save('final',await call('workbench:get',{id:w.id}));save('usage',await call('workbench:usage',{id:w.id}));const calls=[];let cursor;do{const page=await call('workbench:usageCalls',{id:w.id,...(cursor?{cursor}:{})});calls.push(...page.calls);cursor=page.nextCursor;}while(cursor);save('calls',calls);
 for(const name of ['source','research','delivery','validation','acceptance'])if(existsSync(join(project,name)))cpSync(join(project,name),join(out,'project',name),{recursive:true});
}catch(error){console.error(String(error).replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]'));process.exitCode=1;}
finally{await session?.close();rmSync(control,{force:true});rmSync(close,{force:true});save('cleanup',{disposableProfileRemoved:session?!existsSync(session.data):true,at:new Date().toISOString()});}
