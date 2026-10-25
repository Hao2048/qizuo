/** Genuine multi-role VFX acceptance via packaged production IPC. No formal profile mutation. */
import {desktopSession,pause} from './desktop-session.mjs';
import {mkdirSync,copyFileSync,cpSync,chmodSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve,basename} from 'node:path';
const out=resolve('docs/role-workbench-v2/acceptance/neon-core-video');
if(existsSync(join(out,'setup.json')))throw Error('This evidence directory already contains a run');
mkdirSync(out,{recursive:true});const save=(name,v)=>writeFileSync(join(out,name+'.json'),JSON.stringify(v,null,2));
const session=await desktopSession();const control='/tmp/pih-neon-control.json';await session.bridge(control);
const call=session.invoke;
try {
 const model={provider:'deepseek',modelId:'deepseek-flash'};
 await call('settings:set',{defaultModel:model,permissionMode:'auto_edit',autoApproveTools:['read','ls','grep','find'],agentLimits:{maxConcurrent:2,maxMembers:6}});
 const project=join(session.data,'neon-project');mkdirSync(join(project,'tools/pythonlib'),{recursive:true});mkdirSync(join(project,'acceptance'),{recursive:true});
 copyFileSync(process.env.PIH_FFMPEG_PATH??join(homedir(),'.local/bin/ffmpeg'),join(project,'tools/ffmpeg'));chmodSync(join(project,'tools/ffmpeg'),0o755);
 const lib=process.env.PIH_VIDEO_PYTHON_LIB??join(homedir(),'Library/Python/3.9/lib/python/site-packages');
 for(const name of ['numpy','PIL'])cpSync(join(lib,name),join(project,'tools/pythonlib',name),{recursive:true,dereference:true,filter:p=>!['__pycache__','tests','testing','doc'].includes(basename(p))&&!/\.(pyc|pyi)$/.test(p)});
 copyFileSync(join(out,'verify.mjs'),join(project,'acceptance/verify.mjs'));
 const p=await call('project:add',{dir:project});
 const specs=[
 ['创意导演','确定霓虹奇点30秒视听短片的四段节奏、意图和标准，拥有brief/。只读规划后直接写简洁brief。共同约定由你首次建立neon-delivery，其他角色沿用，不创建本地契约副本。'],
 ['动效设计师','围绕能量球、三维轨道、粒子、镜头与bloom做高级且可实现的动态设计。读取brief，只拥有design/，通过visual.json给出数值化配色、分段、相机和运动参数，不写渲染器，不改brief。'],
 ['声音设计师','读取导演与视觉节奏，只拥有audio/。用numpy写原创电子音乐合成程序与score.json，实际生成30秒48kHz双声道PCM16 soundtrack.wav。已可申请本地命令，每条仍需审批，无网络插件。避免单音嗡声，提供节拍、低音、铺底、过门、空间感与收束。'],
 ['合成工程师','读取导演、视觉设计、音轨，实现有连续几何运动与透视纵深的高质量1080p30fps动效。只拥有render/与delivery/。Python/numpy/Pillow+Node+已提供ffmpeg；先申请node render/compose.mjs --preview并等待预览审查，再申请node render/compose.mjs。不改上游、不安装依赖、不联网。程序要短而可靠、真实渲染900帧，所有输入哈希写manifest。'],
 ['网站开发工程师','只负责网站页面，与视频制作无关，本次保持休眠。']
 ];
 const roles=[];for(let i=0;i<specs.length;i++)roles.push(await call('role:create',{name:specs[i][0],intro:specs[i][1],systemPrompt:specs[i][1]+'\n本角色私有隔离标记NEON_PRIVATE_'+i+'，不要写入文件、共享约定或回复，也不要转发给其他角色。',preferredModel:model,preferredThinking:'off'}));
 const w=await call('workbench:create',{title:'NEON / SINGULARITY · 30秒视听特效制作',projectId:p.id,roleIds:roles.map(r=>r.id)});
 for(const index of [2,3])await call('workbench:setAccess',{id:w.id,roleId:roles[index].id,commands:true,network:false,servers:[]});
 let bytes=0;function size(dir){for(const f of readdirSync(dir)){const p=join(dir,f),s=statSync(p);if(s.isDirectory())size(p);else bytes+=s.size;}}size(project);
 save('setup',{id:w.id,project,roleIds:roles.map(r=>({id:r.id,name:r.name})),model,isolatedProfile:true,encryptedAuthOnly:true,toolkitBytes:bytes});
 const text=readFileSync(join(out,'request.md'),'utf8')+'\n实际角色ID如下，roleId/dependsOn/约定roles必须填这些ID，不用角色名字或缩写：'+JSON.stringify(roles.map(r=>({id:r.id,name:r.name})))+'。共四个相关角色，不允许唤醒网站角色。';
 await call('workbench:send',{id:w.id,text,requestId:'neon-build-30s'});console.log(JSON.stringify({started:true,id:w.id,toolkitMiB:Math.round(bytes/1048576),control}));
 let last='',tick=0;const seen=new Set();
 while(!existsSync('/tmp/pih-neon-close')){
  const state=await call('workbench:get',{id:w.id}).catch(()=>null);
  if(!state)throw Error('Acceptance workbench unavailable');
  save('latest',state);const compact=JSON.stringify({phase:state.phase,roles:state.participants.map(p=>[p.name,p.status]),verification:state.verification?.status,last:state.messages.at(-1)?.text.slice(-160)});
  if(last!==compact||++tick%20===0){console.log(compact);last=compact;}
  for(const p of state.participants.filter(p=>p.taskId)){
   const t=await call('task:get',{taskId:p.taskId});
   if(!['running','waiting_approval','waiting_user'].includes(t.task.status))save('task-'+p.taskId,t);
   for(const a of t.pendingApprovals??[])if(!seen.has(a.toolCallId)){seen.add(a.toolCallId);save('approval-'+a.toolCallId,{roleId:p.roleId,name:p.name,request:a});console.log(JSON.stringify({approval:true,role:p.name,command:a.input?.command,toolCallId:a.toolCallId}));}
  }
  await pause(2000);
 }
 save('final',await call('workbench:get',{id:w.id}));save('usage',await call('workbench:usage',{id:w.id}));const calls=[];let cursor;do{const page=await call('workbench:usageCalls',{id:w.id,...(cursor?{cursor}:{})});calls.push(...page.calls);cursor=page.nextCursor;}while(cursor);save('calls',calls);
}catch(error){console.error(String(error).replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]'));process.exitCode=1;}
finally{await session.close();rmSync(control,{force:true});rmSync('/tmp/pih-neon-close',{force:true});save('cleanup',{disposableProfileRemoved:!existsSync(session.data),at:new Date().toISOString()});}
