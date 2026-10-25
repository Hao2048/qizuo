import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,lstatSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {dirname,join,extname} from 'node:path';
import type {WorkbenchDeliverable} from '@pi-harness/contracts';
import {safePath,owns} from './workspace.js';
import {validateDeliverables,jsonDiagnostics,textDiagnostics,DeliveryValidationError} from './deliverables.js';
import {serializeJson} from './delivery-schema.js';
export function deliveryToken(taskId:string,owned:string[],items:WorkbenchDeliverable[]):string {
 return createHash('sha256').update(JSON.stringify({version:1,taskId,owned,items})).digest('hex');
}
export type DeliverySubmission={contractToken:string;path:string;format:'json'|'text'|'sections';data?:unknown;text?:string;sections?:{id:string;content:string}[]};
export function submitDeliverable(root:string,owned:string[],items:WorkbenchDeliverable[],token:string,input:DeliverySubmission,guard:()=>unknown):{path:string;hash:string;bytes:number}{
 guard();
 const fail=(code:string,message:string):never=>{throw new DeliveryValidationError([{code,path:items.some(x=>x.path===input.path)?input.path:undefined,message,suggestion:'读取 workbench_delivery_contract 的最新契约，仅提交声明路径内的内容。'}]);};
 if(input.contractToken!==token)fail('STALE_CONTRACT','交付契约已变化，未写入任何文件');
 validateDeliverables(items,owned);
 const item=items.find(x=>x.path===input.path);
 if(!item||!owns(input.path,owned))fail('UNDECLARED_PATH','文件未在本角色交付契约中声明');
 let content:string;
 if(input.format==='json'){
  if(item!.format!=='json'||!Object.hasOwn(input,'data')||input.text!==undefined||input.sections!==undefined)fail('FORMAT_MISMATCH','JSON 提交需要 data 对象，且文件必须声明为 json');
  try{content=serializeJson(input.data);}catch{fail('INVALID_JSON_DATA','提交数据不是可序列化的 JSON，未写入文件');}
  const errors=jsonDiagnostics(input.data,item!);if(errors.length)throw new DeliveryValidationError(errors);
 }else if(input.format==='text'||input.format==='sections'){
  if(item!.format!=='text'||input.data!==undefined)fail('FORMAT_MISMATCH','文本提交必须对应 text 交付物');
  if(input.format==='text'){
   if(typeof input.text!=='string'||input.sections!==undefined)fail('INVALID_TEXT','文本提交需要 text 字符串');content=input.text!;
  }else{
   if(!item!.sections?.length||!Array.isArray(input.sections)||input.text!==undefined)fail('INVALID_SECTIONS','章节提交需要契约中已声明的章节 ID');
   const entries=input.sections!,expected=item!.sections!;
   if(entries.length!==expected.length||new Set(entries.map(x=>x.id)).size!==entries.length||entries.some(x=>!expected.some(s=>s.id===x.id)||typeof x.content!=='string'||!x.content.trim()))fail('INVALID_SECTIONS','章节缺失、重复、未声明或内容为空');
   content=expected.map(s=>`<!-- pih-section:${s.id} -->\n## ${s.title}\n\n${entries.find(x=>x.id===s.id)!.content.trim()}\n`).join('\n');
  }
  const errors=textDiagnostics(content,item!);if(errors.length)throw new DeliveryValidationError(errors);
  if(extname(item!.path).toLowerCase()==='.json'){try{JSON.parse(content);}catch{fail('INVALID_JSON','扩展名为 JSON 的交付物必须包含合法 JSON');}}
 }else fail('UNSUPPORTED_FORMAT','此工具只提交 JSON 或文本；二进制与目录继续使用原有交付流程');
 // Validate before mkdir/write. Stage outside the role tree so a crash cannot publish a partial artifact.
 const target=safePath(root,input.path),state=root+'-delivery-state';
 if(lstatSync(target,{throwIfNoEntry:false})&&!lstatSync(target).isFile())fail('INVALID_FILE_TYPE','目标不是普通文件');
 if(lstatSync(state,{throwIfNoEntry:false})?.isSymbolicLink())fail('UNSAFE_PATH','提交暂存目录无效');
 mkdirSync(state,{recursive:true,mode:0o700});const temp=join(state,randomUUID()+'.tmp');
 try{
  writeFileSync(temp,content!,{flag:'wx',mode:lstatSync(target,{throwIfNoEntry:false})?.mode??0o600});
  guard();safePath(root,input.path);mkdirSync(dirname(target),{recursive:true});guard();safePath(root,input.path);renameSync(temp,target);
 }finally{rmSync(temp,{force:true});}
 return {path:item!.path,hash:createHash('sha256').update(content!).digest('hex'),bytes:Buffer.byteLength(content!)};
}
