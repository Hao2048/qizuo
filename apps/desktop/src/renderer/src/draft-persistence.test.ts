import {beforeEach,it,expect,vi} from 'vitest';
import {EMPTY_COMPOSER_DRAFT} from '@pi-harness/contracts';
import {invoke} from './api.js';
import {loadDraft,patchDraft,flushDraft,flushAllDrafts,useDrafts,draftKey,forgetDraft,reloadDraft} from './draft-persistence.js';
vi.mock('./api.js',()=>({invoke:vi.fn()}));
const t={kind:'chat' as const,id:'task-a'};
let disk:Map<string,{draft:typeof EMPTY_COMPOSER_DRAFT,revision:number}>;
beforeEach(()=>{
 disk=new Map();vi.mocked(invoke).mockImplementation(async(name,input:any)=>{
  const key=draftKey(input);const previous=disk.get(key)??{draft:structuredClone(EMPTY_COMPOSER_DRAFT),revision:0};
  if(name==='draft:get')return structuredClone(previous) as any;
  if(name==='draft:save') {
   if(input.revision!==previous.revision)throw Error('version conflict');
   disk.set(key,{draft:{...previous.draft,...structuredClone(input.patch)},revision:previous.revision+1});return {revision:previous.revision+1} as any;
  }
  return {} as any;
 });
});
it('旧读取晚到时保留用户刚输入的文字和附件，按正确任务保存',async()=>{
 let resolve!:(v:any)=>void;vi.mocked(invoke).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}) as any);
 const loading=loadDraft(t);patchDraft(t,{text:'刚输入',attachments:[{kind:'text',name:'a.md',data:'甲的内容'}]});
 resolve({draft:{...EMPTY_COMPOSER_DRAFT,text:'旧草稿'},revision:0});await loading;await flushAllDrafts();
 expect(disk.get('chat:task-a')!.draft.text).toBe('刚输入');expect(disk.get('chat:task-a')!.draft.attachments[0]!.data).toBe('甲的内容');expect(disk.has('chat:task-b')).toBe(false);
});
it('保存期间后续输入按版本串行保存；修改文字不会反复上传附件',async()=>{
 patchDraft(t,{attachments:[{kind:'text',name:'large.md',data:'data'}]});await flushDraft(t);
 patchDraft(t,{text:'第一笔'});patchDraft(t,{text:'第二笔'});await flushAllDrafts();
 expect(disk.get('chat:task-a')!.draft).toMatchObject({text:'第二笔',attachments:[{kind:'text',name:'large.md',data:'data'}]});
 expect(vi.mocked(invoke).mock.calls.filter(([name,p]:any)=>name==='draft:save'&&p.patch.attachments)).toHaveLength(1);
});
it('磁盘保存失败保留本地内容、阻止完成确认；重试后成功',async()=>{
 await loadDraft(t);const original=vi.mocked(invoke).getMockImplementation()!;
 vi.mocked(invoke).mockImplementation(async(name,input)=>{if(name==='draft:save')throw Error('disk full');return original(name,input);});
 patchDraft(t,{text:'不能丢失'});await expect(flushAllDrafts()).rejects.toThrow('disk full');
 expect(useDrafts.getState().entries['chat:task-a']!.data.text).toBe('不能丢失');expect(useDrafts.getState().entries['chat:task-a']!.error).toContain('disk full');
 vi.mocked(invoke).mockImplementation(original);await flushAllDrafts();expect(disk.get('chat:task-a')!.draft.text).toBe('不能丢失');
});
it('发送确认更新服务器版本后重新读取，不覆盖发送期间的新编辑',async()=>{
 patchDraft(t,{text:'已发送'});await flushDraft(t);
 const before=disk.get('chat:task-a')!;disk.set('chat:task-a',{draft:{...before.draft,text:''},revision:before.revision+1});
 patchDraft(t,{text:'新编辑'});await flushAllDrafts().catch(()=>{});
 await reloadDraft(t);expect(disk.get('chat:task-a')!.draft.text).toBe('新编辑');
});
it('删除任务后晚到读取与保存不能重新建立内存草稿',async()=>{
 let resolve!:(v:any)=>void;vi.mocked(invoke).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}) as any);
 const loading=loadDraft(t);forgetDraft(t);resolve({draft:{...EMPTY_COMPOSER_DRAFT,text:'晚到'},revision:3});await loading;
 patchDraft(t,{text:'不应保存'});expect(useDrafts.getState().entries['chat:task-a']).toBeUndefined();expect(disk.size).toBe(0);
});
