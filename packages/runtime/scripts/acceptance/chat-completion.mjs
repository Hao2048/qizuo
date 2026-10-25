/** Offline packaged UI/IPC acceptance. Never copies credentials or the formal profile. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {desktopSession,pause} from './desktop-session.mjs';
import {configureFixture} from '../../src/stability/http-fixture.mjs';
const data=mkdtempSync(join(tmpdir(),'pih-completion-ui-'));
const out=resolve('docs/role-workbench-v2/acceptance/chat-completion');mkdirSync(out,{recursive:true});
let session,ws,seq=0;const pending=new Map(),events=[];
const server=createServer(async(req,res)=>{
 try{
  let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),messages=body.messages;
  const userIndex=messages.findLastIndex(m=>m.role==='user'),request=JSON.stringify(messages[userIndex]?.content),text=JSON.stringify(messages);
  const used=messages.slice(userIndex+1).flatMap(m=>(m.tool_calls??[]).map(t=>t.function.name));
  events.push({model:body.model,request,privateA:text.includes('PRIVATE_ROLE_A'),privateB:text.includes('PRIVATE_ROLE_B'),receiptInPrompt:/completion_check|needs_attention|reply_ended/.test(text)});
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const frame=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'completion-fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');frame({role:'assistant'});
  function send(answer,tool,finish='stop'){
   if(tool)frame({tool_calls:[{index:0,id:'completion-'+events.length,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]});else frame({content:answer});
   frame({},tool?'tool_calls':finish);res.end('data: [DONE]\n\n');
  }
  if(request.includes('COMPLETION_PLAN')&&!used.includes('update_plan'))return send(null,{name:'update_plan',args:{steps:[{content:'生成网站联系表单',status:'in_progress'},{content:'验证保存接口',status:'pending'}]}});
  if(request.includes('COMPLETION_TOOL')&&!used.includes('read'))return send(null,{name:'read',args:{path:join(data,'not-created.txt')}});
  if(request.includes('COMPLETION_DENY')&&!used.includes('write'))return send(null,{name:'write',args:{path:join(data,'denied.txt'),content:'must not be written'}});
  if(request.includes('COMPLETION_LENGTH'))return send('这段回复尚未结束',null,'length');
  send(request.includes('COMPLETION_REVIEW')?'根据历史记录回顾，不继续执行。':'全部完成。');
 }catch(error){res.destroy(error);}
});
async function until(check,label){const end=Date.now()+30000;while(Date.now()<end){const value=await check();if(value)return value;await pause(30);}throw Error('Timeout: '+label);}
const invoke=(name,input)=>session.invoke(name,input);
const settled=id=>until(async()=>{const r=await invoke('task:get',{taskId:id});return ['done','error','cancelled'].includes(r.task.status)&&r;},'task settled');
function cdp(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function connect(){
 const port=Number(readFileSync(join(data,'DevToolsActivePort'),'utf8').split('\n')[0]);const target=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t=>t.type==='page');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 await cdp('Emulation.setDeviceMetricsOverride',{width:1400,height:920,deviceScaleFactor:1,mobile:false});
}
async function select(task){
 await until(()=>session.evaluate(`[...document.querySelectorAll('.ctx-item.task')].some(b=>b.querySelector('strong')?.textContent===${JSON.stringify(task.title)})`),'task in sidebar');
 await session.evaluate(`[...document.querySelectorAll('.ctx-item.task')].find(b=>b.querySelector('strong')?.textContent===${JSON.stringify(task.title)}).click();true`);
 await until(()=>session.evaluate(`document.querySelector('.completion-check')!==null`),'completion notice');
}
async function screenshot(name){await pause(80);const r=await cdp('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,name),Buffer.from(r.data,'base64'));}
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));configureFixture(data,`http://127.0.0.1:${server.address().port}/v1`);
 session=await desktopSession({dataDir:data,copyAuth:false});await connect();
 await invoke('settings:set',{defaultModel:{provider:'stability-http',modelId:'worker-a'},permissionMode:'bypass',autoApproveTools:[]});
 const a=await invoke('role:create',{name:'网站工程师',systemPrompt:'PRIVATE_ROLE_A',preferredModel:{provider:'stability-http',modelId:'worker-a'}});
 const b=await invoke('role:create',{name:'资料分析师',systemPrompt:'PRIVATE_ROLE_B',preferredModel:{provider:'stability-http',modelId:'worker-b'}});
 const task=await invoke('task:create',{title:'网站交付一致性检查',roleId:a.id});
 await invoke('task:prompt',{taskId:task.id,text:'COMPLETION_PLAN 请完成网站并验证接口。'});
 const planned=await settled(task.id);assert.equal(planned.task.completion.outcome,'needs_attention');assert.equal(planned.task.completion.issues[0].code,'plan_pending');
 await select(planned.task);assert.equal(await session.evaluate(`document.querySelector('.completion-check').open`),false);
 assert((await session.evaluate(`document.querySelector('.status-pill').textContent`)).includes('需核对'));
 const callsBeforeView=events.length;await session.evaluate(`document.documentElement.dataset.theme='light';document.querySelector('.completion-check').open=true;true`);await screenshot('plan-light.png');
 await session.evaluate(`document.documentElement.dataset.theme='dark';true`);await screenshot('plan-dark.png');
 await cdp('Emulation.setDeviceMetricsOverride',{width:980,height:760,deviceScaleFactor:1,mobile:false});await session.evaluate(`document.documentElement.dataset.theme='light';true`);await screenshot('plan-narrow.png');
 const horizontalOverflow=await session.evaluate(`document.documentElement.scrollWidth>innerWidth`);assert.equal(horizontalOverflow,false);
 const chatHeight=await session.evaluate(`document.querySelector('.chat-workspace').getBoundingClientRect().height`);assert(chatHeight>80);
 assert.equal(events.length,callsBeforeView);
 const receipt=planned.task.completion;ws.close();await session.quit();session=await desktopSession({dataDir:data,copyAuth:false});await connect();
 assert.deepEqual((await invoke('task:get',{taskId:task.id})).task.completion,receipt);await select(planned.task);assert.equal(await session.evaluate(`document.querySelector('.completion-check').open`),false);assert.equal(events.length,callsBeforeView);
 await invoke('task:prompt',{taskId:task.id,text:'COMPLETION_REVIEW 之前做了什么？只回顾。'});const review=await settled(task.id);
 assert.equal(review.task.completion.outcome,'reply_ended');assert.equal(review.task.plan[0].status,'in_progress');await until(()=>session.evaluate(`!document.querySelector('.completion-check')`),'notice cleared');
 const failure=await invoke('task:create',{roleId:a.id,title:'工具失败检查'}),other=await invoke('task:create',{roleId:b.id,title:'独立角色问答'});
 await invoke('task:prompt',{taskId:failure.id,text:'COMPLETION_TOOL 读取文件。'});await invoke('task:prompt',{taskId:other.id,text:'COMPLETION_HELLO 你好。'});
 assert((await settled(failure.id)).task.completion.issues.some(i=>i.code==='tool_failed'));assert.equal((await settled(other.id)).task.completion.outcome,'reply_ended');
 const truncated=await invoke('task:create',{roleId:a.id,title:'截断检查'});await invoke('task:prompt',{taskId:truncated.id,text:'COMPLETION_LENGTH 回答问题。'});
 assert((await settled(truncated.id)).task.completion.issues.some(i=>i.code==='response_incomplete'));
 await invoke('settings:set',{defaultModel:{provider:'stability-http',modelId:'worker-a'},permissionMode:'ask',autoApproveTools:[]});
 const denied=await invoke('task:create',{roleId:a.id,title:'拒绝批准检查'});await invoke('task:prompt',{taskId:denied.id,text:'COMPLETION_DENY 写入文件。'});
 const approval=await until(async()=>(await invoke('task:get',{taskId:denied.id})).pendingApprovals[0],'approval');
 await invoke('approval:decide',{taskId:denied.id,toolCallId:approval.toolCallId,approved:false});assert((await settled(denied.id)).task.completion.issues.some(i=>i.code==='tool_failed'));assert.equal(existsSync(join(data,'denied.txt')),false);
 const activity=await invoke('task:listActivity');assert.equal(activity.items.find(i=>i.id===denied.id).completion.outcome,'needs_attention');
 assert(events.every(e=>e.model==='worker-b'?e.privateB&&!e.privateA:e.privateA&&!e.privateB));assert(!events.some(e=>e.receiptInPrompt));
 writeFileSync(join(out,'verification.json'),JSON.stringify({passed:true,at:new Date().toISOString(),appAsarSHA256:createHash('sha256').update(readFileSync(join(session.app,'Contents/Resources/app.asar'))).digest('hex'),isolatedProfile:true,externalNetwork:false,realModel:false,unfinishedPlanDetected:true,viewingAddsNoRequests:true,restartAddsNoRequests:true,receiptRestored:true,historyDoesNotReplayOrInheritPlan:true,toolFailureDetected:true,deniedWriteNotExecuted:true,truncationDetected:true,privatePromptLeaks:0,receiptNotInjectedIntoPrompt:true,horizontalOverflow,chatHeight,requestCount:events.length,screenshots:['plan-light.png','plan-dark.png','plan-narrow.png'],events},null,2));
 console.log('Packaged completion checks passed: plan, tool failure, truncation, approval denial, role isolation, restart and light/dark/narrow UI.');
}finally{ws?.close();await session?.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(data,{recursive:true,force:true});}
