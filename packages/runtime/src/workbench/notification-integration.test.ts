import {beforeEach,afterEach,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {createHarnessCore,type HarnessCore} from '../core/harness-core.js';
import {ensureFauxRegistered,fauxModelRef} from '../pi/faux-provider.js';
let core:HarnessCore,dir:string,a:string,b:string;
const json=(value:unknown)=>fauxAssistantMessage(JSON.stringify(value));
const tool=(name:string,args:Parameters<typeof fauxToolCall>[1],id?:string)=>fauxAssistantMessage([fauxToolCall(name,args,id?{id}:undefined)]);
async function invoke(name:string,input:unknown={}):Promise<any>{const r=await core.router.invoke(name,input);if(!r.ok)throw Error(r.error.message);return r.result;}
async function wait(id:string){for(let i=0;i<400;i++){const w=core.workbench.get(id);if(w.phase==='error')throw Error(JSON.stringify(w.messages.at(-1)));if(w.phase==='awaiting_review')return w;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');}
function route(roleId:string,file:string){ensureFauxRegistered().setResponses([json({reply:'只安排对应角色',action:'dispatch',roleIds:[roleId],assignments:[{roleId,instructions:'按本轮要求处理自己负责的文件',files:[file],dependsOn:[]}]})]);}
beforeEach(async()=>{
 dir=mkdtempSync(join(tmpdir(),'pih-notifications-'));core=await createHarnessCore({dataDir:dir,enableFaux:true});
 await invoke('settings:set',{defaultModel:fauxModelRef(),permissionMode:'bypass',autoApproveTools:[]});
 a=(await invoke('role:create',{name:'前端',systemPrompt:'FRONT_PRIVATE_PROMPT',preferredModel:fauxModelRef('a')})).id;
 b=(await invoke('role:create',{name:'后端',systemPrompt:'BACK_PRIVATE_PROMPT',preferredModel:fauxModelRef('b')})).id;
});
afterEach(async()=>{await core.shutdown();rmSync(dir,{recursive:true,force:true});});
async function sendPending(count=1){
 const w=await invoke('workbench:create',{title:'通知闭环',roleIds:[a,b]});await invoke('workbench:setEnabled',{id:w.id,roleId:b,enabled:false});
 route(a,'front.txt');
 ensureFauxRegistered('a').setResponses([json({plan:'前端工作',contracts:[]}),tool('tool_search',{query:'workbench_notify',limit:1}),
 ...Array.from({length:count},(_,i)=>tool('workbench_notify',{roleId:b,message:'SHARED_NOTE_'+i,sender:b,taskId:'forged',requestId:'forged',toolCallId:'forged'},'notice-'+i)),
 tool('workbench_notify',{roleId:b,message:'SHARED_NOTE_0'},'different-retry'),fauxAssistantMessage('前端完成；后端仍暂停')]);
 await invoke('workbench:send',{id:w.id,text:'只做前端，给后端留交接信息',requestId:'first'});await wait(w.id);return core.workbench.get(w.id);
}
it('真实SDK通知去重，暂停角色不启动；重启保留队列，显式唤醒后才送达，处理回执不替代验收',async()=>{
 let w=await sendPending();const notification=w.messages.find(m=>m.notification)!;
 expect(w.messages.filter(m=>m.notification)).toHaveLength(1);expect(notification.notification?.status).toBe('pending');
 expect(notification.sender).toBe(a);expect(notification.requestId).toBe('first');expect(notification.notification?.sourceTaskId).toBe(w.participants.find(p=>p.roleId===a)?.taskId);expect(notification.notification?.sourceToolCallId).toBe('notice-0');
 expect(w.participants.find(p=>p.roleId===b)).toMatchObject({enabled:false,taskId:null,status:'paused'});
 const countBefore=(await invoke('workbench:usage',{id:w.id})).roles.filter((r:any)=>r.roleId===b).length;expect(countBefore).toBe(0);
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});w=core.workbench.get(w.id);
 expect(w.messages.find(m=>m.id===notification.id)?.notification?.status).toBe('pending');expect((await invoke('workbench:usage',{id:w.id})).roles.filter((r:any)=>r.roleId===b)).toHaveLength(0);
 await invoke('workbench:setEnabled',{id:w.id,roleId:b,enabled:true});expect(core.workbench.get(w.id).messages.find(m=>m.id===notification.id)?.notification?.status).toBe('pending');
 route(b,'back.txt');let firstContext='',afterHandled='';
 ensureFauxRegistered('b').setResponses([json({plan:'后端处理',contracts:[]}),
 ctx=>{firstContext=JSON.stringify(ctx);expect(core.workbench.get(w.id).messages.find(m=>m.id===notification.id)?.notification?.status).toBe('delivered');return tool('tool_search',{query:'workbench_acknowledge',limit:1});},
 tool('workbench_acknowledge',{notificationIds:[notification.id],summary:'已核对共享事项并完成本角色配套处理'}),
 ctx=>{afterHandled=JSON.stringify(ctx);return fauxAssistantMessage('后端完成，待审阅');}]);
 await invoke('workbench:send',{id:w.id,text:'现在由后端处理自己的部分',requestId:'second'});w=await wait(w.id);
 expect(firstContext).toContain('SHARED_NOTE_0');expect(firstContext).not.toContain('FRONT_PRIVATE_PROMPT');
 expect(afterHandled).not.toContain('SHARED_NOTE_0');
 expect(w.messages.find(m=>m.id===notification.id)?.notification).toMatchObject({status:'handled',handlingNote:'已核对共享事项并完成本角色配套处理',deliveredTaskId:w.participants.find(p=>p.roleId===b)?.taskId});
 expect(w.phase).toBe('awaiting_review');expect(w.verification?.status).not.toBe('passed');
 const taskId=w.participants.find(p=>p.roleId===b)!.taskId!;
 const staleTool=core.workbench.toolsFor(taskId).find(t=>t.name==='workbench_acknowledge')!;
 await expect(staleTool.execute('stale',{notificationIds:[notification.id],summary:'旧运行误确认'},new AbortController().signal,()=>{},{} as never)).rejects.toThrow('暂停');
 const recorded=JSON.stringify(w.messages.find(m=>m.id===notification.id)?.notification);
 await core.shutdown();core=await createHarnessCore({dataDir:dir,enableFaux:true});
 expect(JSON.stringify(core.workbench.get(w.id).messages.find(m=>m.id===notification.id)?.notification)).toBe(recorded);
 await invoke('workbench:delete',{id:w.id});expect(()=>core.workbench.get(w.id)).toThrow('不存在');
 expect(core.db.prepare('SELECT * FROM workbench_runs WHERE workbench_id=?').all(w.id)).toHaveLength(0);
});
it('大量通知不截掉旧项：上下文只带一条全文，显式读取最多4条；未读确认拒绝且跨角色不可确认',async()=>{
 let w=await sendPending(7);const notices=w.messages.filter(m=>m.notification);expect(notices).toHaveLength(7);
 await invoke('workbench:setEnabled',{id:w.id,roleId:b,enabled:true});route(b,'back.txt');let first='',batch='',failed='',left='';
 ensureFauxRegistered('b').setResponses([json({plan:'处理通知',contracts:[]}),
 ctx=>{first=JSON.stringify(ctx);return tool('tool_search',{query:'workbench_acknowledge',limit:1});},
 tool('workbench_acknowledge',{notificationIds:[notices[6]!.id],summary:'尚未读取却声称完成'}),
 ctx=>{failed=JSON.stringify(ctx);return tool('tool_search',{query:'workbench_notifications',limit:1});},
 tool('workbench_notifications',{}),
 ctx=>{batch=JSON.stringify(ctx);return tool('workbench_acknowledge',{notificationIds:notices.slice(0,4).map(m=>m.id),summary:'已核对前四项'});},
 ctx=>{left=JSON.stringify(ctx);return fauxAssistantMessage('仍有三项未处理，不宣称交付');}]);
 await invoke('workbench:send',{id:w.id,text:'由后端检查交接事项',requestId:'read'});w=await wait(w.id);
 expect(first).toContain('SHARED_NOTE_0');expect(first).not.toContain('SHARED_NOTE_6');expect(first).toContain('remainingNotifications');
 expect(failed).toContain('先读取');expect(batch).toContain('SHARED_NOTE_3');expect(batch).not.toContain('SHARED_NOTE_6');
 expect(left).toContain('SHARED_NOTE_4');
 expect(w.messages.filter(m=>m.notification?.status==='handled')).toHaveLength(4);
 expect(w.messages.find(m=>m.id===notices[6]!.id)?.notification?.status).toBe('pending');
});
