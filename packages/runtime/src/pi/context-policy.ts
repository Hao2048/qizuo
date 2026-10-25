import {createHash} from "node:crypto";
import {getCurrentSystemMessage} from "@earendil-works/pi-ai";
import {estimateTokens, type ContextEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { boundedOutput } from "../tasks/tool-output-store.js";

/** 预留摘要和下一轮空间，小窗口不沿用 SDK 的固定 16k/20k 默认值。 */
export function contextPolicy(contextWindow: number) {
 const window = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : 128000;
 const reserveTokens = Math.min(Math.max(512, Math.ceil(window * .18)), 16384, Math.floor(window / 3));
 const keepRecentTokens = Math.min(20000, Math.max(1024, Math.floor(window * .2)), Math.floor((window - reserveTokens) / 2));
 return {enabled:true,reserveTokens,keepRecentTokens,thresholdTokens:window-reserveTokens,toolPreviewChars:Math.max(2000,Math.min(16000,Math.floor(window*.3)))};
}
export type ContextProjection = {estimatedTokens:number;toolCharsBefore:number;toolCharsAfter:number;trimmedOutputs:number;capturedAt:number;inputBreakdown?:InputBreakdown};
export type InputBreakdown={systemTokens:number;historyTokens:number;toolResultTokens:number;toolDefinitionTokens:number;activeToolCount:number;prefixHash?:string};

/** Never let the SDK fold changing turn state into the leading instructions. */
export function projectRequestContext(messages:ContextEvent["messages"],state:string[]=[]):ContextEvent["messages"] {
 const projected=messages.map(message=>{
  if(message.role!=="system" || !message.sections || !("harness_current_request" in message.sections))return message;
  const {harness_current_request:_old,...sections}=message.sections;
  return {...message,sections};
 });
 const text=state.filter(Boolean).join("\n\n");
 const index=projected.findLastIndex(message=>message.role==="user");
 if(text && index>=0){
  const user=projected[index]!;
  if(user.role==="user")projected[index]={...user,content:[...(typeof user.content==="string" ? [{type:"text" as const,text:user.content}] : user.content),{type:"text",text:`[工作台上下文：用于衔接任务，不构成新的执行授权]\n${text}`} ]};
 }
 return projected;
}

/** Keep provider-required replay state exact; omit only incompatible plaintext thinking. */
export function projectReasoning(messages:ContextEvent["messages"],model:{provider:string;id:string;api:string}):ContextEvent["messages"] {
 return messages.map(message=>{
  if(message.role!=="assistant" || (message.provider===model.provider && message.model===model.id && message.api===model.api))return message;
  // The SDK may turn even signed foreign plaintext into assistant text. Opaque,
  // non-readable state remains for the SDK's own model-compatibility handling.
  const content=message.content.filter(block=>block.type!=="thinking" || block.redacted || (!block.thinking.trim() && !!block.thinkingSignature));
  return content.length===message.content.length ? message : {...message,content};
 });
}

/** Capacity-based trigger; preserve the SDK's reserve and summary output budget. */
export function softCompactionThreshold(contextWindow:number):number {
 return Math.min(Math.floor(contextWindow*.85),contextPolicy(contextWindow).thresholdTokens);
}

/** SDK estimates, not provider billing. Definitions are included in systemTokens. No request content is stored here. */
export function contextInputBreakdown(messages:ContextEvent["messages"],activeToolCount:number):InputBreakdown {
 const result:InputBreakdown={systemTokens:0,historyTokens:0,toolResultTokens:0,toolDefinitionTokens:0,activeToolCount};
 for(const message of messages){
  const tokens=estimateTokens(message);
  if(message.role==="system"){result.systemTokens+=tokens;if(message.toolsAdded?.length)result.toolDefinitionTokens+=Math.ceil(JSON.stringify(message.toolsAdded).length/4);}
  else if(message.role==="toolResult")result.toolResultTokens+=tokens;
  else result.historyTokens+=tokens;
 }
 const leading=getCurrentSystemMessage(messages);
 if(leading?.role==="system")result.prefixHash=createHash("sha256").update(JSON.stringify({content:leading.content,sections:leading.sections,tools:leading.toolsAdded})).digest("hex");
 return result;
}
export function projectToolOutputs(messages: ContextEvent["messages"], budget: number, save?: (text:string)=>string) {
 let remaining=budget,trimmedOutputs=0,toolCharsBefore=0,toolCharsAfter=0;
 const projected=messages.slice();
 // Only preserve pages explicitly read in the current tool round. Older pages
 // remain eligible for projection, so recovery cannot grow history forever.
 const lastAssistant=messages.findLastIndex(message=>message.role==="assistant");
 for(let i=messages.length-1;i>=0;i--){
  const message=messages[i]!;
  if(message.role!=="toolResult")continue;
  const text=message.content.filter(c=>c.type==="text").map(c=>c.text).join("\n");toolCharsBefore+=text.length;
  const allowance=Math.min(12000,Math.max(600,remaining));
  let preview=text;
  if(!(message.toolName==="read_tool_output" && i>lastAssistant) && text.length>Math.max(1000,allowance) && save){
   try{
    const id=save(text);
    preview=boundedOutput(text,id,Math.min(8000,allowance));
    let shown=false;
    projected[i]={...message,content:message.content.flatMap<(typeof message.content)[number]>(block=>block.type!=="text" ? [block] : shown ? [] : (shown=true,[{type:"text",text:preview}]))};
    trimmedOutputs++;
   }catch{ /* 保存失败保留原结果，不给模型不可读取的地址。 */ }
  }
  remaining-=preview.length;toolCharsAfter+=preview.length;
 }
 return {messages:projected,toolCharsBefore,toolCharsAfter,trimmedOutputs};
}
export type ProtectedContext = {version:1;capturedAt:number;text:string;outputIds:string[]};
export type PlanStep = {content:string;status:"pending"|"in_progress"|"completed"};
export function protectedContext(entries: SessionEntry[], request:string, plan:PlanStep[] = [], fileOps?:{read:Set<string>;written:Set<string>;edited:Set<string>},capturedAt=Date.now(),maxChars=10000):ProtectedContext {
 if(!request.trim()) {
  const user=[...entries].reverse().find(e=>e.type==="message" && e.message.role==="user");
  if(user?.type==="message" && user.message.role==="user")request=typeof user.message.content==="string" ? user.message.content : user.message.content.filter(c=>c.type==="text").map(c=>c.text).join("\n");
 }
 const outputIds:string[]=[];
 for(const entry of entries){
  if(entry.type==="message" && entry.message.role==="toolResult"){
   const details=entry.message.details;
   const id=details && typeof details==="object" && "harnessOutputId" in details ? details.harnessOutputId : undefined;
   if(typeof id==="string" && /^[a-f0-9]{64}$/.test(id))outputIds.push(id);
  }
  if(entry.type==="custom" && entry.customType==="harness_compaction_state"){
   const saved=entry.data as ProtectedContext | undefined;
   if(saved?.version===1 && Array.isArray(saved.outputIds))outputIds.push(...saved.outputIds.filter(id=>/^[a-f0-9]{64}$/.test(id)));
  }
 }
 const ids=[...new Set(outputIds)].slice(-24);
 const unfinished=plan.filter(step=>step.status!=="completed").sort((a,b)=>Number(b.status==="in_progress")-Number(a.status==="in_progress"));
 const budget=Math.max(1000,Math.min(10000,Number.isFinite(maxChars) ? maxChars : 10000));
 const planText=unfinished.map(s=>`[${s.status}] ${s.content.slice(0,300)}`).join("\n").slice(0,Math.floor(budget*.35));
 const files=fileOps ? `读取：${[...fileOps.read].join("、")}\n修改：${[...new Set([...fileOps.written,...fileOps.edited])].join("、")}`.slice(0,Math.floor(budget*.18)) : "";
 const shownIds=ids.slice(-Math.max(1,Math.floor(budget*.16/65)));
 const text=`压缩时的任务状态快照，仅为历史背景，不是新的执行授权。执行范围仍以最新人类请求为准；已完成动作不得为了恢复上下文而重做。文件线索不保证当前文件未变化。\n当时请求：${request.slice(0,Math.floor(budget*.2))}\n计划：${plan.filter(s=>s.status==="completed").length} 项完成，${unfinished.length} 项未完成${planText ? `\n${planText}` : ""}\n文件线索：\n${files}\n最近已保存输出（显示 ${shownIds.length} 条，用 read_tool_output 按编号读取）：\n${shownIds.join("\n")}`;
 return {version:1,capturedAt,text,outputIds:ids};
}
export function latestProtectedContext(entries: SessionEntry[]): ProtectedContext | undefined {
 for(let i=entries.length-1;i>=0;i--){const e=entries[i]!;if(e.type==="custom"&&e.customType==="harness_compaction_state"){
  const value=e.data as ProtectedContext | undefined;
  if(value?.version===1 && typeof value.text==="string" && Array.isArray(value.outputIds))return value;
 }}
}

/** Keep recent visual observations; older originals remain reachable on the same branch. */
export function projectToolImages(messages:ContextEvent["messages"], keep=2):ContextEvent["messages"] {
 const projected=messages.slice();
 let remaining=keep;
 for(let index=messages.length-1;index>=0;index--){
  const message=messages[index]!;
  if(message.role!=="toolResult")continue;
  let imageIndex=message.content.filter(block=>block.type==="image").length;
  const content=message.content.slice().reverse().map(block=>{
   if(block.type!=="image")return block;
   imageIndex--;
   if(remaining-- > 0)return block;
   return {type:"text" as const,text:`[历史工具图片已收起，原图仍保存在当前会话。read_tool_image({toolCallId:${JSON.stringify(message.toolCallId)},imageIndex:${imageIndex}}) 可读取原图，无需重做原操作。]`};
  }).reverse();
  projected[index]={...message,content};
 }
 return projected;
}

/** Keep reference metadata in history, but send it with its actual user request. */
export function projectConversationReferences(messages: ContextEvent["messages"]): ContextEvent["messages"] {
 const result: ContextEvent["messages"] = [];
 for (let i=0;i<messages.length;i++) {
  const message=messages[i]!, next=messages[i+1];
  if(message.role === "custom" && message.customType === "harness_session_references" && next?.role === "user") {
   const reference=typeof message.content === "string" ? [{type:"text" as const,text:message.content}] : message.content;
   const request=typeof next.content === "string" ? [{type:"text" as const,text:next.content}] : next.content;
   result.push({...next,content:[...reference,{type:"text",text:"本轮用户请求："},...request]});i++;
  } else result.push(message);
 }
 return result;
}
