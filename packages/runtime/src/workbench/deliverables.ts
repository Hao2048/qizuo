import {readFileSync,lstatSync} from 'node:fs';
import {extname} from 'node:path';
import {WorkbenchDeliverable,validateOrFirstError,type WorkbenchDeliveryCheck,type DeliveryDiagnostic} from '@pi-harness/contracts';
import {manifest,owns,safePath,validOwnedPaths} from './workspace.js';
import {routingDiagnostic} from './routing-diagnostic.js';
import {schemaDiagnostics,validateDataSchema,assertJsonData} from './delivery-schema.js';
const readUtf8=(path:string)=>new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path));
export const diagnosticText=(d:DeliveryDiagnostic)=>`${d.path??'交付声明'}${d.pointer?` 字段 ${d.pointer}`:''}：${d.message}；${d.suggestion}`;
export class DeliveryValidationError extends Error {
 constructor(readonly diagnostics:DeliveryDiagnostic[]){super(diagnostics.map(diagnosticText).join('；'));}
}
const issue=(code:string,path:string|undefined,message:string,pointer?:string):DeliveryDiagnostic=>({code,path,pointer,message,suggestion:'请按本轮交付契约修正对应文件或字段，再重新提交。'});
export function validateDeliverables(items:WorkbenchDeliverable[],owned:string[]):void {
 const seen=new Set<string>();
 for(const item of items){
  if(!item||typeof item!=='object')throw new DeliveryValidationError([issue("INVALID_DECLARATION",undefined,"交付声明必须为对象")]);
  const fail=(code:string,message:string,pointer?:string):never=>{throw new DeliveryValidationError([issue(code,item?.path,message,pointer)]);};
  if(item.fields!==undefined&&item.format!=='json')fail('FORMAT_FIELD_MISMATCH','字段检查只适用于 JSON 交付物');
  if((item.includes!==undefined||item.sections!==undefined)&&item.format!=='text')fail('FORMAT_FIELD_MISMATCH','文本检查只适用于 text 交付物');
  if(item.schema!==undefined&&item.format!=='json')fail('FORMAT_FIELD_MISMATCH','JSON Schema 只适用于 JSON 交付物');
  const branch=item.format==='json'?WorkbenchDeliverable.anyOf[0]:item.format==='text'?WorkbenchDeliverable.anyOf[1]:item.format==='file'||item.format==='directory'?WorkbenchDeliverable.anyOf[2]:null;
  if(!branch)fail('INVALID_DECLARATION','format 只允许 json、text、file 或 directory','/format');
  const shape=validateOrFirstError(branch!,item);
  if(!shape.ok){
   const detail=routingDiagnostic(shape.message),pointer=detail.match(/^字段 (\/[^ ]*)/)?.[1]??'/';
   const hint=item.format==='json'?'JSON字段检查仅允许 pointer、type、equals；required等完整约束请写入schema':item.format==='text'?'text只允许path、format、includes和sections；sections每项包含id与title':'file/directory只允许path和format';
   fail('INVALID_DECLARATION',`交付声明结构无效；${detail}。${hint}`,pointer);
  }
  try{if(validOwnedPaths([item.path])[0]!==item.path||!owns(item.path,owned))fail('PATH_NOT_OWNED','交付路径不属于本角色职责');}catch(e){if(e instanceof DeliveryValidationError)throw e;fail('PATH_NOT_OWNED','交付路径不属于本角色职责');}
  if(seen.has(item.path))fail('DUPLICATE_PATH','交付路径重复');seen.add(item.path);
  for(const field of item.fields??[])if(field.pointer!==''&&(!field.pointer.startsWith('/')||/~(?:[^01]|$)/.test(field.pointer)))fail('INVALID_POINTER','JSON 字段指针无效',field.pointer);
  if(item.schema)try{validateDataSchema(item.schema);}catch{fail('INVALID_SCHEMA','JSON Schema 无效或包含当前不支持的关键字');}
  if(item.sections?.some(s=>!s.title.trim()||/[\r\n]/.test(s.title)))fail('INVALID_SECTION','章节标题必须为非空单行文本');
  if(item.sections&&new Set(item.sections.map(s=>s.id)).size!==item.sections.length)fail('DUPLICATE_SECTION','章节 ID 重复');
 }
}
/** The dispatcher contract is authoritative. Legacy roles can supply a contract only when none exists. */
export function resolveDeliverables(assigned:WorkbenchDeliverable[]=[],proposed:WorkbenchDeliverable[]=[],owned:string[]):WorkbenchDeliverable[]{
 validateDeliverables(assigned,owned);validateDeliverables(proposed,owned);
 if(!assigned.length)return structuredClone(proposed);
 for(const p of proposed){const a=assigned.find(a=>a.path===p.path);if(a&&a.format!==p.format)throw new DeliveryValidationError([issue('CONTRACT_MISMATCH',p.path,'交付格式与任务助手分工不一致，请先澄清约定')]);
  for(const f of p.fields??[]){const old=a?.fields?.find(x=>x.pointer===f.pointer);if(old&&((old.type&&f.type&&old.type!==f.type)||(Object.hasOwn(old,'equals')&&Object.hasOwn(f,'equals')&&old.equals!==f.equals)))throw new DeliveryValidationError([issue('CONTRACT_MISMATCH',p.path,'交付字段与任务助手分工不一致，请先澄清约定',f.pointer)]);}}
 return structuredClone(assigned);
}
function fieldAt(value:unknown,pointer:string):{found:boolean;value:unknown}{
 if(pointer==='')return {found:true,value};
 for(const key of pointer.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'))){if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))return {found:false,value:undefined};value=(value as Record<string,unknown>)[key];}
 return {found:true,value};
}
export function jsonDiagnostics(value:unknown,item:WorkbenchDeliverable):DeliveryDiagnostic[]{
 const errors:DeliveryDiagnostic[]=[];
 for(const f of item.fields??[]){const actual=fieldAt(value,f.pointer);if(!actual.found){errors.push(issue('MISSING_FIELD',item.path,'缺少必填字段',f.pointer));continue;}
  const type=actual.value===null?'null':Array.isArray(actual.value)?'array':typeof actual.value;
  if(f.type&&type!==f.type)errors.push(issue('TYPE_MISMATCH',item.path,`字段类型应为 ${f.type}`,f.pointer));
  if(Object.hasOwn(f,'equals')&&actual.value!==f.equals)errors.push(issue('VALUE_MISMATCH',item.path,'字段不符合约定值',f.pointer));
 }
 if(item.schema)errors.push(...schemaDiagnostics(value,item.schema,item.path));return errors;
}
export function textDiagnostics(content:string,item:WorkbenchDeliverable):DeliveryDiagnostic[]{
 const errors:DeliveryDiagnostic[]=[];
 if(!content.trim()||content.includes('\u0000'))errors.push(issue('INVALID_TEXT',item.path,'不是有效的非空 UTF-8 文本'));
 for(const text of item.includes??[])if(!content.includes(text))errors.push(issue('MISSING_TEXT',item.path,`缺少约定文本：${text}`));
 const lines=content.split('\n'),normalize=(s:string)=>s.normalize('NFKC').replace(/\s/g,'');
 for(const s of item.sections??[]){const indices=lines.flatMap((line,i)=>line.trim()===`<!-- pih-section:${s.id} -->`?[i]:[]);const heading=indices.length===1?lines.slice(indices[0]!+1).find(line=>line.trim()):undefined;const title=heading?.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
  if(indices.length!==1||!title||normalize(title)!==normalize(s.title))errors.push(issue('MISSING_SECTION',item.path,`缺少或重复约定章节 ID/标题：${s.id}`));
 }
 return errors;
}
const parseJson=(path:string)=>{try{const value=JSON.parse(readUtf8(path));assertJsonData(value);return value;}catch{throw Error('不是有效的 UTF-8 JSON，未公开文件内容，请检查 JSON 语法');}};
/** The same rules validate submission, dependency handoff, application and current-file rechecks. */
export function checkDeliverables(root:string,owned:string[],requirements:WorkbenchDeliverable[]=[]):WorkbenchDeliveryCheck {
 const result:WorkbenchDeliveryCheck={status:'passed',at:Date.now(),issues:[],diagnostics:[],files:[]};
 const add=(d:DeliveryDiagnostic)=>{result.diagnostics!.push(d);result.issues.push(diagnosticText(d));};
 try{
  validateDeliverables(requirements,owned);
  const files=manifest(root,true),paths=Object.keys(files).filter(p=>owns(p,owned));
  const items=requirements.length?requirements:paths.filter(path=>lstatSync(safePath(root,path)).size>0).map(path=>({path,format:extname(path).toLowerCase()==='.json'?'json':'file'} as WorkbenchDeliverable));
  if(!items.length)throw Error('没有可交接的职责内文件，请明确并生成交付物');
  const checked=new Set<string>();
  for(const item of items){try{
   const target=safePath(root,item.path),stat=lstatSync(target,{throwIfNoEntry:false});
   if(!stat){add(issue('MISSING_FILE',item.path,'文件不存在'));continue;}
   if(item.format==='directory'){
    if(!stat.isDirectory()){add(issue('INVALID_FILE_TYPE',item.path,'应为文件夹'));continue;}
    const children=paths.filter(p=>p.startsWith(item.path+'/'));
    if(!children.some(p=>lstatSync(safePath(root,p)).size>0)){add(issue('EMPTY_DIRECTORY',item.path,'文件夹没有非空交付文件'));continue;}
    for(const p of children){if(extname(p).toLowerCase()==='.json'&&lstatSync(safePath(root,p)).size>0){try{parseJson(safePath(root,p));}catch{add(issue('INVALID_JSON',p,'不是有效的 UTF-8 JSON，未公开文件内容'));}}checked.add(p);}continue;
   }
   if(!stat.isFile()||stat.size===0){add(issue('EMPTY_FILE',item.path,'应为非空普通文件'));continue;}checked.add(item.path);
   if(item.format==='json'||extname(item.path).toLowerCase()==='.json'){
    let value:unknown;try{value=parseJson(target);}catch{add(issue('INVALID_JSON',item.path,'不是有效的 UTF-8 JSON，未公开文件内容'));continue;}jsonDiagnostics(value,item).forEach(add);
   }if(item.format==='text')textDiagnostics(readUtf8(target),item).forEach(add);
  }catch{add(issue('FILE_UNREADABLE',item.path,'文件无法安全读取，请核对路径、类型和编码'));}}
  result.files=[...checked].sort().map(path=>({path,hash:files[path]!}));
 }catch(error){if(error instanceof DeliveryValidationError)error.diagnostics.forEach(add);else add(issue('INVALID_HANDOFF',undefined,'无法检查职责内交付文件，请核对目录、符号链接和交付声明'));}
 if(result.issues.length)result.status='failed';return result;
}
