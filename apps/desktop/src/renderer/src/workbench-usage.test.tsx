import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkbenchUsage } from './components/WorkbenchUsage.js';
import { invoke } from './api.js';
vi.mock('./api.js',()=>({invoke:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const data=(name:string,costUSD:number|null=null)=>({roles:[{roleId:'r',name,stage:'planning' as const,calls:2,receiptCalls:1,failedCalls:1,interruptedCalls:0,activeCalls:0,inputTokens:100,outputTokens:8,cacheReadTokens:null,cacheReceiptCalls:0,costUSD,costReceiptCalls:costUSD===null?0:1,lastDurationMs:1250}]});
it('shows unknown fields separately from zero and invokes only the readonly usage endpoint',async()=>{
 vi.mocked(invoke).mockResolvedValue(data('前端',0));render(<WorkbenchUsage id="a" revision={1}/>);
 await screen.findByText('前端');expect(screen.getByText('$0.000000')).toBeTruthy();expect(screen.getAllByText('—').length).toBeGreaterThan(0);expect(screen.getByText(/费用回执 1\/2/)).toBeTruthy();
 expect(vi.mocked(invoke).mock.calls).toEqual([['workbench:usage',{id:'a'}]]);
});
it('never replaces the selected task with a late response from another workbench',async()=>{
 let resolve!:(v:any)=>void;vi.mocked(invoke).mockImplementationOnce(()=>new Promise(r=>{resolve=r}) as any).mockResolvedValue(data('新任务角色'));
 const view=render(<WorkbenchUsage id="old" revision={1}/>);view.rerender(<WorkbenchUsage id="new" revision={1}/>);
 await screen.findByText('新任务角色');resolve(data('旧任务角色'));await waitFor(()=>expect(screen.queryByText('旧任务角色')).toBeNull());
});
it('reports read failure and retries without any model or permission command',async()=>{
 vi.mocked(invoke).mockRejectedValueOnce(Error('离线')).mockResolvedValue({roles:[]});render(<WorkbenchUsage id="a" revision={1}/>);
 await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'重试用量读取'}));
 await screen.findByText(/暂无已记录的模型调用/);expect(vi.mocked(invoke).mock.calls.every(([name])=>name==='workbench:usage')).toBe(true);
});
it('filters a selected round, shows exact call timing and reads detail pages only when expanded',async()=>{
 const fixture={...data('前端'),rounds:[{requestId:'first',at:1,label:'第一轮修改'}]};
 vi.mocked(invoke).mockImplementation(async(name:any,input:any)=>{
  if(name==='workbench:usage')return fixture as any;
  if(name==='workbench:usageCalls')return {calls:[{id:input.cursor?'two':'one',requestId:'first',roleId:'r',name:'调用角色',stage:'execution',provider:'fixture',model:'local',status:'completed',at:1,firstResponseMs:100,firstTextMs:450,durationMs:900}],nextCursor:input.cursor?null:'next'} as any;
  throw Error('unexpected mutation');
 });
 render(<WorkbenchUsage id="a" revision={1}/>);await screen.findByText('前端');
 expect(vi.mocked(invoke).mock.calls.some(([name])=>name==='workbench:usageCalls')).toBe(false);
 fireEvent.change(screen.getByRole('combobox',{name:'用量统计轮次'}),{target:{value:'first'}});
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('workbench:usage',{id:'a',requestId:'first'}));
 const details=screen.getByText('逐次调用与响应耗时').closest('details')!;details.open=true;fireEvent(details,new Event('toggle'));
 await screen.findByText('调用角色');expect(screen.getByText('0.45 秒')).toBeTruthy();expect(screen.getByText('0.10 秒')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'加载更早调用'}));await waitFor(()=>expect(screen.getAllByText('调用角色')).toHaveLength(2));
 expect(invoke).toHaveBeenCalledWith('workbench:usageCalls',{id:'a',requestId:'first',cursor:'next'});
});
