import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {Workbench,WorkbenchParticipant} from '@pi-harness/contracts';
import {WorkbenchReview} from './panels/WorkbenchReview.js';import {invoke} from './api.js';
vi.mock('./api.js',()=>({invoke:vi.fn()}));afterEach(()=>{cleanup();vi.resetAllMocks();});
const w={id:'wb',contracts:[],proposals:[]} as unknown as Workbench;
const p={roleId:'front',taskId:'task',status:'awaiting_review'} as WorkbenchParticipant;
const action=async(fn:()=>Promise<unknown>)=>{await fn();};
it('opens selected HTML as a preview or reveals its file without applying the role result',async()=>{
 vi.mocked(invoke).mockImplementation(async(name)=>{
  if(name==='workbench:review')return {token:'receipt',total:1,conflicts:0,blockedReason:null,files:[{path:'index.html',kind:'added',conflict:false}]} as never;
  if(name==='workbench:reviewFile')return {path:'index.html',before:{bytes:0,text:'',binary:false},after:{bytes:10,text:'<h1>Hi</h1>',binary:false}} as never;
  return {url:'http://127.0.0.1:1234/'} as never;
 });
 render(<WorkbenchReview w={w} p={p} disabled={false} action={action}/>);
 fireEvent.click(screen.getByText('刷新成果文件'));fireEvent.click(await screen.findByText('index.html'));
 fireEvent.click(await screen.findByRole('button',{name:/预览网页/}));
 expect(invoke).toHaveBeenCalledWith('workbench:preview',{id:'wb',roleId:'front',token:'receipt',path:'index.html'});
 fireEvent.click(screen.getByRole('button',{name:'在访达中显示'}));expect(invoke).toHaveBeenCalledWith('workbench:revealFile',{id:'wb',roleId:'front',token:'receipt',path:'index.html'});
 expect(invoke).not.toHaveBeenCalledWith('workbench:apply',expect.anything());
});
it.each([['delivery/clip.mp4','播放视频'],['delivery/report.pdf','查看完整文件'],['delivery/chart.svg','查看图片 / 图表'],['delivery/report.docx','系统预览文档']])('automatically lists and opens the actual artifact action for %s',async(path,label)=>{
 vi.mocked(invoke).mockImplementation(async(name)=>{
  if(name==='workbench:review')return {token:'r',total:1,conflicts:0,blockedReason:null,files:[{path,kind:'added',conflict:false}]} as never;
  if(name==='workbench:reviewFile')return {path,before:{bytes:0,text:'',binary:false},after:{bytes:20,text:'',binary:true}} as never;
  return {ok:true,url:'http://127.0.0.1:1234/'} as never;
 });
 render(<WorkbenchReview w={w} p={p} disabled={false} action={action}/>);
 fireEvent.click(await screen.findByRole('button',{name:new RegExp(label)}));
 expect(invoke).toHaveBeenCalledWith(path.endsWith('.docx')?'workbench:openDocument':'workbench:preview',{id:'wb',roleId:'front',token:'r',path});
 fireEvent.click(screen.getByRole('button',{name:'下载原文件'}));expect(invoke).toHaveBeenCalledWith('workbench:preview',{id:'wb',roleId:'front',token:'r',path,download:true});
 expect(invoke).not.toHaveBeenCalledWith('workbench:apply',expect.anything());
});
it('renders Markdown as a document automatically and keeps the raw comparison available',async()=>{
 vi.mocked(invoke).mockImplementation(async(name)=>name==='workbench:review'?{token:'r',total:1,conflicts:0,files:[{path:'PRD.md',kind:'added'}]} as never:{path:'PRD.md',before:{bytes:0,text:'',binary:false},after:{bytes:20,text:'# 产品方案\n\n正文',binary:false}} as never);
 render(<WorkbenchReview w={w} p={p} disabled={false} action={action}/>);
 expect(await screen.findByRole('heading',{name:'产品方案'})).toBeTruthy();expect(screen.getByText('查看源码与变更对比')).toBeTruthy();
});

it('loads results even while the shared mutation action is busy',async()=>{
 vi.mocked(invoke).mockImplementation(async(name)=>name==='workbench:review'?{token:'r',total:1,conflicts:0,files:[{path:'PRD.md',kind:'added'}]} as never:{path:'PRD.md',before:{bytes:0,text:'',binary:false},after:{bytes:20,text:'# Ready',binary:false}} as never);
 const busyAction=vi.fn(async()=>{});
 const view=render(<WorkbenchReview w={w} p={p} disabled={true} action={busyAction}/>);
 view.rerender(<WorkbenchReview w={w} p={p} disabled={false} action={busyAction}/>);
 expect(await screen.findByRole('heading',{name:'Ready'})).toBeTruthy();
 expect(busyAction).not.toHaveBeenCalled();
});

it('shows result read errors and ignores a response after switching roles',async()=>{
 let resolveOld!:(value:unknown)=>void;
 vi.mocked(invoke).mockImplementation(async(name,input)=>{
  if(name==='workbench:review' && (input as {roleId:string}).roleId==='front')return await new Promise<unknown>(r=>resolveOld=r) as never;
  throw Error('result no longer available');
 });
 const view=render(<WorkbenchReview w={w} p={p} disabled={false} action={action}/>);
 view.rerender(<WorkbenchReview w={w} p={{...p,roleId:'other',taskId:'other'}} disabled={false} action={action}/>);
 expect((await screen.findByRole('alert')).textContent).toContain('result no longer available');
 resolveOld({token:'old',total:1,conflicts:0,files:[{path:'old-secret.md',kind:'added'}]});
 await new Promise(r=>setTimeout(r,0));
 expect(screen.queryByText('old-secret.md')).toBeNull();
 expect(invoke).not.toHaveBeenCalledWith('workbench:reviewFile',expect.objectContaining({token:'old'}));
});
