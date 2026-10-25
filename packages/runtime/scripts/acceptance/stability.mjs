/** Real packaged app + offline SDK HTTP path. No formal profile, projects, auth or external network. */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { desktopSession, pause } from './desktop-session.mjs';
import { faultServer, configureFixture } from '../../src/stability/http-fixture.mjs';

const out=resolve(process.env.PIH_STABILITY_OUT??'docs/role-workbench-v2/acceptance/stability');
mkdirSync(out,{recursive:true});
const data=mkdtempSync(join(tmpdir(),'pih-packaged-stability-'));
const http=await faultServer(),started=Date.now();
const evidence={startedAt:new Date().toISOString(),isolatedProfile:true,externalNetwork:false,steps:[],samples:[],passed:false};
const save=()=>writeFileSync(join(out,'result.json'),JSON.stringify(evidence,null,2));
const note=(stage,detail)=>{evidence.steps.push({stage,at:new Date().toISOString(),...detail});save();console.log(stage,JSON.stringify(detail));};
let session;
const model=(modelId='router')=>({provider:'stability-http',modelId});
async function until(check,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const value=await check();if(value)return value;await pause(30);}throw Error('Timeout: '+label);}
const invoke=(...args)=>session.invoke(...args);
async function settled(taskId){return until(async()=>{const t=await invoke('task:get',{taskId});return ['done','error','cancelled'].includes(t.task.status)&&t;},'task settled');}
const open=()=>desktopSession({development:process.env.PIH_ACCEPTANCE_DEVELOPMENT==='1',dataDir:data,copyAuth:false,enableFaux:true});
function decision(roles){return {reply:'按独立职责执行',action:'dispatch',roleIds:roles.map(r=>r.id),assignments:roles.map((r,i)=>({roleId:r.id,instructions:'仅完成自己的内容',files:[`role-${i}/`],dependsOn:[]}))};}

try {
 configureFixture(data,http.url);session=await open();
 evidence.currentSourceBuild=process.env.PIH_ACCEPTANCE_DEVELOPMENT==='1';
 evidence[evidence.currentSourceBuild?'mainBuildSha256':'archiveSha256']=createHash('sha256').update(readFileSync(join(session.app,...(evidence.currentSourceBuild?['out/main/index.js']:['Contents/Resources/app.asar'])))).digest('hex');
 await invoke('settings:set',{defaultModel:model(),permissionMode:'ask',autoApproveTools:[]});
 const roles=await Promise.all(['A','B','C'].map((x,i)=>invoke('role:create',{name:'稳定性角色 '+x,systemPrompt:'PRIVATE_ROLE_'+x,preferredModel:model(['worker-a','worker-b','worker-c'][i])})));
 const memories=await Promise.all(roles.map((r,i)=>invoke('memory:write',{scopeType:'role',scopeId:r.id,title:'运行隔离',content:'PRIVATE_MEMORY_'+['A','B','C'][i]})));
 const tasks=await Promise.all(roles.map(r=>invoke('task:create',{title:r.name,roleId:r.id})));
 const workbenches=await Promise.all([0,1].map(i=>invoke('workbench:create',{title:'并发工作台 '+i,roleIds:roles.slice(0,2).map(r=>r.id)})));
 const duration=Number(process.env.PIH_STABILITY_DURATION_MS??300000),soakStart=Date.now();let rounds=0;
 do {
  const markers=tasks.map((_,i)=>`STABLE_soak_${rounds}_${i}`);
  for(const m of markers)http.scripts.set(m,{delay:50});
  await Promise.all(tasks.map((t,i)=>invoke('task:prompt',{taskId:t.id,text:'运行隔离 '+markers[i]})));
  const completed=await Promise.all(tasks.map(t=>settled(t.id)));
  completed.forEach((t,i)=>{assert.equal(t.task.status,'done');assert.equal(t.transcript.filter(m=>m.role==='user').length,rounds+1);assert(t.transcript.some(m=>m.text?.includes('DONE_'+markers[i])));});
  if(rounds%5===0){
    await Promise.all(workbenches.map(async(w,i)=>{const marker=`STABLE_wb_${rounds}_${i}`;http.scripts.set(marker,{decision:decision(roles.slice(0,2))});
      await invoke('workbench:send',{id:w.id,text:'运行隔离 '+marker,requestId:marker});
      const done=await until(async()=>{const x=await invoke('workbench:get',{id:w.id});if(x.phase==='error')throw Error('Workbench failed: '+x.messages.at(-1)?.text);return x.phase==='awaiting_review'&&x;},'workbench complete');
      assert(done.participants.every(p=>p.status==='awaiting_review'));
    }));
  }
  for(const marker of markers)http.scripts.delete(marker);
  const rssKiB=Number(execFileSync('ps',['-o','rss=','-p',String(session.pid)],{encoding:'utf8'}).trim());
  const t=performance.now();assert((await invoke('health:get',{})).ok);const ipcMs=performance.now()-t;
  evidence.samples.push({elapsedMs:Date.now()-soakStart,round:rounds,rssKiB,ipcMs:Math.round(ipcMs),httpActive:http.active});save();
  rounds++;if(rounds%10===0)console.log('soak',rounds,'rounds; rss MiB',Math.round(rssKiB/1024));
  if(Date.now()-soakStart<duration)await pause(1200);
 }while(Date.now()-soakStart<duration);
 await until(()=>http.active===0,'idle HTTP connections');
 const privateLeaks=http.events.filter(e=>e.model.startsWith('worker-')&&e.canaries.some(c=>c!=='PRIVATE_ROLE_'+({'worker-a':'A','worker-b':'B','worker-c':'C'}[e.model])));
 assert.deepEqual(privateLeaks,[]);
 const memoryLeaks=http.events.filter(e=>e.model.startsWith('worker-')&&e.memoryCanaries.some(c=>c!=='PRIVATE_MEMORY_'+({'worker-a':'A','worker-b':'B','worker-c':'C'}[e.model])));
 assert.deepEqual(memoryLeaks,[]);
 const positiveMemoryRoles=new Set(http.events.filter(e=>e.model.startsWith('worker-')&&e.memoryCanaries.length).map(e=>e.model));
 assert.equal(positiveMemoryRoles.size,3,'Memory isolation needs a positive retrieval control for every role');
 const warm=evidence.samples.filter(s=>s.elapsedMs>=Math.min(60000,duration/3));
 const growth=warm.length>1?warm.at(-1).rssKiB-warm[0].rssKiB:0;
 assert(growth<100*1024,'RSS growth exceeds the 100 MiB diagnostic threshold');
 note('continuous-concurrency',{durationMs:Date.now()-soakStart,chatRounds:rounds,chatRequests:rounds*3,workbenchRounds:Math.ceil(rounds/5)*2,peakHttp:http.peak,privateLeaks:0,memoryLeaks:0,positiveMemoryRoles:positiveMemoryRoles.size,warmRssGrowthKiB:growth});

 // Half-finished HTTP response + user abort + unrelated work continues.
 http.scripts.set('STABLE_cancel',{stall:true});
 await invoke('task:prompt',{taskId:tasks[0].id,text:'STABLE_cancel'});await until(()=>http.events.some(e=>e.marker==='STABLE_cancel'),'stall begins');
 await invoke('task:prompt',{taskId:tasks[1].id,text:'STABLE_unrelated'});
 await invoke('task:abort',{taskId:tasks[0].id});assert.equal((await settled(tasks[0].id)).task.status,'cancelled');assert.equal((await settled(tasks[1].id)).task.status,'done');
 note('cancel-stalled-network',{unrelatedTaskCompleted:true});

 // Persist unsent text+attachment, await approval, and kill only this disposable app.
 await invoke('draft:save',{kind:'chat',id:tasks[2].id,revision:0,patch:{text:'重启后应保留的未发草稿',attachments:[{kind:'text',name:'draft.txt',data:'角色 C 的草稿内容'}]}});
 const w=workbenches[0],file=await invoke('workbench:attach',{id:w.id,name:'unsent.txt',kind:'text',mimeType:'text/plain',data:Buffer.from('未发送附件').toString('base64')});
 await invoke('draft:save',{kind:'workbench',id:w.id,revision:0,patch:{text:'工作台未发送要求',attachmentIds:[file.id]}});
 http.scripts.set('STABLE_crash_chat',{stall:true});http.scripts.set('STABLE_crash_wb',{stall:'execution',decision:decision(roles.slice(0,2))});
 const forbidden=join(data,'personal','must-not-write.txt');http.scripts.set('STABLE_approval',{tool:{path:forbidden,content:'NOT APPROVED'}});
 await invoke('task:prompt',{taskId:tasks[0].id,text:'STABLE_crash_chat'});
 await invoke('task:prompt',{taskId:tasks[2].id,text:'STABLE_approval'});
 await until(async()=>{const t=await invoke('task:get',{taskId:tasks[2].id});return t.task.status==='waiting_approval'&&t.pendingApprovals.length;},'write approval');
 await invoke('workbench:send',{id:w.id,text:'STABLE_crash_wb',requestId:'crash-round'});
 await until(async()=>{const x=await invoke('workbench:get',{id:w.id});return x.phase==='running'&&x.participants.some(p=>p.status==='running');},'workbench execution');
 assert.equal(existsSync(forbidden),false);
 await session.crash();session=undefined;
 const crashCalls=http.events.length;
 let recovered;
 for(let cycle=0;cycle<3;cycle++){
  session=await open();await pause(300);
  const task=await invoke('task:get',{taskId:tasks[0].id}),approval=await invoke('task:get',{taskId:tasks[2].id}),wb=await invoke('workbench:get',{id:w.id});
  assert.equal(task.task.status,'cancelled');assert(task.task.recovery);
  assert.equal(approval.task.status,'cancelled');assert.equal(approval.pendingApprovals.length,0);assert.equal(existsSync(forbidden),false);
  assert.equal(wb.phase,'stopped');assert(wb.participants.every(p=>p.status!=='running'&&!p.pluginResources?.length));
  assert.equal(http.events.length,crashCalls,'Restart replayed a model request');
  for(let i=0;i<roles.length;i++){
    const stored=(await invoke('memory:list',{scopeType:'role',scopeId:roles[i].id})).items.find(m=>m.id===memories[i].id);
    assert.equal(stored?.content,memories[i].content);assert.equal(stored?.version,memories[i].version);
  }
  const draft=await invoke('draft:get',{kind:'chat',id:tasks[2].id}),wbDraft=await invoke('draft:get',{kind:'workbench',id:w.id});
  assert.equal(draft.draft.text,'重启后应保留的未发草稿');assert.equal(draft.draft.attachments[0].data,'角色 C 的草稿内容');
  assert.equal(wbDraft.draft.text,'工作台未发送要求');assert.equal((await invoke('workbench:readAttachment',{id:w.id,attachmentId:file.id})).data,Buffer.from('未发送附件').toString('base64'));
  const receipt={taskStatus:task.task.status,noticeCount:wb.messages.filter(m=>m.text.includes('上次执行中断')).length,recovery:task.task.recovery};
  if(recovered)assert.deepEqual(receipt,recovered);recovered=receipt;
  if(cycle<2){await session.quit();session=undefined;}
 }
 note('hard-crash-and-restart',{restartCycles:3,normalWindowQuitCycles:2,noModelReplay:true,noUnapprovedWrite:true,chatAndWorkbenchDraftsRestored:true,recoveryIdempotent:true});
 await invoke('task:prompt',{taskId:tasks[0].id,text:'STABLE_after_restart'});assert.equal((await settled(tasks[0].id)).task.status,'done');
 for(const w of workbenches)await invoke('workbench:delete',{id:w.id});
 for(const t of tasks)await invoke('task:delete',{taskId:t.id});
 const activity=await invoke('task:listActivity',{});assert.equal(activity.items.length,0);
 note('post-restart-use-and-cleanup',{freshRequestCompleted:true,liveTasks:0});
 const typed=await session.evaluate(`(()=>{const el=document.querySelector('textarea');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'稳定性验收：窗口关闭前的最后一次输入');el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
 assert(typed,'Actual composer was not mounted');
 await session.quit();session=undefined;session=await open();
 const restored=await invoke('draft:get',{kind:'chat',id:null});
 assert.equal(restored.draft.text,'稳定性验收：窗口关闭前的最后一次输入');
 note('renderer-close-flush',{actualTextareaInput:true,normalCloseBeforeReopen:true,lastInputRestored:true});
 evidence.passed=true;
} catch(error){evidence.error=String(error).replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]');process.exitCode=1;console.error(evidence.error);}
finally {
 await session?.close();await http.close();rmSync(data,{recursive:true,force:true});
 evidence.elapsedMs=Date.now()-started;evidence.profileRemoved=!existsSync(data);evidence.finishedAt=new Date().toISOString();save();
}
