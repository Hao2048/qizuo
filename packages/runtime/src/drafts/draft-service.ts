import { EMPTY_COMPOSER_DRAFT, type ComposerDraft, type DraftTarget, type DraftReceipt } from "@pi-harness/contracts";
import type { HarnessDatabase } from "../db/database.js";
const keyOf = (t: DraftTarget) => `${t.kind}:${t.id ?? "new"}`;
export class DraftService {
  constructor(private db: HarnessDatabase) {}
  private owner(t: DraftTarget) {
    if (t.kind === "workbench") {
      if (!t.id || !this.db.prepare("SELECT 1 FROM workbenches WHERE id=?").get(t.id)) throw Error("草稿所属工作台不存在");
    } else if (t.id) {
      const r = this.db.prepare("SELECT workbench_owner FROM tasks WHERE id=?").get(t.id) as { workbench_owner: string | null } | undefined;
      if (!r || r.workbench_owner) throw Error("草稿所属普通会话不存在");
    }
  }
  get(t: DraftTarget, includeFiles = true): DraftReceipt {
    this.owner(t);
    const row = this.db.prepare("SELECT body,revision FROM composer_drafts WHERE key=?").get(keyOf(t)) as { body: string; revision: number } | undefined;
    const draft: ComposerDraft = row ? JSON.parse(row.body) : structuredClone(EMPTY_COMPOSER_DRAFT);
    if(t.kind==='workbench')draft.attachmentIds=draft.attachmentIds.filter(id=>!!this.db.prepare("SELECT 1 FROM workbench_attachments WHERE id=? AND workbench_id=?").get(id,t.id));
    if (includeFiles && t.kind==='chat') draft.attachments = (this.db.prepare("SELECT body FROM composer_draft_files WHERE draft_key=? ORDER BY ordinal").all(keyOf(t)) as {body:string}[]).map(r=>JSON.parse(r.body));
    return { draft, revision: row?.revision ?? 0 };
  }
  references(t: DraftTarget) {
    return this.get(t).draft.referenceIds.flatMap(id => {
      const row = this.db.prepare("SELECT payload FROM conversation_references WHERE id=?").get(id) as { payload: string } | undefined;
      return row ? [JSON.parse(row.payload)] : [];
    });
  }
  save(t: DraftTarget, revision: number, patch: Partial<ComposerDraft>): {revision:number} {
    return this.db.transaction(() => {
      if(Object.keys(patch).some(k=>!Object.hasOwn(EMPTY_COMPOSER_DRAFT,k)))throw Error("草稿含有不允许保存的字段");
      const previous = this.get(t, false);
      if (revision !== previous.revision) throw Error("草稿已更新，请重新载入，未覆盖较新的内容");
      const draft = { ...previous.draft, ...patch };
      if (t.kind === "workbench") {
        if (draft.attachments.length || draft.referenceIds.length) throw Error("工作台草稿不能引用其他会话附件");
        const rows = draft.attachmentIds.map(id => this.db.prepare("SELECT bytes,kind FROM workbench_attachments WHERE id=? AND workbench_id=?").get(id, t.id) as { bytes: number; kind: string } | undefined);
        if (rows.some(r => !r)) throw Error("草稿附件不存在或不属于当前工作台");
        if (rows.reduce((n,r) => n+r!.bytes,0)>12*1024*1024 || rows.reduce((n,r)=>n+(r!.kind==='text'?r!.bytes:0),0)>128*1024) throw Error("草稿附件总量超过发送限制");
      } else {
        if (draft.attachmentIds.length || draft.recipient || draft.evidence || draft.verificationCommands) throw Error("普通对话草稿包含工作台内容");
        let total = 0;
        for (const a of draft.attachments) {
          const bytes = a.kind === "image" ? Buffer.from(a.data, "base64").length : Buffer.byteLength(a.data);
          total += bytes;
          if (!a.name || /[\\/\x00-\x1f]/.test(a.name) || bytes > (a.kind === "image" ? 4.5*1024*1024 : 200000)) throw Error("草稿附件名称或大小无效");
          if (a.kind === "image" && (!/^image\/(png|jpeg|gif|webp)$/.test(a.mimeType ?? "") || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data))) throw Error("草稿图片格式无效");
        }
        if (total>32*1024*1024) throw Error("草稿附件总量超过 32 MB");
        for (const id of draft.referenceIds) {
          const ref = this.db.prepare("SELECT owner_task_id FROM conversation_references WHERE id=?").get(id) as { owner_task_id: string|null }|undefined;
          if (!ref || (ref.owner_task_id && ref.owner_task_id!==t.id)) throw Error("引用已失效或不属于当前会话");
        }
      }
      const body = JSON.stringify({...draft,attachments:[]});
      const quota = this.db.prepare(`SELECT
        (SELECT COALESCE(SUM(bytes),0) FROM composer_drafts WHERE key<>?) +
        (SELECT COALESCE(SUM(bytes),0) FROM composer_draft_files WHERE draft_key<>?) bytes`).get(keyOf(t),keyOf(t)) as {bytes:number};
      const fileBytes = patch.attachments !== undefined ? Buffer.byteLength(JSON.stringify(draft.attachments)) : (this.db.prepare("SELECT COALESCE(SUM(bytes),0) bytes FROM composer_draft_files WHERE draft_key=?").get(keyOf(t)) as {bytes:number}).bytes;
      if (quota.bytes + Buffer.byteLength(body)+fileBytes>80*1024*1024) throw Error("未发送草稿总量超过 80 MB，请清理不再需要的草稿附件");
      this.db.prepare("INSERT INTO composer_drafts(key,task_id,workbench_id,body,revision,updated_at,bytes) VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,revision=excluded.revision,updated_at=excluded.updated_at,bytes=excluded.bytes")
        .run(keyOf(t), t.kind==='chat'?t.id:null, t.kind==='workbench'?t.id:null, body, revision+1, Date.now(),Buffer.byteLength(body));
      if (patch.attachments !== undefined) {
        this.db.prepare("DELETE FROM composer_draft_files WHERE draft_key=?").run(keyOf(t));
        draft.attachments.forEach((a,i)=>{const body=JSON.stringify(a);this.db.prepare("INSERT INTO composer_draft_files VALUES(?,?,?,?)").run(keyOf(t),i,body,Buffer.byteLength(body));});
      }
      if (t.kind === "workbench") for (const id of previous.draft.attachmentIds.filter(id=>!draft.attachmentIds.includes(id))) this.db.prepare("DELETE FROM workbench_attachments WHERE id=? AND workbench_id=? AND request_id IS NULL").run(id,t.id);
      return { revision: revision+1 };
    });
  }
  acknowledge(t: DraftTarget, revision: number) {
    // A new edit while sending is a different draft, not permission to erase it.
    const row = this.db.prepare("SELECT revision FROM composer_drafts WHERE key=?").get(keyOf(t)) as {revision:number}|undefined;
    if (!row || row.revision !== revision) return;
    this.save(t, revision, { text: "", attachments: [], referenceIds: [], attachmentIds: [] });
  }
  moveChat(taskId: string, revision: number): DraftReceipt {
    return this.db.transaction(() => {
      this.owner({kind:'chat',id:taskId});
      const source = this.get({kind:'chat',id:null}), target = this.get({kind:'chat',id:taskId});
      if (source.revision !== revision || target.revision) throw Error("草稿已变化，未移动或覆盖内容");
      this.save({kind:'chat',id:taskId},0,source.draft);
      const moved = this.get({kind:'chat',id:taskId});
      this.acknowledge({kind:'chat',id:null},revision);
      return moved;
    });
  }
}
