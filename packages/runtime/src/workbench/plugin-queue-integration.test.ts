import{afterEach,beforeEach,expect,it,vi}from'vitest';
import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{createHarnessCore,type HarnessCore}from'../core/harness-core.js';import{ensureFauxRegistered,fauxModelRef}from'../pi/faux-provider.js';
import{fauxAssistantMessage,fauxToolCall}from'@earendil-works/pi-ai';import{callWorkbenchPlugin}from'../market/mcp-authorization.js';
vi.mock('../market/mcp-authorization.js',async original=>({...await original<typeof import('../market/mcp-authorization.js')>(),callWorkbenchPlugin:vi.fn()}));
let core:HarnessCore,dir:string,a:string,b:string,unblock:(()=>void)|undefined;
const json=(x:unknown)=>fauxAssistantMessage(JSON.stringify(x));
const plugin=(server:string,owner:string)=>fauxAssistantMessage([fauxToolCall('workbench_plugin',{server,tool:'control',arguments:{owner}})]);
async function call(name:string,input:unknown={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('test condition not reached');}
async function approve(ids:string[]){for(const id of ids){for(const p of core.workbench.get(id).participants){if(!p.taskId)continue;const task=await call('task:get',{taskId:p.taskId});for(const req of task.pendingApprovals??[])await call('approval:decide',{taskId:p.taskId,toolCallId:req.toolCallId,approved:true});}}}
async function start(roles:string[],requestId:string){
 const w=await call('workbench:create',{title:requestId,roleIds:roles});
 for(const roleId of roles)await call('workbench:setAccess',{id:w.id,roleId,commands:false,network:false,servers:['desktop_one','desktop_two']});
 ensureFauxRegistered().setResponses([json({reply:'分别操作',action:'dispatch',roleIds:roles,assignments:roles.map(roleId=>({roleId,instructions:'使用已授权插件',files:[roleId===a?'a/':'b/'],dependsOn:[]}))})]);
 await call('workbench:send',{id:w.id,text:'执行',requestId});return w.id as string;
}
beforeEach(async()=>{
 vi.clearAllMocks();dir=mkdtempSync(join(tmpdir(),'pih-plugin-queue-'));core=await createHarnessCore({dataDir:dir,enableFaux:true});
 await call('settings:set',{defaultModel:fauxModelRef(),permissionMode:'auto_edit',autoApproveTools:['read']});
 a=(await call('role:create',{name:'角色 A',preferredModel:fauxModelRef('a')})).id;b=(await call('role:create',{name:'角色 B',preferredModel:fauxModelRef('b')})).id;
 for(const name of ['desktop_one','desktop_two']){await call('mcp:add',{name,url:'https://example.com/'+name});await call('mcp:setResourcePolicy',{name,exclusive:true,resourceGroup:'computer'});}
});
afterEach(async()=>{unblock?.();unblock=undefined;await core.shutdown();rmSync(dir,{recursive:true,force:true});});
it('two plugins sharing a computer never interleave role sessions, keep approvals, and clear the UI after completion',async()=>{
 const events:string[]=[];let gateResolve!:()=>void;const gate=new Promise<void>(r=>gateResolve=r);unblock=gateResolve;
 vi.mocked(callWorkbenchPlugin).mockImplementation(async(_dir,_server,_tool,args)=>{events.push(String(args.owner));if(events.length===1)await gate;return 'ok';});
 ensureFauxRegistered('a').setResponses([json({plan:'操作',contracts:[]}),plugin('desktop_one','a1'),plugin('desktop_two','a2'),fauxAssistantMessage('完成')]);
 ensureFauxRegistered('b').setResponses([json({plan:'操作',contracts:[]}),plugin('desktop_two','b1'),fauxAssistantMessage('完成')]);
 const id=await start([a,b],'sessions');
 await until(async()=>{await approve([id]);return core.workbench.get(id).participants.some(p=>p.pluginResources?.some(r=>r.status==='waiting'));});
 expect(events).toHaveLength(1);await expect(call('mcp:setResourcePolicy',{name:'desktop_one',exclusive:false,resourceGroup:'computer'})).rejects.toThrow('停止工作台');
 gateResolve();
 await until(async()=>{await approve([id]);return core.workbench.get(id).phase==='awaiting_review';});
 expect(events).toHaveLength(3);
 if(events[0]==='a1')expect(events).toEqual(['a1','a2','b1']);else expect(events).toEqual(['b1','a1','a2']);
 expect(core.workbench.get(id).participants.every(p=>!p.pluginResources?.length)).toBe(true);
});
it('stopping a queued workbench does not cancel the holder in another workbench or invoke the queued plugin',async()=>{
 const gate=new Promise<void>(r=>unblock=r),events:string[]=[];
 vi.mocked(callWorkbenchPlugin).mockImplementation(async(_dir,_server,_tool,args)=>{events.push(String(args.owner));await gate;return 'ok';});
 ensureFauxRegistered('a').setResponses([json({plan:'操作',contracts:[]}),plugin('desktop_one','a'),fauxAssistantMessage('完成')]);
 ensureFauxRegistered('b').setResponses([json({plan:'操作',contracts:[]}),plugin('desktop_two','b'),fauxAssistantMessage('完成')]);
 const first=await start([a],'holder');await until(async()=>{await approve([first]);return events.length===1;});
 const second=await start([b],'waiter');await until(async()=>{await approve([second]);return !!core.workbench.get(second).participants[0]?.pluginResources?.some(r=>r.status==='waiting');});
 await call('workbench:stop',{id:second});expect(events).toEqual(['a']);expect(core.workbench.get(first).phase).toBe('running');
 unblock!();await until(()=>core.workbench.get(first).phase==='awaiting_review');expect(events).toEqual(['a']);
 expect(core.workbench.get(second).participants.every(p=>!p.pluginResources?.length)).toBe(true);
});
it('explicit parallel mode bypasses the exclusive lease for a concurrency-capable plugin',async()=>{
 await call('mcp:setResourcePolicy',{name:'desktop_one',exclusive:false,resourceGroup:''});
 const gate=new Promise<void>(r=>unblock=r),events:string[]=[];
 vi.mocked(callWorkbenchPlugin).mockImplementation(async(_dir,_server,_tool,args)=>{events.push(String(args.owner));await gate;return 'ok';});
 for(const [name,owner]of [['a','a'],['b','b']])ensureFauxRegistered(name).setResponses([json({plan:'并行查询',contracts:[]}),plugin('desktop_one',owner!),fauxAssistantMessage('完成')]);
 const id=await start([a,b],'parallel');await until(async()=>{await approve([id]);return events.length===2;});
 unblock!();await until(()=>core.workbench.get(id).phase==='awaiting_review');expect(events.sort()).toEqual(['a','b']);
});
it('restart clears stale resource indicators instead of replaying plugin operations',async()=>{
 const w=await call('workbench:create',{title:'恢复',roleIds:[a]});
 const state=core.workbench.get(w.id);state.participants[0]!.pluginResources=[{resource:'computer',status:'using',position:0}];
 core.db.prepare('UPDATE workbenches SET body=? WHERE id=?').run(JSON.stringify(state),w.id);
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 expect(core.workbench.get(w.id).participants[0]!.pluginResources).toBeUndefined();expect(callWorkbenchPlugin).not.toHaveBeenCalled();
});
