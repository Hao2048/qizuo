import {afterEach,expect,it,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import TimeMemories from './components/TimeMemories.js';import {invoke,onEvent} from './api.js';import {useStore} from './store.js';
vi.mock('./api.js',()=>({invoke:vi.fn(),onEvent:vi.fn(()=>()=>{})}));vi.mock('./data.js',()=>({openTask:vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();vi.mocked(onEvent).mockReturnValue(()=>{});useStore.setState({memoryQuery:''});});
it('creates an enabled once-off memory for only the selected role and supports pause and removal',async()=>{
 const item={id:'s1',roleId:'role-a',title:'明日整理',instructions:'整理事项',rule:{kind:'once',at:'2027-01-02T01:00:00Z'},enabled:true,status:'scheduled',nextRun:1798851600000,lastError:'',activeTaskId:null,lastTaskId:null};let items:any[]=[];
 vi.mocked(invoke).mockImplementation(async(name,input:any)=>{if(name==='time-memory:list')return {items,now:0,timezone:'Asia/Shanghai'} as never;if(name==='time-memory:create'){items=[item];return item as never;}if(name==='time-memory:setEnabled'){items=[{...item,enabled:input.enabled}];return items[0] as never;}if(name==='time-memory:remove'){items=[];return {ok:true} as never;}return {} as never;});
 render(<TimeMemories roleId="role-a"/>);fireEvent.click(screen.getByRole('button',{name:'新增时间记忆'}));
 fireEvent.change(screen.getByLabelText('标题'),{target:{value:'明日整理'}});fireEvent.change(screen.getByLabelText('到时做什么'),{target:{value:'整理事项'}});fireEvent.change(screen.getByLabelText('执行日期与时间'),{target:{value:'2027-01-02T09:00'}});fireEvent.click(screen.getByRole('button',{name:'创建时间记忆'}));
 await screen.findByRole('heading',{name:'明日整理'});expect(invoke).toHaveBeenCalledWith('time-memory:create',expect.objectContaining({roleId:'role-a',enabled:true,instructions:'整理事项',rule:expect.objectContaining({kind:'once'})}));
 fireEvent.click(screen.getByRole('button',{name:'停用'}));await screen.findByRole('button',{name:'启用'});expect(invoke).toHaveBeenCalledWith('time-memory:setEnabled',{id:'s1',roleId:'role-a',enabled:false});
 fireEvent.click(screen.getByRole('button',{name:'移除'}));await screen.findByText('还没有时间记忆');expect(invoke).toHaveBeenCalledWith('time-memory:remove',{id:'s1',roleId:'role-a'});
});
it('does not run missed entries without a click and hides stale data when changing roles',async()=>{
 vi.mocked(invoke).mockResolvedValue({items:[{id:'missed',roleId:'role-a',title:'错过的整理',instructions:'整理事项',rule:{kind:'once',at:'2020-01-01T00:00:00Z'},enabled:false,status:'missed',nextRun:null,lastError:'已错过，不自动补跑',activeTaskId:null,lastTaskId:null}]} as never);
 const view=render(<TimeMemories roleId="role-a"/>);const button=await screen.findByRole('button',{name:'补执行一次'});expect(invoke).not.toHaveBeenCalledWith('time-memory:run',expect.anything());fireEvent.click(button);await waitFor(()=>expect(invoke).toHaveBeenCalledWith('time-memory:run',{id:'missed',roleId:'role-a'}));
 view.rerender(<TimeMemories roleId="role-b"/>);await waitFor(()=>expect(screen.queryByRole('heading',{name:'错过的整理'})).toBeNull());
});

it('switches frequency-specific controls and submits only the applicable time rule',async()=>{
 vi.mocked(invoke).mockResolvedValue({items:[]} as never);
 render(<TimeMemories roleId="role-a"/>);fireEvent.click(screen.getByRole('button',{name:'新增时间记忆'}));
 fireEvent.change(screen.getByLabelText('标题'),{target:{value:'定时整理'}});fireEvent.change(screen.getByLabelText('到时做什么'),{target:{value:'整理事项'}});
 fireEvent.change(screen.getByLabelText('执行日期与时间'),{target:{value:'2027-01-02T09:00'}});
 fireEvent.click(screen.getByRole('radio',{name:'每天执行'}));
 expect(screen.queryByLabelText('执行日期与时间')).toBeNull();expect(screen.queryByRole('group',{name:'每周执行日（可多选）'})).toBeNull();
 expect(screen.getByLabelText('执行小时').querySelectorAll('option')).toHaveLength(24);
 fireEvent.change(screen.getByLabelText('执行小时'),{target:{value:'23'}});fireEvent.change(screen.getByLabelText('执行分钟'),{target:{value:'45'}});
 fireEvent.click(screen.getByRole('button',{name:'创建时间记忆'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('time-memory:create',expect.objectContaining({rule:{kind:'daily',time:'23:45',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone}})));
 fireEvent.click(screen.getByRole('button',{name:'新增时间记忆'}));
 fireEvent.change(screen.getByLabelText('标题'),{target:{value:'每周整理'}});fireEvent.change(screen.getByLabelText('到时做什么'),{target:{value:'整理事项'}});fireEvent.click(screen.getByRole('radio',{name:'每周执行'}));
 expect(screen.queryByLabelText('执行日期与时间')).toBeNull();fireEvent.click(screen.getByRole('checkbox',{name:'周五'}));
 fireEvent.click(screen.getByRole('button',{name:'创建时间记忆'}));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('time-memory:create',expect.objectContaining({rule:{kind:'weekly',time:'09:00',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,weekdays:[1,5]}})));
});
