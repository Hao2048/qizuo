import type {WorkbenchDeliverable} from '@pi-harness/contracts';
import type {HarnessDatabase} from '../db/database.js';
import {manifest,owns} from './workspace.js';

export type Assignment = {
 roleId:string; instructions:string; files:string[]; dependsOn:string[];
 attachmentIds?:string[]; deliverables?:WorkbenchDeliverable[];
 sourceRequestId?:string; contractVersions?:string; expectedInputs?:ArtifactVersion[];
};
export type ArtifactVersion = {roleId:string;taskId:string;files:{path:string;hash:string}[]};
export type ExecutionPlan = {requestId:string;goal:string;assignments:Assignment[];planningComplete?:true};
type RunReceipt = {sourceRequestId:string;assignment:Assignment;inputs:ArtifactVersion[];outputs?:ArtifactVersion};

export function artifactFiles(root:string,owned:string[]):ArtifactVersion['files'] {
 return Object.entries(manifest(root,true)).filter(([path])=>owns(path,owned))
  .sort(([a],[b])=>a.localeCompare(b)).map(([path,hash])=>({path,hash}));
}
export const sameArtifacts=(a:ArtifactVersion['files'],b:ArtifactVersion['files'])=>JSON.stringify(a)===JSON.stringify(b);

/** Host data only. No model calls, scheduling, private prompts or permissions live here. */
export class ExecutionStore {
 constructor(private db:HarnessDatabase){}
 stage(id:string,plan:ExecutionPlan){
  this.db.prepare(`INSERT INTO workbench_plans(workbench_id,request_id,body,ready,created_at) VALUES(?,?,?,0,?)
   ON CONFLICT(workbench_id,request_id) DO UPDATE SET body=excluded.body WHERE workbench_plans.ready=0`).run(id,plan.requestId,JSON.stringify(plan),Date.now());
 }
 confirm(id:string,plan:ExecutionPlan){
  this.db.prepare('UPDATE workbench_plans SET body=?,ready=1 WHERE workbench_id=? AND request_id=? AND ready=0').run(JSON.stringify(plan),id,plan.requestId);
 }
 discardUnconfirmed(id:string,requestId:string){this.db.prepare('DELETE FROM workbench_plans WHERE workbench_id=? AND request_id=? AND ready=0').run(id,requestId);}
 get(id:string,requestId:string):ExecutionPlan|undefined{
  const row=this.db.prepare('SELECT body FROM workbench_plans WHERE workbench_id=? AND request_id=? AND ready=1').get(id,requestId) as {body:string}|undefined;
  return row?JSON.parse(row.body):undefined;
 }
 latestState(id:string):{plan:ExecutionPlan;ready:boolean}|undefined{
  const row=this.db.prepare('SELECT body,ready FROM workbench_plans WHERE workbench_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id) as {body:string;ready:number}|undefined;
  return row?{plan:JSON.parse(row.body),ready:row.ready===1}:undefined;
 }
 latest(id:string):ExecutionPlan|undefined{
  const row=this.db.prepare('SELECT body FROM workbench_plans WHERE workbench_id=? AND ready=1 ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id) as {body:string}|undefined;
  return row?JSON.parse(row.body):undefined;
 }
 start(taskId:string,id:string,requestId:string,assignment:Assignment,inputs:ArtifactVersion[]){
  const body:RunReceipt={sourceRequestId:assignment.sourceRequestId??requestId,assignment,inputs};
  this.db.prepare('INSERT INTO workbench_run_receipts(task_id,workbench_id,body) VALUES(?,?,?)').run(taskId,id,JSON.stringify(body));
 }
 run(taskId:string):RunReceipt|undefined{
  const row=this.db.prepare('SELECT body FROM workbench_run_receipts WHERE task_id=?').get(taskId) as {body:string}|undefined;
  return row?JSON.parse(row.body):undefined;
 }
 finish(taskId:string,outputs:ArtifactVersion){
  const body=this.run(taskId);if(!body||body.outputs)return;
  body.outputs=outputs;
  this.db.prepare('UPDATE workbench_run_receipts SET body=? WHERE task_id=?').run(JSON.stringify(body),taskId);
 }
}
