import type { DraftTarget } from "@pi-harness/contracts";
import { draftKey, flushDraft, useDrafts } from "../draft-persistence.js";
export default function DraftStatus({target}:{target:DraftTarget}) {
 const entry=useDrafts(s=>s.entries[draftKey(target)]);
 if(!entry?.ready&&!entry?.error)return null;
 return <small className="hint" role="status">{entry.error ? <>草稿未保存：{entry.error} <button type="button" className="ghost" onClick={()=>void flushDraft(target).catch(()=>{})}>重试保存</button></> : entry.saving ? '正在保存草稿…' : '草稿已保存到本机'}</small>;
}
