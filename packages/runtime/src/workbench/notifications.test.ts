import {expect,it} from 'vitest';
import type {Workbench} from '@pi-harness/contracts';
import {enqueueNotification,pendingNotifications,notificationBatch,deliverNotifications,acknowledgeNotifications} from './notifications.js';
const state=():Workbench=>({id:'w',title:'网站',projectId:null,phase:'running',revision:1,participants:[{roleId:'a',name:'前端',enabled:true,status:'running',taskId:'ta',responsibility:''},{roleId:'b',name:'后端',enabled:false,status:'paused',taskId:null,responsibility:''}],messages:[],recommendations:[],contracts:[],proposals:[],createdAt:1,updatedAt:1});
function send(w:Workbench,message='接口字段需对齐',call='tool-1') {return enqueueNotification(w,{taskId:'ta',toolCallId:call,requestId:'q',sender:'a',roleId:'b',message});}
it('暂停角色只收到队列数据，不改变启停和任务；同次调用及相同内容的工具重试合并，调用标识换内容拒绝',()=>{
 const w=state(),m=send(w);expect(m.notification?.status).toBe('pending');expect(send(w).id).toBe(m.id);expect(send(w,m.text,'tool-2').id).toBe(m.id);
 expect(w.messages).toHaveLength(1);expect(w.participants[1]).toMatchObject({enabled:false,status:'paused',taskId:null});
 expect(()=>send(w,'改为删除数据')).toThrow('标识');
});
it('只允许当前任务其他角色，拒绝空文本、自发、虚构接收方、停用或不可用发送方',()=>{
 const w=state();expect(()=>send(w,' ')).toThrow('无效');
 for(const roleId of ['a','missing'])expect(()=>enqueueNotification(w,{taskId:'ta',toolCallId:'t',requestId:'q',sender:'a',roleId,message:'x'})).toThrow('其他');
 w.participants[0]!.enabled=false;expect(()=>send(w)).toThrow('暂停');
 w.participants[0]!.enabled=true;w.participants[0]!.unavailable=true;expect(()=>send(w)).toThrow('不可用');
});
it('队列按最早未处理顺序，不静默丢旧通知；每个接收角色上限40条',()=>{
 const w=state();for(let i=0;i<40;i++)send(w,'通知'+i,'call'+i);
 expect(pendingNotifications(w,'b')[0]?.text).toBe('通知0');expect(pendingNotifications(w,'a')).toHaveLength(0);
 expect(()=>send(w,'第41条','call41')).toThrow('40');
 expect(send(w,'通知0','duplicate').text).toBe('通知0');
});
it('仅明确提供的通知可确认，未读、其他角色或跨任务确认被拒绝，批量验证失败不部分更新',()=>{
 const w=state(),a=send(w),b=send(w,'第二条','t2');
 expect(()=>acknowledgeNotifications(w,'b','tb',[a.id],'已处理')).toThrow('先读取');
 expect(deliverNotifications(w,'a','ta',[a.id])).toBe(false);
 expect(deliverNotifications(w,'b','tb',[a.id])).toBe(true);
 expect(()=>acknowledgeNotifications(w,'a','ta',[a.id],'冒充')).toThrow('不属于');
 expect(()=>acknowledgeNotifications(w,'b','another',[a.id],'旧执行')).toThrow('本次');
 expect(()=>acknowledgeNotifications(w,'b','tb',[a.id,b.id],'一部分未读')).toThrow('先读取');
 expect(a.notification?.status).toBe('delivered');
 acknowledgeNotifications(w,'b','tb',[a.id],'已将接口与前端对齐');
 expect(a.notification).toMatchObject({status:'handled',handledTaskId:'tb',handlingNote:'已将接口与前端对齐'});
 expect(pendingNotifications(w,'b').map(m=>m.id)).toEqual([b.id]);
});
it('送达不冒充已处理，重复请求不刷新回执；换执行只更新接收记录，重复确认不新增消息',()=>{
 const w=state(),m=send(w);deliverNotifications(w,'b','first',[m.id]);const at=m.notification?.deliveredAt;
 expect(deliverNotifications(w,'b','first',[m.id])).toBe(false);expect(m.notification?.deliveredAt).toBe(at);
 deliverNotifications(w,'b','next',[m.id]);expect(m.notification).toMatchObject({status:'delivered',deliveredTaskId:'next'});
 acknowledgeNotifications(w,'b','next',[m.id],'已核查');const receipt=JSON.stringify(m);
 acknowledgeNotifications(w,'b','next',[m.id],'再次确认');
 expect(JSON.stringify(m)).toBe(receipt);expect(w.messages).toHaveLength(1);
 expect(deliverNotifications(w,'b','third',[m.id])).toBe(false);
});
it('旧交接不捏造送达状态；角色交接不自动把旧角色通知传给新角色',()=>{
 const w=state(),m=send(w);w.messages.push({id:'legacy',requestId:'old',sender:'a',recipients:['b'],kind:'handoff',text:'旧交接',at:0});
 expect(pendingNotifications(w,'b').map(m=>m.id)).toEqual([m.id]);
 w.participants[1]!.roleId='replacement';
 expect(pendingNotifications(w,'replacement')).toHaveLength(0);expect(m.notification?.status).toBe('pending');
});

it('显式读取保留完整通知和先后顺序，正文预算不因四条长通知膨胀或截断',()=>{
 const w=state(),first=send(w,'甲'.repeat(3000),'first'),second=send(w,'乙'.repeat(2000),'second');
 expect(notificationBatch(pendingNotifications(w,'b'))).toEqual([first]);
 deliverNotifications(w,'b','tb',[first.id]);acknowledgeNotifications(w,'b','tb',[first.id],'已核对');
 expect(notificationBatch(pendingNotifications(w,'b'))).toEqual([second]);
 expect(second.text).toHaveLength(2000);
});
