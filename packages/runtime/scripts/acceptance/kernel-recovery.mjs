/** Current-source production IPC + native planning tools over offline HTTP/SSE. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';
import {desktopSession,pause} from './desktop-session.mjs';
import {configureFixture} from '../../src/stability/http-fixture.mjs';
const out=resolve('docs/role-workbench-v2/acceptance/kernel-recovery');mkdirSync(out,{recursive:true});
const data=mkdtempSync(join(tmpdir(),'pih-kernel-ipc-')),project=join(data,'project');mkdirSync(project);
const events=[];let session,a,b,resuming=false,sequence=0;
const server=createServer(async(req,res)=>{
 try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),text=JSON.stringify(body.messages),available=(body.tools??[]).map(t=>t.function?.name);
  const planning=available.includes('submit_role_plan'),routing=available.includes('submit_workbench_plan');
  const used=body.messages.flatMap(m=>(m.tool_calls??[]).map(c=>({name:c.function.name,args:JSON.parse(c.function.arguments)})));
  events.push({model:body.model,stage:routing?'routing':planning?'planning':'execution',resuming,privateA:text.includes('KERNEL_PRIVATE_A'),privateB:text.includes('KERNEL_PRIVATE_B')});
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const id='kernel-'+(++sequence),frame=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');
  frame({role:'assistant'});
  const send=(answer,tool)=>{if(tool)frame({tool_calls:[{index:0,id:'call-'+sequence,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]});else frame({content:answer});frame({},tool?'tool_calls':'stop');res.end('data: [DONE]\n\n');};
  const use=(name,args)=>send(null,{name,args});
  if(routing){assert(!resuming,'continuation called the router');return use('submit_workbench_plan',{reply:'设计后前端',action:'dispatch',assignments:[{roleId:a.id,instructions:'生成设计数据',files:['design/'],outputs:['design/spec.json'],dependsOn:[]},{roleId:b.id,instructions:'读取设计后实现页面',files:['site/'],outputs:['site/index.html'],dependsOn:[a.id]}]});}
  if(planning){assert(!resuming,'continuation replanned a role');return use('submit_role_plan',{plan:'按已确定职责交付',contracts:[]});}
  if(body.model==='worker-a'){
   if(!used.some(c=>c.name==='write'))return use('write',{path:'design/spec.json',content:'{"version":"1","title":"Kernel recovery"}'});
   return send('KERNEL_PRIVATE_A 设计完成');
  }
  if(!resuming){
   if(!used.some(c=>c.name==='write'))return use('write',{path:'site/partial.txt',content:'preserved-progress'});
   if(!available.includes('workbench_command'))return use('tool_search',{query:'workbench_command',limit:1});
   return use('workbench_command',{command:'printf should-not-run > site/unsafe.txt'});
  }
  if(!used.some(c=>c.name==='read'&&c.args.path==='site/partial.txt'))return use('read',{path:'site/partial.txt'});
  if(!used.some(c=>c.name==='read'&&c.args.path==='design/spec.json'))return use('read',{path:'design/spec.json'});
  assert(text.includes('preserved-progress'));assert(text.includes('Kernel recovery'));
  if(!used.some(c=>c.name==='write'))return use('write',{path:'site/index.html',content:'<!doctype html><html lang="zh"><title>Kernel recovery</title><h1>kernel-resumed</h1></html>'});
  send('KERNEL_PRIVATE_B 页面完成');
 }catch(error){res.destroy(error);}
});
const call=(name,input={})=>session.invoke(name,input);
async function until(test,label){for(let i=0;i<300;i++){const value=await test();if(value)return value;await pause(100);}throw Error('Timed out: '+label);}
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));configureFixture(data,`http://127.0.0.1:${server.address().port}/v1`);
 session=await desktopSession({dataDir:data,copyAuth:false,development:true,enableFaux:true});
 const ref=modelId=>({provider:'stability-http',modelId});await call('settings:set',{defaultModel:ref('router'),permissionMode:'bypass',autoApproveTools:[]});
 a=await call('role:create',{name:'设计',systemPrompt:'KERNEL_PRIVATE_A',preferredModel:ref('worker-a')});
 b=await call('role:create',{name:'前端',systemPrompt:'KERNEL_PRIVATE_B',preferredModel:ref('worker-b')});
 const p=await call('project:add',{dir:project}),w=await call('workbench:create',{title:'隔离网站恢复验收',projectId:p.id,roleIds:[a.id,b.id]});
 await call('workbench:send',{id:w.id,text:'开发小型静态网站',requestId:'initial'});
 const stopped=await until(async()=>{const x=await call('workbench:get',{id:w.id});assert.notEqual(x.phase,'error',x.messages.at(-1)?.text);return x.phase==='stopped'&&x;},'permission stop');
 assert.equal(stopped.participants.find(p=>p.roleId===b.id).status,'blocked');
 const upstream=stopped.participants.find(p=>p.roleId===a.id).taskId;
 await call('workbench:setAccess',{id:w.id,roleId:b.id,commands:true,network:false,servers:[]});
 const beforeRestart=events.length;await session.quit();session=await desktopSession({dataDir:data,copyAuth:false,development:true,enableFaux:true});await pause(200);assert.equal(events.length,beforeRestart);
 resuming=true;await call('workbench:send',{id:w.id,text:'继续',requestId:'resume'});
 const result=await until(async()=>{const x=await call('workbench:get',{id:w.id});assert.notEqual(x.phase,'error',x.messages.at(-1)?.text);return x.phase==='awaiting_review'&&x;},'resumed execution');
 assert.equal(result.participants.find(p=>p.roleId===a.id).taskId,upstream);assert(result.participants.every(p=>p.deliveryCheck?.status==='passed'));
 assert(!/KERNEL_PRIVATE_[AB]/.test(JSON.stringify(result.messages)));
 const completedCount=events.length;await call('workbench:send',{id:w.id,text:'继续',requestId:'already-finished'});assert.equal(events.length,completedCount);
 for(const role of [a,b]){const review=await call('workbench:review',{id:w.id,roleId:role.id});assert.equal(review.blockedReason,null);await call('workbench:apply',{id:w.id,roleId:role.id,reviewToken:review.token});}
 assert(readFileSync(join(project,'site/index.html'),'utf8').includes('kernel-resumed'));assert.equal(readFileSync(join(project,'site/partial.txt'),'utf8'),'preserved-progress');
 for(const e of events)assert(e.stage!=='execution'?!e.privateA&&!e.privateB:e.model==='worker-a'?e.privateA&&!e.privateB:e.privateB&&!e.privateA);
 const report={passed:true,at:new Date().toISOString(),realProductionIPC:true,nativePlanningTools:true,offlineHTTP:true,credentialCopy:false,restartNoReplay:true,continuationNoRouting:true,continuationNoReplanning:true,preservedUpstream:true,preservedPartial:true,sharedPrivateMarkers:0,objectiveChecksPassed:true,alreadyFinishedNoReplay:true,events,mainBuildSHA256:createHash('sha256').update(readFileSync(resolve('apps/desktop/out/main/index.js'))).digest('hex')};
 writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2));console.log('Native planning, pinned handoff and restart continuation acceptance passed.');
}catch(error){writeFileSync(join(out,'result.json'),JSON.stringify({passed:false,error:String(error)},null,2));throw error;}
finally{await session?.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(data,{recursive:true,force:true});writeFileSync(join(out,'cleanup.json'),JSON.stringify({disposableProfileRemoved:true}));}
