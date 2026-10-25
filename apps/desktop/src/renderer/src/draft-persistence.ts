import { create } from "zustand";
import { EMPTY_COMPOSER_DRAFT, type ComposerDraft, type DraftTarget, type DraftReceipt } from "@pi-harness/contracts";
import { invoke } from "./api.js";
type Entry = { data: ComposerDraft; revision: number; ready: boolean; saving: boolean; error: string | null };
const fresh = (): Entry => ({ data: structuredClone(EMPTY_COMPOSER_DRAFT), revision: 0, ready: false, saving: false, error: null });
export const draftKey = (t: DraftTarget) => `${t.kind}:${t.id ?? "new"}`;
export const useDrafts = create<{ entries: Record<string, Entry> }>(()=>({entries:{}}));
const retained = new Map<string,number>();
const loads = new Map<string,Promise<void>>(), writes = new Map<string,Promise<void>>(), pending = new Map<string,Partial<ComposerDraft>>(), deleted = new Set<string>();
function set(key: string, patch: Partial<Entry>) {
  useDrafts.setState(s=>{
    const entries={...s.entries,[key]:{...(s.entries[key]??fresh()),...patch}};
    for(const candidate of Object.keys(entries)) {
      if(Object.keys(entries).length<=100)break;
      if(candidate!==key&&!retained.has(candidate)&&!pending.has(candidate)&&!writes.has(candidate)&&entries[candidate]?.ready&&!entries[candidate]?.error)delete entries[candidate];
    }
    return {entries};
  });
}
export async function loadDraft(target: DraftTarget): Promise<void> {
  const key=draftKey(target);
  if (deleted.has(key)) throw Error("草稿所属任务已删除");
  if (useDrafts.getState().entries[key]?.ready) return;
  if (loads.has(key)) return loads.get(key)!;
  const job=(async()=>{
    try {
      const result=await invoke('draft:get',target);
      if (deleted.has(key)) return;
      const base=result?.draft ?? structuredClone(EMPTY_COMPOSER_DRAFT);
      set(key,{data:{...base,...pending.get(key)},revision:result?.revision??0,ready:true,error:null});
    } catch(e) { if(!deleted.has(key))set(key,{error:String(e)}); throw e; }
  })();
  loads.set(key,job);
  try { await job; } finally { loads.delete(key); }
}
export function patchDraft(target: DraftTarget, patch: Partial<ComposerDraft>) {
  const key=draftKey(target);
  if(deleted.has(key))return;
  const entry=useDrafts.getState().entries[key]??fresh();
  set(key,{data:{...entry.data,...patch},saving:true,error:null});
  pending.set(key,{...pending.get(key),...patch});
  void flushDraft(target).catch(()=>{});
}
export async function flushDraft(target: DraftTarget): Promise<DraftReceipt> {
  const key=draftKey(target);
  if(deleted.has(key)) throw Error('草稿所属任务已删除');
  if(writes.has(key)) { await writes.get(key); if(pending.has(key))return flushDraft(target); return receipt(key); }
  const job=(async()=>{
    await loadDraft(target);
    while(pending.has(key)&&!deleted.has(key)) {
      const patch=pending.get(key)!;pending.delete(key);
      try {
        const result=await invoke('draft:save',{...target,revision:receipt(key).revision,patch});
        if(!deleted.has(key))set(key,{revision:result?.revision??receipt(key).revision+1,error:null});
      } catch(e) {
        if(!deleted.has(key)){pending.set(key,{...patch,...pending.get(key)});set(key,{error:String(e)});} throw e;
      }
    }
  })();
  writes.set(key,job);
  try{await job;}finally{writes.delete(key);if(!deleted.has(key))set(key,{saving:false});}
  return receipt(key);
}
function receipt(key:string):DraftReceipt { const e=useDrafts.getState().entries[key]??fresh();return {draft:e.data,revision:e.revision}; }
export async function reloadDraft(target:DraftTarget) {
  const key=draftKey(target); await writes.get(key)?.catch(()=>{});
  set(key,{ready:false,error:null});await loadDraft(target);
  if(pending.has(key))await flushDraft(target);
}
export async function moveNewChatDraft(taskId:string,revision:number) {
  const moved=await invoke('draft:moveChat',{taskId,revision});
  set('chat:'+taskId,{data:moved.draft,revision:moved.revision,ready:true,error:null});
  // The server consumed only the captured revision; do not erase a new edit.
  set('chat:new',{ready:false});await loadDraft({kind:'chat',id:null});
  return moved;
}
export function forgetDraft(target:DraftTarget) {
  const key=draftKey(target);deleted.add(key);if(deleted.size>500)deleted.delete(deleted.values().next().value!);pending.delete(key);
  useDrafts.setState(s=>{const entries={...s.entries};delete entries[key];return {entries};});
}
export async function flushAllDrafts() {
  // No polling or model calls. A normal window close waits for these local writes.
  const keys=new Set([...pending.keys(),...writes.keys()]);
  await Promise.all([...keys].map(key=>{const split=key.indexOf(':');return flushDraft({kind:key.slice(0,split) as DraftTarget['kind'],id:key.slice(split+1)==='new'?null:key.slice(split+1)});}));
}
if(typeof window!=='undefined') window.pih?.onDraftFlush?.(flushAllDrafts);

/** Drop renderer caches only after pending writes have settled (used by isolated renderer tests). */
export function retainDraft(target:DraftTarget) { const key=draftKey(target);retained.set(key,(retained.get(key)??0)+1);return ()=>{const count=(retained.get(key)??1)-1;if(count)retained.set(key,count);else retained.delete(key);}; }
export function resetDraftPersistence() { retained.clear();loads.clear();writes.clear();pending.clear();deleted.clear();useDrafts.setState({entries:{}}); }
