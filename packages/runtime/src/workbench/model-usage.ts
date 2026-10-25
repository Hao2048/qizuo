import type { Workbench, WorkbenchUsage, WorkbenchCall } from '@pi-harness/contracts';
import type { HarnessDatabase } from '../db/database.js';
import { uuidv7 } from '@pi-harness/shared';

type Receipt = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
const amount = (n: unknown): number | null => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const table = (id: string) => id.startsWith('exec-') ? 'workbench_execution_calls' : 'workbench_model_calls';
// Legacy receipts have no timing evidence. Exclude receipts already represented by a measured call.
const sources = `WITH calls AS (
 SELECT rowid seq,id,workbench_id,request_id,role_id,role_name,stage,provider,model,status,started_at,
 duration_ms,first_response_ms,first_text_ms,input_tokens,output_tokens,cache_read,cache_write,cost_usd_micros
 FROM workbench_model_calls WHERE workbench_id=?
 UNION ALL
 SELECT rowid seq,id,workbench_id,request_id,role_id,role_name,stage,provider,model,status,started_at,
 duration_ms,first_response_ms,first_text_ms,input_tokens,output_tokens,cache_read,cache_write,cost_usd_micros
 FROM workbench_execution_calls WHERE workbench_id=?
 UNION ALL
 SELECT l.id seq,'legacy-'||l.id,r.workbench_id,r.request_id,r.role_id,NULL,'execution',l.provider,l.model,'recorded',l.created_at,
 NULL,NULL,NULL,l.input_tokens,l.output_tokens,l.cache_read,l.cache_write,
 CASE WHEN l.cost_reported=1 THEN l.cost_usd_micros END
 FROM usage_ledger l JOIN workbench_runs r ON r.task_id=l.task_id WHERE r.workbench_id=?
 AND NOT EXISTS(SELECT 1 FROM workbench_execution_calls e WHERE e.usage_id=l.id)
)`;
function roleName(w: Workbench, roleId: string, fallback: string | null) {
  return w.participants.find(p=>p.roleId===roleId)?.name
    ?? w.roleHistory?.findLast(p=>p.roleId===roleId)?.name ?? fallback ?? '历史角色';
}
/** Metadata only; neither reads private worker history nor invokes a model to fill missing data. */
export class WorkbenchModelUsage {
  constructor(private db: HarnessDatabase) {}
  recover(): void {
    for (const name of ['workbench_model_calls','workbench_execution_calls'])
      this.db.prepare(`UPDATE ${name} SET status='interrupted' WHERE status='running'`).run();
  }
  begin(input: { workbenchId: string; requestId: string; roleId: string; name: string;
    stage: 'routing' | 'planning' | 'execution'; provider: string; model: string; taskId?: string }): string {
    const id = (input.stage==='execution' ? 'exec-' : '') + uuidv7();
    const columns = input.stage==='execution' ? ',task_id' : '';
    const values = input.stage==='execution' ? ',?' : '';
    this.db.prepare(`INSERT INTO ${table(id)}
      (id,workbench_id,request_id,role_id,role_name,stage,provider,model,status,started_at${columns})
      VALUES(?,?,?,?,?,?,?,?,'running',?${values})`).run(id,input.workbenchId,input.requestId,
        input.roleId,input.name,input.stage,input.provider,input.model,Date.now(),
        ...(input.stage==='execution' ? [input.taskId!] : []));
    return id;
  }
  first(id: string, kind: 'response' | 'text', elapsed: number): void {
    const column = kind==='text' ? 'first_text_ms' : 'first_response_ms';
    this.db.prepare(`UPDATE ${table(id)} SET ${column}=? WHERE id=? AND status='running' AND ${column} IS NULL`)
      .run(Math.max(0,Math.round(elapsed)),id);
  }
  settle(id: string, status: 'completed' | 'failed' | 'interrupted', durationMs: number, usage?: Receipt): void {
    const cost = amount(usage?.cost?.total);
    this.db.prepare(`UPDATE ${table(id)} SET status=?,duration_ms=?,
      input_tokens=?,output_tokens=?,cache_read=?,cache_write=?,cost_usd_micros=?
      WHERE id=? AND status='running'`).run(status,Math.max(0,Math.round(durationMs)),
        amount(usage?.input),amount(usage?.output),amount(usage?.cacheRead),
        amount(usage?.cacheWrite),cost === null ? null : Math.round(cost*1_000_000),id);
  }
  link(id: string, usageId: number): void {
    if(id.startsWith('exec-')) this.db.prepare('UPDATE workbench_execution_calls SET usage_id=? WHERE id=?').run(usageId,id);
  }
  summary(w: Workbench, requestId?: string): WorkbenchUsage {
    type Row = { role_id: string; role_name: string | null; stage: 'routing'|'planning'|'execution';
      calls: number; receipts: number; failed: number; interrupted: number; active: number;
      input: number | null; output: number | null; cache: number | null; cache_calls: number;
      cost: number | null; cost_calls: number; duration: number | null; first_response: number|null; first_text: number|null };
    const params = [w.id,w.id,w.id];
    const rows = this.db.prepare(sources+`, ranked AS (
      SELECT *,ROW_NUMBER() OVER(PARTITION BY role_id,stage ORDER BY started_at DESC,seq DESC,id DESC) n
      FROM calls WHERE (? IS NULL OR request_id=?)
    ) SELECT role_id,MAX(role_name) role_name,stage,COUNT(*) calls,COUNT(input_tokens) receipts,
      SUM(status='failed') failed,SUM(status='interrupted') interrupted,SUM(status='running') active,
      SUM(CASE WHEN input_tokens IS NOT NULL THEN input_tokens+COALESCE(cache_read,0)+COALESCE(cache_write,0) END) input,
      SUM(output_tokens) output,SUM(cache_read) cache,COUNT(cache_read) cache_calls,
      SUM(cost_usd_micros) cost,COUNT(cost_usd_micros) cost_calls,
      MAX(CASE WHEN n=1 THEN duration_ms END) duration,
      MAX(CASE WHEN n=1 THEN first_response_ms END) first_response,
      MAX(CASE WHEN n=1 THEN first_text_ms END) first_text
      FROM ranked GROUP BY role_id,stage`).all(...params,requestId??null,requestId??null) as Row[];
    const rounds = new Map<string,{requestId:string;at:number;label:string}>();
    for(const m of w.messages) if(m.sender==='你' && m.kind==='request' && !rounds.has(m.requestId))
      rounds.set(m.requestId,{requestId:m.requestId,at:m.at,label:m.text.replace(/\s+/g,' ').slice(0,100)});
    for(const r of this.db.prepare(sources+' SELECT request_id,MIN(started_at) at FROM calls GROUP BY request_id').all(...params) as {request_id:string;at:number}[])
      if(!rounds.has(r.request_id)) rounds.set(r.request_id,{requestId:r.request_id,at:r.at,label:'历史执行（未关联原要求）'});
    return { rounds:[...rounds.values()].sort((a,b)=>b.at-a.at||b.requestId.localeCompare(a.requestId)),
      roles: rows.map(r=>({ roleId:r.role_id,name:roleName(w,r.role_id,r.role_name),stage:r.stage,
      calls:r.calls,receiptCalls:r.receipts,failedCalls:r.failed,interruptedCalls:r.interrupted,
      activeCalls:r.active,inputTokens:r.input,outputTokens:r.output,cacheReadTokens:r.cache,
      cacheReceiptCalls:r.cache_calls,costUSD:r.cost === null ? null : r.cost/1_000_000,
      costReceiptCalls:r.cost_calls,lastDurationMs:r.duration,lastFirstResponseMs:r.first_response,lastFirstTextMs:r.first_text,
    })).sort((a,b)=>a.name.localeCompare(b.name)||a.stage.localeCompare(b.stage)) };
  }
  calls(w: Workbench, input: { requestId?: string; cursor?: string }): {calls:WorkbenchCall[];nextCursor:string|null} {
    let cursor: {at:number;seq:number;id:string;workbench:string;request:string|null}|null=null;
    if(input.cursor) {
      try { cursor=JSON.parse(input.cursor); } catch { throw Error('调用记录分页位置无效'); }
      if(!cursor || !Number.isFinite(cursor.at) || !Number.isSafeInteger(cursor.seq) || typeof cursor.id!=='string' || !cursor.id ||
        cursor.workbench!==w.id || cursor.request!==(input.requestId??null)) throw Error('调用记录分页位置无效');
    }
    const rows=this.db.prepare(sources+` SELECT * FROM calls WHERE (? IS NULL OR request_id=?)
      AND (? IS NULL OR started_at<? OR (started_at=? AND (seq<? OR (seq=? AND id<?))))
      ORDER BY started_at DESC,seq DESC,id DESC LIMIT 51`).all(w.id,w.id,w.id,input.requestId??null,input.requestId??null,
        cursor?.at??null,cursor?.at??null,cursor?.at??null,cursor?.seq??null,cursor?.seq??null,cursor?.id??null) as {
      seq:number;id:string;request_id:string;role_id:string;role_name:string|null;stage:string;provider:string|null;model:string|null;
      status:string;started_at:number;first_response_ms:number|null;first_text_ms:number|null;duration_ms:number|null;
    }[];
    const visible=rows.slice(0,50),last=visible.at(-1);
    return {calls:visible.map(r=>({id:r.id,requestId:r.request_id,roleId:r.role_id,name:roleName(w,r.role_id,r.role_name),
      stage:r.stage,provider:r.provider??'unknown',model:r.model??'unknown',status:r.status,at:r.started_at,
      firstResponseMs:r.first_response_ms,firstTextMs:r.first_text_ms,durationMs:r.duration_ms})),
      nextCursor:rows.length>50 && last ? JSON.stringify({at:last.started_at,seq:last.seq,id:last.id,workbench:w.id,request:input.requestId??null}) : null};
  }
}
