import {join} from "node:path";
import {uuidv7} from "@pi-harness/shared";
import {Type} from "typebox";
import type {AgentRun} from "@pi-harness/contracts";
import type {ToolDefinition} from "@earendil-works/pi-coding-agent";
import {createAgent,type AgentSpec} from "./agent-factory.js";

/** In-process children share auth/permission policy, but never share message history. */
export function nativeSubagentTool(spec:AgentSpec,canExecute:()=>boolean,parent=()=>({model:spec.model,thinking:spec.thinkingLevel})):ToolDefinition {
 let concurrent=0;
 return {name:"harness_subagent",label:"委派子任务",description:"把明确、独立的任务交给内置子 Agent，返回结果摘要。复用当前登录和权限；默认只读，allowWrites=true 时仍需遵守每项写操作审批。提供完整任务和验收标准，可指定已配置的模型。最多同时两个子 Agent，禁止再次派生子 Agent。",parameters:Type.Object({task:Type.String({minLength:1,maxLength:8000}),allowWrites:Type.Optional(Type.Boolean()),model:Type.Optional(Type.Object({provider:Type.String(),modelId:Type.String()}))}),execute:async(_id,params,signal)=>{
  const input=params as {task:string;allowWrites?:boolean;model?:{provider:string;modelId:string}};
  if(!canExecute() || signal?.aborted)return {isError:true,content:[{type:"text",text:"任务已停止，不能启动子 Agent。"}],details:{}};
  if(concurrent>=2)return {isError:true,content:[{type:"text",text:"已有两个子 Agent 在运行，请等待结果后再委派。"}],details:{}};
  const model=input.model ? spec.modelRuntime.getModel(input.model.provider,input.model.modelId) : parent().model;
  if(!model)return {isError:true,content:[{type:"text",text:"指定的子 Agent 模型不可用。"}],details:{}};
  const id=uuidv7(),now=Date.now();
  const record:AgentRun={id,taskId:spec.taskId,roleId:spec.childRoleId ?? "assistant",roleName:spec.childRoleName ?? "子 Agent",title:input.task.slice(0,120),cwd:spec.cwd,status:"starting",startedAt:now,updatedAt:now,tokens:0,costUSD:0};
  const publish=()=>{record.updatedAt=Date.now();spec.onChildAgent?.(record);};publish();concurrent++;
  let child:Awaited<ReturnType<typeof createAgent>>|undefined,unsubscribe:(()=>void)|undefined;
  const bounded=signal ?? new AbortController().signal;
  const abort=()=>{void child?.session.abort();};bounded.addEventListener("abort",abort,{once:true});
  try {
   child=await createAgent({...spec,thinkingLevel:parent().thinking,model:model as AgentSpec["model"],isSubagent:true,onChildAgent:undefined,onChildUsage:undefined,onContextProjection:undefined,onCompactionState:undefined,onProgress:undefined,contextState:undefined,updatePlan:undefined,askUser:undefined,extraTools:undefined,sessionFile:null,sessionDir:join(spec.agentDir,"..","member-sessions",spec.taskId,`child-${id}`),systemPrompt:`${spec.systemPrompt}\n\n你是专注于此子任务的子 Agent。历史主会话不会自动传入；仅执行下面明确的任务，结论必须附可验证结果。不要再派生子 Agent。${input.allowWrites ? "写操作仍受主任务权限限制。" : "此子任务只读，禁止修改文件、运行写命令或改变外部状态。"}`,currentRequest:()=>({text:input.task,review:!input.allowWrites}),executionAllowed:()=>canExecute() && !bounded.aborted,resolveToolPermission:(name,args)=>{
    if(!input.allowWrites && !["read","read_many","ls","grep","find","read_tool_image","read_tool_output","harness_resources","tool_search"].includes(name))return {block:true,reason:"子任务只读，请把修改建议返回主管 Agent。"};
    return spec.resolveToolPermission(name,args);
   },requestApproval:async req=>{record.status="waiting_approval";publish();try{return await spec.requestApproval({...req,toolCallId:`${id}:${req.toolCallId}`});}finally{if(!bounded.aborted && canExecute()){record.status="running";publish();}}}});
   bounded.throwIfAborted();child.setExecutionEnabled(true);record.status="running";publish();
   unsubscribe=child.session.subscribe(event=>{if(event.type==="message_end" && event.message.role==="assistant"){
    const message=event.message;record.tokens+=message.usage.totalTokens;record.costUSD+=message.usage.cost.total;
    spec.onChildUsage?.(model as AgentSpec["model"],message.usage);
    publish();
   }});
   await child.session.prompt(input.task);
   const last=[...child.session.messages].reverse().find(message=>message.role==="assistant");
   record.result=last?.role==="assistant" ? last.content.filter(block=>block.type==="text").map(block=>block.text).join("\n").slice(0,12000) : "";
   if(bounded.aborted || !canExecute() || last?.role==="assistant" && ["error","aborted"].includes(last.stopReason))throw new Error("子 Agent 已停止或未完成；请核对已执行操作，不要自动重跑。");
   if(!record.result.trim())throw new Error("子 Agent 没有返回验收结果，请检查任务记录。");
   record.status="done";publish();return {content:[{type:"text",text:record.result || "子 Agent 已结束，但没有返回文字结果。"}],details:{agentId:id}};
  }catch(error){record.status=bounded.aborted || !canExecute() ? "cancelled" : "error";record.error=error instanceof Error ? error.message : "子 Agent 未完成";publish();return {isError:true,content:[{type:"text",text:record.error}],details:{agentId:id}};}
  finally {bounded.removeEventListener("abort",abort);unsubscribe?.();await child?.shutdown();concurrent--;}
 }} as ToolDefinition;
}
