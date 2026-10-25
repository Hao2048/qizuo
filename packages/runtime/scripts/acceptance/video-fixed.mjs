/** Real-model acceptance through the packaged application; synthetic project only. */
import {desktopSession,pause} from './desktop-session.mjs';
import {mkdirSync,copyFileSync,chmodSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
const out=resolve(process.env.PIH_VIDEO_ACCEPTANCE_OUT ?? 'docs/role-workbench-v2/acceptance/video-workflow-fixed');
if(existsSync(join(out,'setup.json')))throw Error('验收目录已有记录；请用 PIH_VIDEO_ACCEPTANCE_OUT 指定新的证据目录');
mkdirSync(out,{recursive:true});
const save=(name,value)=>writeFileSync(join(out,name+'.json'),JSON.stringify(value,null,2));
const session=await desktopSession();
const control='/tmp/pih-video-fixed-control.json';
await session.bridge(control);
const call=session.invoke;
try {
 const model={provider:'deepseek',modelId:'deepseek-flash'};
 await call('settings:set',{defaultModel:model,permissionMode:'auto_edit',autoApproveTools:['read','ls','grep','find'],agentLimits:{maxConcurrent:2,maxMembers:6}});
 const project=join(session.data,'video-project');mkdirSync(join(project,'tools'),{recursive:true});mkdirSync(join(project,'acceptance'),{recursive:true});
 copyFileSync(process.env.PIH_FFMPEG_PATH??join(homedir(),'.local/bin/ffmpeg'),join(project,'tools/ffmpeg'));chmodSync(join(project,'tools/ffmpeg'),0o755);
 copyFileSync('docs/role-workbench-v2/acceptance/video-workflow/verify.mjs',join(project,'acceptance/verify.mjs'));
 const p=await call('project:add',{dir:project});
 const specs=[
 ['视频策划','明确受众与可信价值主张，交付brief/brief.json和brief/README.md。只写brief/。不执行命令。'],
 ['视频编剧','读取策划，创作三镜短视频脚本，只写script/script.json。严格满足时长与字数约定。不执行命令。'],
 ['分镜设计师','逐字沿用脚本文案与时间，设计颜色与可见图形动效。只写storyboard/storyboard.json。不执行命令。'],
 ['视频剪辑师','读取brief、script、storyboard三个JSON，写简短可维护的editor/render.mjs（尽量150行以内，避免冗长注释与重复检查）与delivery/交付物。角色命令已允许但每条仍需审批，只使用workbench_command申请node --check editor/render.mjs和node editor/render.mjs。无网络无插件，只用Node内置模块及tools/ffmpeg。生成真实成片，失败据错误修复一次，不反复通读代码。'],
 ['网站开发工程师','仅负责网站；本次视频任务无关，保持休眠。']
 ];
 const roles=[];
 for(let i=0;i<specs.length;i++)roles.push(await call('role:create',{name:specs[i][0],intro:specs[i][1],systemPrompt:specs[i][1]+'\n私有隔离标记VIDEO_PRIVATE_'+i+'：只用于隔离验收，不写入文件、共享约定或对话回复。',preferredModel:model,preferredThinking:'off'}));
 const w=await call('workbench:create',{title:'慢半拍 · 30秒视频制作验收',projectId:p.id,roleIds:roles.map(r=>r.id)});
 await call('workbench:setAccess',{id:w.id,roleId:roles[3].id,commands:true,network:false,servers:[]});
 save('setup',{id:w.id,project,roleIds:roles.map(r=>({id:r.id,name:r.name})),model,isolatedProfile:true,encryptedAuthOnly:true});
 let text=readFileSync('docs/role-workbench-v2/acceptance/video-workflow/request-30.md','utf8');
 text=text.replace('后续由我独立执行渲染并验收','剪辑角色申请受控命令渲染后，由我独立验收').replace('角色只用文件工具编写，我将独立通过node editor/render.mjs启动渲染；不要自称已成片或已验收。','剪辑角色申请workbench_command运行node --check editor/render.mjs和node editor/render.mjs；每条命令均由验收者逐项审批。未运行成功不得自称成片或验收通过。渲染器尽量150行以内，只使用必要逻辑，不写数百行解释注释。').replace('当前所有角色没有命令、网络和插件授权，不要改变权限。','只有剪辑角色已获本地命令权限，仍需逐命令审批；其余角色没有命令权限。所有角色网络和插件关闭。不要改变权限。');
 text+='\n实际角色ID（所有JSON roleId、dependsOn、roles只能用以下ID，不使用名字或缩写）：'+JSON.stringify(roles.map(r=>({id:r.id,name:r.name})))+'。策划和编剧负责脚本内容，分镜显式依赖策划与编剧，剪辑显式依赖前三位；网站角色不得被唤醒。共同约定只由策划建立video-delivery，其他角色若已存在则contracts:[]沿用，不改写。roles仅填写前四位实际ID。';
 writeFileSync(join(out,'request.md'),text);
 await call('workbench:send',{id:w.id,text,requestId:'video30-fixed-build'});
 console.log(JSON.stringify({started:true,id:w.id,control}));
 const seen=new Set();let last='',tick=0;
 while(!existsSync('/tmp/pih-video-fixed-close')) {
  const state=await call('workbench:get',{id:w.id});
  save('latest',state);
  const compact=JSON.stringify({phase:state.phase,participants:state.participants.map(p=>({name:p.name,status:p.status})),verification:state.verification?.status,last:state.messages.at(-1)?.text.slice(-250)});
  if(compact!==last||++tick%15===0){console.log(compact);last=compact;}
  for(const p of state.participants.filter(p=>p.taskId)) {
   const task=await call('task:get',{taskId:p.taskId});
   if(!['running','waiting_approval','waiting_user'].includes(task.task.status))save('task-'+p.taskId,task);
   for(const a of task.pendingApprovals??[])if(!seen.has(a.toolCallId)){seen.add(a.toolCallId);save('approval-'+a.toolCallId,{taskId:p.taskId,roleId:p.roleId,request:a});console.log(JSON.stringify({approval:true,taskId:p.taskId,role:p.name,request:a}));}
  }
  await pause(2000);
 }
 save('final',await call('workbench:get',{id:w.id}));
 save('usage',await call('workbench:usage',{id:w.id}));
 const calls=[];let cursor;do{const page=await call('workbench:usageCalls',{id:w.id,...(cursor?{cursor}:{})});calls.push(...page.calls);cursor=page.nextCursor;}while(cursor);save('calls',calls);
} catch(error){console.error(String(error).replace(/sk-[\w-]+/g,'[REDACTED]'));process.exitCode=1;}
finally{await session.close();rmSync(control,{force:true});rmSync('/tmp/pih-video-fixed-close',{force:true});save('cleanup',{disposableProfileRemoved:!existsSync(session.data),at:new Date().toISOString()});}
