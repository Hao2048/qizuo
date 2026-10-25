import {afterEach,it,expect} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import NotificationReceipt from './components/NotificationReceipt.js';
import type {WorkbenchMessage,WorkbenchParticipant} from '@pi-harness/contracts';
afterEach(cleanup);
const message=(status:'pending'|'delivered'|'handled'='pending'):WorkbenchMessage=>({id:'m',requestId:'q',sender:'a',recipients:['b'],kind:'handoff',text:'对齐接口',at:1,notification:{sourceTaskId:'ta',sourceToolCallId:'tool',status}});
const recipient:WorkbenchParticipant={roleId:'b',name:'后端',enabled:false,status:'paused',taskId:null,responsibility:''};
it('暂停和不可用接收方显示待送达与阻塞原因，不显示已处理',()=>{
 const view=render(<NotificationReceipt message={message()} recipient={recipient}/>);
 expect(screen.getByText('待送达')).toBeTruthy();expect(screen.getByText(/接收角色已暂停/)).toBeTruthy();expect(screen.queryByText('接收角色已确认处理')).toBeNull();
 view.rerender(<NotificationReceipt message={message()} recipient={{...recipient,unavailable:true}}/>);expect(screen.getByText(/不可用/)).toBeTruthy();
});
it('带入上下文与处理回执分别表达，处理结果按文本显示且不伪装成果已验收',()=>{
 const view=render(<NotificationReceipt message={message('delivered')} recipient={{...recipient,enabled:true}}/>);
 expect(screen.getByText('已带入接收方上下文 · 待处理')).toBeTruthy();
 view.rerender(<NotificationReceipt message={{...message('handled'),notification:{...message('handled').notification!,handlingNote:'<script>只是文字</script>'}}} recipient={recipient}/>);
 expect(screen.getByText('接收角色已确认处理')).toBeTruthy();expect(screen.getByText(/成果仍须/)).toBeTruthy();
 expect(screen.getByText('<script>只是文字</script>')).toBeTruthy();expect(document.querySelector('script')).toBeNull();
});
it('角色已替换时提示用户重新安排，旧消息不虚构状态',()=>{
 const view=render(<NotificationReceipt message={message()}/>);expect(screen.getByText(/接收角色已交接/)).toBeTruthy();
 const legacy={...message()};delete legacy.notification;
 view.rerender(<NotificationReceipt message={legacy} recipient={recipient}/>);expect(screen.queryByLabelText('协作通知状态')).toBeNull();
});
it('协作自动执行状态和只读答复分别表达，不把排队或执行当作已处理',()=>{
 const m=message();m.notification!.purpose='collaboration';m.notification!.automatic={state:'queued',roleChain:['a']};
 const view=render(<NotificationReceipt message={m} recipient={{...recipient,enabled:true}}/>);
 expect(screen.getByText('请求协作')).toBeTruthy();expect(screen.getByText(/安全边界/)).toBeTruthy();
 m.notification!.automatic={state:'blocked',roleChain:['a'],reason:'本轮没有后端分工，等待用户安排'};
 view.rerender(<NotificationReceipt message={m} recipient={{...recipient,enabled:true}}/>);
 expect(screen.getByText(/本轮没有后端分工/)).toBeTruthy();expect(screen.queryByText('接收角色已确认处理')).toBeNull();
 m.notification!.purpose='question';m.notification!.status='handled';m.notification!.handlingNote='沿用既有字段';m.notification!.automatic!.state='completed';
 view.rerender(<NotificationReceipt message={m} recipient={{...recipient,enabled:true}}/>);
 expect(screen.getByText('角色已只读答复')).toBeTruthy();expect(screen.getByText('沿用既有字段')).toBeTruthy();expect(screen.getByText(/成果仍须/)).toBeTruthy();
});
it('暂停、停止和历史请求不显示仍在自动执行，查看不会改变通知回执',()=>{
 const m=message();m.notification!.purpose='question';m.notification!.automatic={state:'running',roleChain:['a']};
 const original=JSON.stringify(m);
 const view=render(<NotificationReceipt message={m} recipient={recipient} phase='running'/>);
 expect(screen.getByText(/接收角色已暂停/)).toBeTruthy();expect(screen.queryByText(/正在只读答复/)).toBeNull();
 view.rerender(<NotificationReceipt message={m} recipient={{...recipient,enabled:true}} phase='stopped'/>);
 expect(screen.getByText(/本轮已结束推进/)).toBeTruthy();
 view.rerender(<NotificationReceipt message={m} recipient={{...recipient,enabled:true}} phase='running' isCurrent={false}/>);
 expect(screen.getByText(/历史协作请求/)).toBeTruthy();expect(JSON.stringify(m)).toBe(original);
});
