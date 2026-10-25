import type {AssistantMessage} from '@earendil-works/pi-ai';
/** Tool arguments are proposals, never executable tool requests at this read-only seam. */
export function modelSubmission(reply:AssistantMessage,name:string):{value:unknown;native:boolean}{
 const calls=reply.content.filter(c=>c.type==='toolCall');
 if(calls.length){
  if(calls.length!==1||calls[0]!.name!==name)throw Error('只允许提交一个完整的只读规划结果');
  return {value:calls[0]!.arguments,native:true};
 }
 // Compatibility boundary for providers that still return textual JSON.
 const raw=reply.content.filter(c=>c.type==='text').map(c=>c.text).join('').trim().replace(/^```(?:json)?\s*|\s*```$/g,'');
 return {value:JSON.parse(raw),native:false};
}
