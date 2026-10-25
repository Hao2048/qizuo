/** Explicit live benchmark: real coordinator, loopback specialist sinks, disposable data only. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,chmodSync,rmSync,existsSync } from 'node:fs';
import { join,resolve,dirname } from 'node:path';
import { tmpdir,homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { evaluate } from './evaluate-routing.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const args=Object.fromEntries(process.argv.slice(2).reduce((out,value,index,all)=>{
 if(value.startsWith('--'))out.push([value.slice(2),all[index+1]]);return out;
},[]));
if(!args.out || !args.provider || !args.model)throw Error('需要 --out、--provider、--model；本命令会调用真实模型，专业角色仅使用本地替身。');
const passes=Number(args.passes??2);if(!Number.isInteger(passes)||passes<1||passes>3)throw Error('passes 必须为1至3');
const samples=JSON.parse(readFileSync(args.samples??join(root,'docs/role-workbench-v2/acceptance/chinese-routing-samples.json'),'utf8'));
if(!Array.isArray(samples)||samples.length>40)throw Error('样本数量无效');
const output=resolve(args.out);if(existsSync(output))throw Error('输出目录已存在，请使用新目录以保留原采样');mkdirSync(output,{recursive:true});
const data=mkdtempSync(join(tmpdir(),'pih-routing-live-'));chmodSync(data,0o700);mkdirSync(join(data,'pi'));
const appDir=resolve(args.app??join(root,'apps/desktop/release/latest/mac-arm64/Pi Harness.app'));
const executable=join(appDir,'Contents/MacOS/Pi Harness');
const source=args['source-data']??join(homedir(),'Library/Application Support/@pi-harness/desktop/data');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fixtureCalls=[];let child,ws,db,server;const pending=new Map();let sequence=0;
let stopped=false;
const interrupt=()=>{stopped=true;child?.kill('SIGTERM');for(const q of pending.values()){clearTimeout(q.timer);q.reject(Error('评测已停止'));}pending.clear();};
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
try {
 // Copy only encrypted credentials. Never decrypt, print, export, or copy plugins/production DB.
 const auth=JSON.parse(readFileSync(join(source,'pi/auth.json'),'utf8'));
 if(auth.pihEnc!=='v1')throw Error('评测仅自动复用已加密的本机凭证，未复制明文凭证。');
 copyFileSync(join(source,'pi/auth.json'),join(data,'pi/auth.json'));chmodSync(join(data,'pi/auth.json'),0o600);
 server=createServer(async(req,res)=>{
  try {
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2_000_000)throw Error('fixture input too large');}
   const body=JSON.parse(raw),key=body.model;
   if(!['front','back','qa'].includes(key))throw Error('unknown fixture role');
   const text=JSON.stringify(body.messages),planning=text.includes('本轮仅做只读规划');
   const leaks=['front','back','qa'].filter(other=>other!==key && text.includes('PRIVATE_ROLE_'+other.toUpperCase()));
   fixtureCalls.push({role:key,stage:planning?'planning':'execution',ownCanarySeen:text.includes('PRIVATE_ROLE_'+key.toUpperCase()),isolationViolations:leaks});
   const reply=planning?JSON.stringify({plan:'受控验收替身接收本角色分工；不执行工具，不修改任何文件。',contracts:[]}):'本地验收替身已接收本角色任务；未执行工具、命令或插件。';
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   const frame=(delta,finish_reason=null,usage)=>'data: '+JSON.stringify({id:'controlled-specialist',object:'chat.completion.chunk',model:key,choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})+'\n\n';
   res.write(frame({role:'assistant',content:reply}));res.end(frame({},'stop',{prompt_tokens:1,completion_tokens:1,total_tokens:2})+'data: [DONE]\n\n');
  }catch{res.writeHead(400);res.end('fixture request rejected');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 writeFileSync(join(data,'pi/models.json'),JSON.stringify({providers:{'routing-specialist-fixture':{
  api:'openai-completions',apiKey:'dummy',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,
  models:['front','back','qa'].map(id=>({id,name:'本地角色验收替身 '+id,contextWindow:128000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}})),
 }}}),{mode:0o600});
 child=spawn(executable,['--remote-debugging-port=0'],{env:{...process.env,PIH_DATA_DIR:data,PIH_ENABLE_FAUX:'0'},stdio:'ignore'});
 let port;
 for(let i=0;i<300;i++){try{port=Number(readFileSync(join(data,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break;}catch{}await sleep(100);}
 if(!port)throw Error('隔离评测软件未启动');
 let target;
 for(let i=0;i<300;i++){target=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t=>t.type==='page');if(target)break;await sleep(100);}
 if(!target)throw Error('评测IPC未就绪');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',no,{once:true});});
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const q=pending.get(m.id);pending.delete(m.id);if(q){clearTimeout(q.timer);m.error?q.reject(Error(m.error.message)):q.resolve(m.result);}}});
 async function run(expression){return await new Promise((ok,no)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);no(Error('IPC timeout'));},120000);pending.set(id,{resolve:r=>{if(r.exceptionDetails)no(Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text));else ok(r.result.value);},reject:no,timer});ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});}
 for(let i=0;i<300 && !(await run('Boolean(window.pih)'));i++)await sleep(100);
 async function invoke(name,input={}) {return await run(`(async()=>{const r=await window.pih.invoke(${JSON.stringify(name)},${JSON.stringify(input)});if(!r.ok)throw Error(r.error.message);return r.result;})()`);}
 await run(`window.__routingAudit=[];window.pih.onEvent(event=>{if(event.type==='workbench:routingDecision'){window.__routingAudit.push(event.payload);if(window.__routingAudit.length>128)window.__routingAudit.shift();}});true`);
 const providers=(await invoke('model:list')).providers;
 const provider=providers.find(p=>p.id===args.provider);
 if(!provider?.authConfigured || !provider.models.some(m=>m.id===args.model))throw Error('指定模型未配置或本机加密凭证不可用');
 await invoke('settings:set',{defaultModel:{provider:args.provider,modelId:args.model},permissionMode:'ask',autoApproveTools:[]});
 const roleMap={};
 const descriptions={front:['前端工程师','负责 public/index.html、public/styles.css、public/app.js；页面布局、输入、交互；仅样式或提示文案不需要后台修改。'],back:['后端工程师','负责 server.mjs、data/leads.json；接口校验、业务逻辑、持久化；明确只改后端时不修改前端。'],qa:['测试工程师','负责 tests/；独立接口测试、验收；加入任务须经用户确认。']};
 for(const [key,[name,intro]] of Object.entries(descriptions)){
  const role=await invoke('role:create',{name,intro,systemPrompt:intro+'\nPRIVATE_ROLE_'+key.toUpperCase(),preferredModel:{provider:'routing-specialist-fixture',modelId:key}});roleMap[key]=role.id;
  await invoke('memory:write',{scopeType:'role',scopeId:role.id,title:'网站角色私有经验',content:'PRIVATE_ROLE_'+key.toUpperCase()+' 本角色的私有网站操作经验，仅适用于自己的职责。',tags:['routing-evaluation']});
 }
 const require=createRequire(join(root,'apps/desktop/package.json'));const Database=require('better-sqlite3');db=new Database(join(data,'harness.db'));db.pragma('foreign_keys=ON');db.pragma('busy_timeout=5000');
 const metadata={model:args.provider+'/'+args.model,startedAt:new Date().toISOString(),passes,
  methodology:'真实协调模型经打包软件生产路由；专业角色为回环HTTP受控替身，验证实际规划/执行调用，不评估专业模型工作质量。',
  appHash:createHash('sha256').update(readFileSync(join(appDir,'Contents/Resources/app.asar'))).digest('hex'),
  samplesHash:createHash('sha256').update(JSON.stringify(samples)).digest('hex'),
  runnerHash:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),roleMap};
 writeFileSync(join(output,'method.json'),JSON.stringify(metadata,null,2));
 const reports=[];
 for(let pass=1;pass<=passes;pass++){
  const capture={...metadata,pass,responses:[]};
  for(const sample of samples){
   if(stopped)throw Error('评测已停止');
   const roles=['front','back',...(sample.paused?.includes('qa')?['qa']:[])];
   const w=await invoke('workbench:create',{title:'路由质量评测 '+sample.id,roleIds:roles.map(k=>roleMap[k])});
   const row=db.prepare('SELECT body FROM workbenches WHERE id=?').get(w.id),body=JSON.parse(row.body);
   for(const p of body.participants){const key=Object.keys(roleMap).find(k=>roleMap[k]===p.roleId);p.responsibility=descriptions[key][1];}
   body.contracts=[{id:'lead-api',title:'联系表单保存接口',version:1,roles:[roleMap.front,roleMap.back],content:'POST /api/leads，已有 name 字段及可选 phone 字段，成功返回201。前端负责输入和提交；后端负责校验与保存。更改字段或保存行为需要双方对接；仅样式、输入提示和仅后端校验不改变接口。'}];
   body.messages.push({id:'fixture-context',requestId:'fixture-context',sender:'system',recipients:[],kind:'notice',text:'评测固定背景：已有网站，页面与服务各由前后端维护。以下是本轮新要求；不要重复构建全站或重做历史命令。',at:Date.now()-1000});
   db.prepare('UPDATE workbenches SET body=? WHERE id=?').run(JSON.stringify(body),w.id);
   for(const key of sample.paused??[])if(roles.includes(key))await invoke('workbench:setEnabled',{id:w.id,roleId:roleMap[key],enabled:false});
   const start=fixtureCalls.length,requestId=`eval-${pass}-${sample.id}`;
   await invoke('workbench:send',{id:w.id,requestId,text:sample.text});
   let state;const began=Date.now();
   for(;;){state=await invoke('workbench:get',{id:w.id});if(!['routing','planning','running'].includes(state.phase))break;if(Date.now()-began>110000){await invoke('workbench:stop',{id:w.id});throw Error('样本超时：'+sample.id);}await sleep(250);}
   const audit=await run(`window.__routingAudit.findLast(row=>row.id===${JSON.stringify(w.id)}&&row.requestId===${JSON.stringify(requestId)})??null`);
   const usage=await invoke('workbench:usage',{id:w.id,requestId});
   const sink=fixtureCalls.slice(start),error=state.phase==='error'?state.messages.findLast(m=>m.kind==='error')?.text??'执行路径失败':undefined;
   const result={id:sample.id,decision:audit?.decision??null,historySuppressed:audit?.historySuppressed??false,readOnlySuppressed:audit?.readOnlySuppressed??false,
    observed:{planningRoles:usage.roles.filter(r=>r.stage==='planning').map(r=>r.roleId),executionRoles:usage.roles.filter(r=>r.stage==='execution').map(r=>r.roleId),
      phase:state.phase,error,isolationViolations:sink.flatMap(r=>r.isolationViolations),fixtureCalls:sink.length,
      ownCanaryChecks:sink.map(r=>({role:r.role,stage:r.stage,seen:r.ownCanarySeen}))},
    coordinatorUsage:usage.roles.filter(r=>r.stage==='routing'),
    timing:{elapsedMs:Date.now()-began},error:!audit?(error??'未采集到有效路由决定'):undefined};
   capture.responses.push(result);writeFileSync(join(output,`capture-pass-${pass}.json`),JSON.stringify(capture,null,2));
   const report=evaluate(samples,capture);writeFileSync(join(output,`report-pass-${pass}.json`),JSON.stringify(report,null,2));
   console.log(JSON.stringify({pass,id:sample.id,result:report.results.find(r=>r.id===sample.id)}));
   await invoke('workbench:delete',{id:w.id});
  }
  reports.push(evaluate(samples,capture));
 }
 const summary={...metadata,completedAt:new Date().toISOString(),reports:reports.map(({results,...r})=>r),allPassed:reports.every(r=>r.passed===r.total&&r.missing===0),fixtureCallCount:fixtureCalls.length,isolationViolations:fixtureCalls.flatMap(r=>r.isolationViolations)};
 writeFileSync(join(output,'summary.json'),JSON.stringify(summary,null,2));if(!summary.allPassed)process.exitCode=1;
} finally {
 db?.close();ws?.close();
 for(const q of pending.values()){clearTimeout(q.timer);q.reject(Error('评测关闭'));}pending.clear();
 if(child && child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),sleep(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));
 rmSync(data,{recursive:true,force:true});
}
