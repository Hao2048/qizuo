import { randomUUID } from "node:crypto";
import type { RunProgress } from "@pi-harness/contracts";

/** 只保留正在运行的计时器；完成结果由宿主持久保存。 */
export class RunProgressTracker {
 #runs = new Map<string, { value: RunProgress; since: number; requestAt?: number; pendingAt?:number; thinkingAt?:number; toolAt?:number; tools:Set<string> }>();
 constructor(private publish: (progress: RunProgress) => void, private now = Date.now) {}
 begin(taskId: string): void {
  const at = this.now();
  const value: RunProgress = { taskId, runId: randomUUID(), stage: "accepted",requestCount:0,providerWaitMs:0,thinkingMs:0,toolExecutionMs:0, startedAt: at, updatedAt: at, elapsedMs: 0, stages: [] };
  this.#runs.set(taskId, { value, since: at,tools:new Set() }); this.publish(value);
 }
 stage(taskId: string, stage: RunProgress["stage"]): void {
  const run = this.#runs.get(taskId); if (!run) return;
  const at = this.now();
  if(stage==="request"){
   if(run.pendingAt!==undefined)run.value.providerWaitMs=(run.value.providerWaitMs ?? 0)+Math.max(0,at-run.pendingAt);
   run.pendingAt=at;run.value.requestCount=(run.value.requestCount ?? 0)+1;
  }
  if(run.value.stage===stage){this.publish({...run.value,updatedAt:at});return;}
  run.value = { ...run.value, stage, updatedAt: at, elapsedMs: Math.max(0, at - run.value.startedAt), stages: [...run.value.stages, { stage: run.value.stage, durationMs: Math.max(0, at - run.since) }] };
  run.since = at;
  if (stage === "request" && run.requestAt === undefined) { run.requestAt = at; run.value.preparationMs = Math.max(0, at - run.value.startedAt); }
  this.publish(run.value);
 }
 response(taskId: string): void {
  const run = this.#runs.get(taskId); if (!run) return;
  if (run.value.firstResponseMs===undefined && run.requestAt !== undefined) run.value.firstResponseMs = Math.max(0, this.now() - run.requestAt);
  if(run.value.stage!=="response")this.stage(taskId, "response");
 }
 providerResponse(taskId:string):void {
  const run=this.#runs.get(taskId);if(!run || run.pendingAt===undefined)return;
  run.value.providerWaitMs=(run.value.providerWaitMs ?? 0)+Math.max(0,this.now()-run.pendingAt);run.pendingAt=undefined;
 }
 chunk(taskId:string,kind:string):void {
  const run=this.#runs.get(taskId);if(!run)return;
  if(kind!=="end"){this.providerResponse(taskId);this.response(taskId);}
  if(kind==="thinking_delta"){run.thinkingAt ??= this.now();}
  else if(run.thinkingAt!==undefined){run.value.thinkingMs=(run.value.thinkingMs ?? 0)+Math.max(0,this.now()-run.thinkingAt);run.thinkingAt=undefined;}
 }
 tool(taskId:string,id:string,start:boolean):void {
  const run=this.#runs.get(taskId);if(!run)return;
  if(start){if(run.tools.size===0)run.toolAt=this.now();run.tools.add(id);}
  else if(run.tools.delete(id) && run.tools.size===0 && run.toolAt!==undefined){run.value.toolExecutionMs=(run.value.toolExecutionMs ?? 0)+Math.max(0,this.now()-run.toolAt);run.toolAt=undefined;}
 }
 finish(taskId: string, stage: "complete" | "failed" | "stopped"): void {
  const run=this.#runs.get(taskId);if(run){this.providerResponse(taskId);this.chunk(taskId,"end");if(run.toolAt!==undefined)run.value.toolExecutionMs=(run.value.toolExecutionMs ?? 0)+Math.max(0,this.now()-run.toolAt);}
  this.stage(taskId, stage); this.#runs.delete(taskId);
 }
 forget(taskId: string): void { this.#runs.delete(taskId); }
 clear(): void { this.#runs.clear(); }
}
