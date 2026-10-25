/** Packaged UI/IPC acceptance using offline SSE and a disposable project, never real auth. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {desktopSession,pause} from './desktop-session.mjs';
import {configureFixture} from '../../src/stability/http-fixture.mjs';
const data=mkdtempSync(join(tmpdir(),'pih-evidence-ui-')),project=join(data,'project'),out=resolve('docs/role-workbench-v2/acceptance/completion-evidence');mkdirSync(project);mkdirSync(out,{recursive:true});
let session,ws,a,b,seq=0;const pending=new Map(),events=[];
const server=createServer(async(req,res)=>{
 try{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),text=JSON.stringify(body.messages);
  events.push({model:body.model,execution:Boolean(body.tools?.length)&&!(body.tools??[]).some(t=>["submit_role_plan","submit_workbench_plan"].includes(t.function?.name)),privateA:text.includes('PRIVATE_ROLE_A'),privateB:text.includes('PRIVATE_ROLE_B'),receiptInPrompt:text.includes('ready_for_acceptance')||text.includes('completion_check')});
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const frame=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'evidence-fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n');frame({role:'assistant'});
  function send(answer,tool){if(tool)frame({tool_calls:[{index:0,id:'evidence-'+events.length,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]});else frame({content:answer});frame({},tool?'tool_calls':'stop');res.end('data: [DONE]\n\n');}
  if(text.includes('CHAT_EVIDENCE'))return send('普通问答仅表示本轮回复结束。');
  if(body.model==='router')return send(JSON.stringify({reply:'分别交付前后端文件，之后联调验收。',action:'dispatch',roleIds:[a.id,b.id],assignments:[a,b].map((r,i)=>({roleId:r.id,instructions:'交付职责内文件并验证',files:[i?'back.txt':'front.txt'],dependsOn:[],deliverables:[{path:i?'back.txt':'front.txt',format:'text',includes:['valid']}]}))}));
  if((body.tools??[]).some(t=>t.function?.name==='submit_role_plan'))return send(null,{name:'submit_role_plan',args:{plan:'按职责产出有效文件',contracts:[]}});
  if(!body.tools?.length)return send(JSON.stringify({plan:'按职责产出有效文件',contracts:[]}));
  const name=body.model==='worker-a'?'front':'back',used=body.messages.flatMap(m=>(m.tool_calls??[]).map(t=>t.function.name));
  if(!used.includes('write'))return send(null,{name:'write',args:{path:name+'.txt',content:'valid '+name}});
  send('职责文件已生成，等待验收。');
 }catch(error){res.destroy(error);}
});
async function until(check,label){const end=Date.now()+30000;while(Date.now()<end){const value=await check();if(value)return value;await pause(30);}throw Error('Timeout '+label);}
const invoke=(name,input={})=>session.invoke(name,input);
function cdp(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function connect(){const port=Number(readFileSync(join(data,'DevToolsActivePort'),'utf8').split('\n')[0]);const target=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t=>t.type==='page');ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});await cdp('Emulation.setDeviceMetricsOverride',{width:1460,height:980,deviceScaleFactor:1,mobile:false});}
async function shot(name){await pause(80);const r=await cdp('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,name),Buffer.from(r.data,'base64'));}
async function selectWorkbench(){await session.evaluate(`document.querySelector('button[aria-label="工作台"]').click();true`);await until(()=>session.evaluate(`!!document.querySelector('.wb-task')`),'workbench list');await session.evaluate(`document.querySelector('.wb-task').click();true`);await until(()=>session.evaluate(`!!document.querySelector('.wb-tabs')`),'task opened');await session.evaluate(`[...document.querySelectorAll('.wb-tabs button')].find(b=>b.textContent==='成果').click();true`);await until(()=>session.evaluate(`!!document.querySelector('.completion-evidence')`),'evidence panel');}
async function expandReport(){await session.evaluate(`document.querySelector('.completion-evidence').open=true;true`);await until(()=>session.evaluate(`document.querySelector('.completion-evidence')?.textContent.includes('必要角色')`),'report loaded');}
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));configureFixture(data,`http://127.0.0.1:${server.address().port}/v1`);session=await desktopSession({dataDir:data,copyAuth:false});await connect();
 const model=modelId=>({provider:'stability-http',modelId});await invoke('settings:set',{defaultModel:model('router'),permissionMode:'bypass',autoApproveTools:[]});
 a=await invoke('role:create',{name:'前端工程师',systemPrompt:'PRIVATE_ROLE_A',preferredModel:model('worker-a')});b=await invoke('role:create',{name:'后端工程师',systemPrompt:'PRIVATE_ROLE_B',preferredModel:model('worker-b')});
 const p=await invoke('project:add',{dir:project}),w=await invoke('workbench:create',{title:'统一交付证据验收',projectId:p.id,roleIds:[a.id,b.id]});
 await invoke('workbench:send',{id:w.id,text:'完成前后端文件，联调后验收。',requestId:'evidence-round'});
 const ended=await until(async()=>{const state=await invoke('workbench:get',{id:w.id});if(state.phase==='error')throw Error(state.messages.at(-1)?.text);return state.phase==='awaiting_review'&&state;},'execution');
 assert.equal((await invoke('completion:get',{scope:'workbench',id:w.id})).state,'needs_attention');
 for(const role of ended.participants){const review=await invoke('workbench:review',{id:w.id,roleId:role.roleId});await invoke('workbench:apply',{id:w.id,roleId:role.roleId,reviewToken:review.token});}
 const ready=await invoke('completion:get',{scope:'workbench',id:w.id});assert.equal(ready.state,'ready_for_acceptance');assert.equal(ready.evidence.filter(e=>e.kind==='artifact'&&e.status==='current').length,2);
 await invoke('workbench:verify',{id:w.id,commands:[`node -e "if(require('fs').readFileSync('front.txt','utf8')!=='valid front')process.exit(2)"`],network:false});
 await until(async()=>(await invoke('workbench:get',{id:w.id})).verification?.status!=='running','verification');
 const verified=await invoke('completion:get',{scope:'workbench',id:w.id});assert.equal(verified.state,'ready_for_acceptance');assert(verified.evidence.some(e=>e.kind==='verification'&&e.status==='current'));
 const count=events.length;await selectWorkbench();assert.equal(await session.evaluate(`document.querySelector('.completion-evidence').open`),false);await expandReport();
 await session.evaluate(`[...document.querySelectorAll('.completion-evidence li')].find(li=>li.textContent.includes('已声明交付检查')).querySelector('button').click();document.documentElement.dataset.theme='light';true`);await shot('evidence-light.png');
 await session.evaluate(`document.documentElement.dataset.theme='dark';true`);await shot('evidence-dark.png');
 await cdp('Emulation.setDeviceMetricsOverride',{width:980,height:760,deviceScaleFactor:1,mobile:false});await session.evaluate(`document.documentElement.dataset.theme='light';true`);await shot('evidence-narrow.png');
 const horizontalOverflow=await session.evaluate(`document.documentElement.scrollWidth>innerWidth`);assert.equal(horizontalOverflow,false);assert.equal(events.length,count,'reading evidence must not call a model');
 writeFileSync(join(project,'front.txt'),'tampered');await assert.rejects(()=>invoke('workbench:finish',{id:w.id,evidence:'旧证据不适用',memoryIds:[],completionToken:verified.token}));
 const stale=await invoke('completion:get',{scope:'workbench',id:w.id});assert.equal(stale.state,'needs_attention');assert(stale.evidence.some(e=>e.kind==='artifact'&&e.status==='stale'));
 writeFileSync(join(project,'front.txt'),'valid front');const fresh=await invoke('completion:get',{scope:'workbench',id:w.id});
 await invoke('workbench:finish',{id:w.id,evidence:'已核对前后端文件、选定联调退出码及实际交付内容。',memoryIds:[],completionToken:fresh.token});
 const accepted=await invoke('completion:get',{scope:'workbench',id:w.id});assert.equal(accepted.state,'accepted');assert(accepted.evidence.some(e=>e.kind==='user_confirmation'&&e.status==='current'));
 ws.close();await session.quit();session=await desktopSession({dataDir:data,copyAuth:false});await connect();assert.equal((await invoke('completion:get',{scope:'workbench',id:w.id})).state,'accepted');assert.equal(events.length,count);
 writeFileSync(join(project,'back.txt'),'later changed');const changed=await invoke('completion:get',{scope:'workbench',id:w.id});assert.equal(changed.state,'needs_attention');assert.equal(changed.evidence.find(e=>e.kind==='user_confirmation').status,'stale');assert.equal((await invoke('workbench:get',{id:w.id})).phase,'done','viewing does not mutate saved history');
 const chat=await invoke('task:create',{roleId:a.id,title:'普通问答证据'});await invoke('task:prompt',{taskId:chat.id,text:'CHAT_EVIDENCE 你好'});await until(async()=>(await invoke('task:get',{taskId:chat.id})).task.status==='done','chat');assert.equal((await invoke('completion:get',{scope:'chat',id:chat.id})).state,'reply_ended');
 assert(events.every(e=>e.model==='router'||(!e.execution?!e.privateA&&!e.privateB:e.model==='worker-a'?e.privateA&&!e.privateB:e.privateB&&!e.privateA)));assert(!events.some(e=>e.receiptInPrompt));
 writeFileSync(join(out,'verification.json'),JSON.stringify({passed:true,at:new Date().toISOString(),appAsarSHA256:createHash('sha256').update(readFileSync(join(session.app,'Contents/Resources/app.asar'))).digest('hex'),isolatedProfile:true,externalNetwork:false,realModel:false,executionNotAcceptance:true,twoCurrentArtifacts:true,realCommandReceipt:true,conditionEvidenceLinks:true,viewingAddsNoModelRequests:true,staleTokenRejected:true,userAcceptanceBoundToVersion:true,restartWithoutReplay:true,externalEditInvalidatesEvidence:true,readingDoesNotMutateHistory:true,chatRemainsReplyEnded:true,privatePromptLeaks:0,receiptNotInjectedIntoModels:true,horizontalOverflow,requestCount:events.length,screenshots:['evidence-light.png','evidence-dark.png','evidence-narrow.png'],events},null,2));console.log('Packaged completion evidence checks passed.');
}finally{ws?.close();await session?.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(data,{recursive:true,force:true});}
