import type { HarnessDatabase } from '../db/database.js';
import { WorkbenchModelUsage } from './model-usage.js';

/** One transient clock per active worker request; terminal paths remove it. No text is retained. */
export class WorkbenchExecutionTiming {
  #active = new Map<string,{id:string;at:number;response:boolean;text:boolean}>();
  #usage: WorkbenchModelUsage;
  constructor(private db:HarnessDatabase,private now=()=>performance.now()) { this.#usage=new WorkbenchModelUsage(db); }
  begin(taskId:string):void {
    this.finish(taskId,'interrupted');
    const r=this.db.prepare(`SELECT r.*,t.resolved_provider,t.resolved_model,
      json_extract(t.role_snapshot,'$.name') name FROM workbench_runs r JOIN tasks t ON t.id=r.task_id
      WHERE r.task_id=?`).get(taskId) as {workbench_id:string;request_id:string;role_id:string;name:string|null;resolved_provider:string|null;resolved_model:string|null}|undefined;
    if(!r)return; // Ordinary conversations retain their existing progress tracking.
    const id=this.#usage.begin({workbenchId:r.workbench_id,requestId:r.request_id,roleId:r.role_id,
      name:r.name??'历史角色',stage:'execution',provider:r.resolved_provider??'unknown',model:r.resolved_model??'unknown',taskId});
    this.#active.set(taskId,{id,at:this.now(),response:false,text:false});
  }
  event(taskId:string,event:unknown):string|undefined {
    const run=this.#active.get(taskId);if(!run)return;
    const e=event as {type:string;assistantMessageEvent?:{type:string;delta?:unknown};message?:{role?:string;stopReason?:string;usage?:Parameters<WorkbenchModelUsage['settle']>[3]}};
    const delta=e.assistantMessageEvent;
    if(e.type==='message_update' && delta && typeof delta.delta==='string' && delta.delta.length>0 &&
      ['text_delta','thinking_delta','toolcall_delta'].includes(delta.type)) {
      if(!run.response){this.#usage.first(run.id,'response',this.now()-run.at);run.response=true;}
      if(delta.type==='text_delta' && !run.text){this.#usage.first(run.id,'text',this.now()-run.at);run.text=true;}
    }
    if(e.type==='message_end' && e.message?.role==='assistant') {
      this.#active.delete(taskId);
      this.#usage.settle(run.id,['error','aborted'].includes(e.message.stopReason??'')?'failed':'completed',this.now()-run.at,e.message.usage);
      return run.id;
    }
  }
  link(id:string,usageId:number):void { this.#usage.link(id,usageId); }
  finish(taskId:string,status:'failed'|'interrupted'):void {
    const run=this.#active.get(taskId);if(!run)return;
    this.#active.delete(taskId);this.#usage.settle(run.id,status,this.now()-run.at);
  }
  clear():void { for(const id of this.#active.keys())this.finish(id,'interrupted'); }
}
