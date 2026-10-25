import {it,expect,vi,afterEach,beforeEach} from 'vitest';
import {render,screen,fireEvent,waitFor,act,cleanup} from '@testing-library/react';
import MemoryUsage from './components/MemoryUsage.js';
import {invoke} from './api.js';
import {useStore} from './store.js';
import {openTask} from './data.js';
import {selectWorkbench} from './workbench-data.js';
import type {MemoryUsageInfo} from '@pi-harness/contracts';
vi.mock('./api.js',()=>({invoke:vi.fn()}));
vi.mock('./data.js',()=>({openTask:vi.fn().mockResolvedValue(undefined)}));
vi.mock('./workbench-data.js',()=>({selectWorkbench:vi.fn().mockResolvedValue(undefined)}));
const result=(roleId='a',memoryId:string|null='m'):MemoryUsageInfo=>({roleId,memoryId,observedSince:1,summary:{total:10,automaticTotal:7,automaticRetained:3,automaticPending:2,automaticForgotten:2,automaticRevised:1,referencedMemories:2},referenceTotal:1,references:memoryId?[{version:2,taskId:'t',workbenchId:null,stage:'execution',title:'我的后续任务',firstAt:1,lastAt:2,subsequent:true}]:[]});
beforeEach(()=>{useStore.setState({page:"memory",tool:"memory",memoryRoleId:"a"});vi.clearAllMocks();vi.mocked(invoke).mockResolvedValue(result() as never);});
afterEach(cleanup);
const expand=()=>fireEvent.click(screen.getByRole('button',{name:/记忆使用情况/}));
it('默认收起且不读取，展开后加载当前角色，明确上下文引用非效果证明并可打开原任务',async()=>{
 render(<MemoryUsage roleId="a" memoryId="m" revision={1}/>);
 expect(invoke).not.toHaveBeenCalled();expand();
 await screen.findByText('我的后续任务');
 expect(invoke).toHaveBeenCalledWith('memory:usage',{roleId:'a',memoryId:'m'});
 expect(screen.getByText(/不证明服务商接收、模型采纳或任务成功/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:/我的后续任务/}));
 await waitFor(()=>expect(openTask).toHaveBeenCalledWith('t'));
 await waitFor(()=>expect(useStore.getState().page).toBe('workbench'));
});
it('切换角色或记忆期间立即隐藏旧记录，晚到响应不能泄露其他角色信息',async()=>{
 let resolve!:(value:MemoryUsageInfo)=>void;
 vi.mocked(invoke).mockImplementation(async(_name,input)=> (input as {roleId:string}).roleId==='a'?await new Promise<never>(r=>{resolve=r as never;}):result('b','n') as never);
 const view=render(<MemoryUsage roleId="a" memoryId="m" revision={1}/>);expand();
 view.rerender(<MemoryUsage roleId="b" memoryId="n" revision={1}/>);
 await screen.findByText('我的后续任务');
 await act(async()=>resolve({...result(),references:[{...result().references[0]!,title:'旧角色私有任务'}]}));
 expect(screen.queryByText('旧角色私有任务')).toBeNull();
 expect(invoke).toHaveBeenLastCalledWith('memory:usage',{roleId:'b',memoryId:'n'});
});
it('拒绝不匹配的服务端响应，错误可重试，失败不显示伪造的零统计',async()=>{
 vi.mocked(invoke).mockResolvedValueOnce(result('b') as never);
 render(<MemoryUsage roleId="a" memoryId="m" revision={1}/>);expand();
 await screen.findByRole('alert');expect(screen.queryByText('自动来源记录')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'重试'}));await screen.findByText('当前采纳');
 expect(invoke).toHaveBeenCalledTimes(2);
});
it('工作台引用打开工作台，读取当前版本，不加载历史正文，引用列表展示截断范围',async()=>{
 vi.mocked(invoke).mockResolvedValue({...result(),referenceTotal:21,references:[{...result().references[0]!,workbenchId:'w',stage:'planning'}]} as never);
 render(<MemoryUsage roleId="a" memoryId="m" revision={1}/>);expand();
 await screen.findByText(/显示最近 20 组/);
 fireEvent.click(screen.getByRole('button',{name:/我的后续任务/}));
 await waitFor(()=>expect(selectWorkbench).toHaveBeenCalledWith('w'));expect(openTask).not.toHaveBeenCalled();
 await waitFor(()=>expect(useStore.getState().page).toBe('collaboration'));
});
it('空记忆角色仍展示状态统计，未有观测显示无记录而非回填历史引用',async()=>{
 vi.mocked(invoke).mockResolvedValue({...result(),referenceTotal:0,references:[]} as never);
 render(<MemoryUsage roleId="a" memoryId="m" revision={1}/>);expand();
 await screen.findByText('尚无记录的上下文引用。');
 expect(screen.getByText(/不补算此前记录/)).toBeTruthy();
});

it('离开记忆页后原任务加载的晚到结果不强行导航',async()=>{
 let resolve!:()=>void;
 vi.mocked(openTask).mockImplementationOnce(()=>new Promise<void>(r=>{resolve=r;}));
 render(<MemoryUsage roleId="a" memoryId="m" revision={1}/>);expand();
 await screen.findByText('我的后续任务');
 fireEvent.click(screen.getByRole('button',{name:/我的后续任务/}));
 useStore.setState({page:'roles',tool:'roles'});
 await act(async()=>resolve());
 expect(useStore.getState().page).toBe('roles');
});
