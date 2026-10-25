import{afterEach,expect,it,vi}from'vitest';import{cleanup,render,screen,fireEvent,waitFor}from'@testing-library/react';
import PluginResourcePolicy from'./components/PluginResourcePolicy.js';import{invoke}from'./api.js';
vi.mock('./api.js',()=>({invoke:vi.fn().mockResolvedValue({ok:true})}));afterEach(()=>{cleanup();vi.clearAllMocks();});
it('defaults to session-exclusive queuing and saves a shared computer group',async()=>{
 render(<PluginResourcePolicy server={{name:'desktop',kind:'http',enabled:true}} onSaved={()=>{}}/>);
 expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
 fireEvent.change(screen.getByLabelText('共享资源 desktop'),{target:{value:'computer'}});fireEvent.click(screen.getByText('保存使用方式'));
 await waitFor(()=>expect(invoke).toHaveBeenCalledWith('mcp:setResourcePolicy',{name:'desktop',exclusive:true,resourceGroup:'computer'}));
});
it('keeps failed settings edits visible instead of reporting success',async()=>{
 vi.mocked(invoke).mockRejectedValueOnce(Error('请先停止工作台执行'));
 render(<PluginResourcePolicy server={{name:'desktop',kind:'http',enabled:true}} onSaved={()=>{}}/>);
 fireEvent.click(screen.getByText('保存使用方式'));expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('停止工作台'));
});
