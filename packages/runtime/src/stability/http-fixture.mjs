/** Offline fault server: exercises the real SDK HTTP/SSE path; no external credentials. */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function faultServer() {
  const events = [], pending = new Set(), scripts = new Map();
  let active = 0, peak = 0;
  const server = createServer(async (req, res) => {
    let body;
    try { let raw=''; for await(const chunk of req) raw+=chunk; body=JSON.parse(raw); }
    catch { res.writeHead(400); res.end(); return; }
    active++; peak=Math.max(peak,active); pending.add(res);
    res.once('close',()=>{ active--; pending.delete(res); });
    const planning=(body.tools??[]).some(t=>t.function?.name==='submit_role_plan');
    const routing=(body.tools??[]).some(t=>t.function?.name==='submit_workbench_plan');
    const execution=!!body.tools?.length&&!planning&&!routing;
    const text=JSON.stringify(body.messages), marker=[...text.matchAll(/STABLE_[A-Za-z0-9_-]+/g)].at(-1)?.[0]??'unknown';
    const base=scripts.get(marker)??{},script=base.models?.[body.model]??base;
    events.push({model:body.model,marker,at:Date.now(),hasTools:execution,
      canaries:['PRIVATE_ROLE_A','PRIVATE_ROLE_B','PRIVATE_ROLE_C'].filter(c=>text.includes(c)),
      memoryCanaries:['PRIVATE_MEMORY_A','PRIVATE_MEMORY_B','PRIVATE_MEMORY_C'].filter(c=>text.includes(c))});
    if(script.status){res.writeHead(script.status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Injected offline provider failure',type:'fixture'}}));return;}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.flushHeaders();
    const frame=(delta,finish_reason=null,usage)=>res.write('data: '+JSON.stringify({id:'stability-fixture',object:'chat.completion.chunk',model:body.model,choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})+'\n\n');
    frame({role:'assistant'});
    if(script.stall && (script.stall!=='execution'||execution)){frame({reasoning_content:'Waiting for offline fixture'});return;}
    if(script.cut && (script.cut!=='execution'||execution)){frame({content:'PARTIAL_'+marker});setTimeout(()=>res.destroy(),20);return;}
    const timer=setTimeout(()=>{
      if(res.destroyed)return;
      if(script.tool && execution && !script.toolSent){
        script.toolSent=true;
        frame({tool_calls:[{index:0,id:'stability-write',type:'function',function:{name:'write',arguments:JSON.stringify(script.tool)}}]});
        frame({},'tool_calls');res.end('data: [DONE]\n\n');return;
      }
      if(planning){
        frame({tool_calls:[{index:0,id:'stability-plan',type:'function',function:{name:'submit_role_plan',arguments:JSON.stringify({plan:'隔离完成当前职责',contracts:[]})}}]});
        frame({},'tool_calls');res.end('data: [DONE]\n\n');return;
      }
      let content=script.reply??'DONE_'+marker;
      if(body.model==='router')content=JSON.stringify(script.decision??{reply:'ACK_'+marker,action:'clarify',roleIds:[],assignments:[]});
      else if(!body.tools?.length)content=JSON.stringify({plan:'隔离完成当前职责',contracts:[]});
      frame({content});frame({},'stop',{prompt_tokens:200,completion_tokens:20,total_tokens:220,prompt_tokens_details:{cached_tokens:100}});
      res.end('data: [DONE]\n\n');
    },script.delay??15);
    res.once('close',()=>clearTimeout(timer));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}/v1`;
  return {url,events,scripts,get active(){return active;},get peak(){return peak;},
    disconnect(){for(const res of pending)res.destroy();},
    async close(){for(const res of pending)res.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}

export function configureFixture(dataDir,url) {
  mkdirSync(join(dataDir,'pi'),{recursive:true});
  const models=['router','worker-a','worker-b','worker-c'].map(id=>({id,name:id,reasoning:true,input:['text','image'],contextWindow:128000,maxTokens:8000,compat:{thinkingFormat:'deepseek'},cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}));
  writeFileSync(join(dataDir,'pi/models.json'),JSON.stringify({providers:{'stability-http':{api:'openai-completions',apiKey:'offline-fixture-only',baseUrl:url,models}}}));
}
