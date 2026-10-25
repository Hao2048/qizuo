/** Deliberately supported JSON Schema subset. Unknown keywords fail closed; no refs or remote loads. */
import type {DeliveryDiagnostic} from '@pi-harness/contracts';
type Schema=Record<string,unknown>|boolean;
const types=['object','array','string','number','integer','boolean','null'];
const keys=new Set(['type','properties','required','additionalProperties','items','enum','const','anyOf','minItems','maxItems','minLength','maxLength','minimum','maximum','description','title']);
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function assertJsonData(value:unknown):void {
 const active=new Set<object>();
 const visit=(v:unknown):void=>{if(v===null||typeof v==='string'||typeof v==='boolean')return;if(typeof v==='number'&&Number.isFinite(v))return;
  if(typeof v!=='object'||!v)throw Error('仅接受可序列化的 JSON 数据');
  if(active.has(v))throw Error('JSON 数据不能包含循环引用');
  if(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw Error('仅接受普通 JSON 对象');
  if(Object.getOwnPropertySymbols(v).length)throw Error('JSON 数据不能包含 Symbol 字段');
  if(Array.isArray(v)&&Object.keys(v).some(k=>!Number.isInteger(Number(k))||String(Number(k))!==k||Number(k)<0||Number(k)>=v.length))throw Error('JSON 数组不能包含额外属性');
  active.add(v);for(const d of Object.values(Object.getOwnPropertyDescriptors(v))){if(d.get||d.set)throw Error('JSON 数据不能包含访问器');}
  if(Array.isArray(v)){for(let i=0;i<v.length;i++)visit(v[i]);}else for(const k of Object.keys(v))visit((v as Record<string,unknown>)[k]);active.delete(v);
 };visit(value);
}
export function serializeJson(value:unknown):string {assertJsonData(value);return JSON.stringify(value,null,2)+'\n';}

export function validateDataSchema(schema:unknown):void {
 assertJsonData(schema);
 const visit=(s:unknown):void=>{
  if(typeof s==='boolean')return;if(!obj(s))throw Error('交付 Schema 必须为对象');
  for(const k of Object.keys(s))if(!keys.has(k))throw Error('交付 Schema 包含不支持的关键字（不执行或加载外部引用）');
  for(const k of ['title','description'])if(s[k]!==undefined&&typeof s[k]!=='string')throw Error('Schema 标题与描述必须为字符串');
  if(s.type!==undefined&&!(typeof s.type==='string'?types.includes(s.type):Array.isArray(s.type)&&s.type.length>0&&s.type.every(t=>types.includes(t))))throw Error('Schema type 无效');
  if(s.properties!==undefined){if(!obj(s.properties))throw Error('Schema properties 必须为对象');Object.values(s.properties).forEach(visit);}
  if(s.required!==undefined&&(!Array.isArray(s.required)||!s.required.every(k=>typeof k==='string')||new Set(s.required).size!==s.required.length))throw Error('Schema required 必须为不重复字符串数组');
  if(s.items!==undefined)visit(s.items);
  if(s.additionalProperties!==undefined)visit(s.additionalProperties);
  if(s.anyOf!==undefined){if(!Array.isArray(s.anyOf)||!s.anyOf.length)throw Error('Schema anyOf 必须为非空数组');s.anyOf.forEach(visit);}
  if(s.enum!==undefined&&(!Array.isArray(s.enum)||!s.enum.length))throw Error('Schema enum 必须为非空数组');
  for(const k of ['minItems','maxItems','minLength','maxLength'])if(s[k]!==undefined&&(!Number.isInteger(s[k])||(s[k] as number)<0))throw Error('Schema 数量与长度约束无效');
  for(const k of ['minimum','maximum'])if(s[k]!==undefined&&(typeof s[k]!=='number'||!Number.isFinite(s[k])))throw Error('Schema 数值约束无效');
  for(const [a,b]of [['minItems','maxItems'],['minLength','maxLength'],['minimum','maximum']])if(typeof s[a!]==='number'&&typeof s[b!]==='number'&&(s[a!] as number)>(s[b!] as number))throw Error('Schema 最小值不能大于最大值');
 };visit(schema);
}
const pointer=(p:string,k:string)=>p+'/'+k.replace(/~/g,'~0').replace(/\//g,'~1');
const equal=(a:unknown,b:unknown):boolean=>{if(a===b)return true;if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>equal(v,b[i]));if(obj(a)&&obj(b)){const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));}return false;};
export function schemaDiagnostics(value:unknown,schema:Record<string,unknown>,path:string):DeliveryDiagnostic[]{
 const errors:DeliveryDiagnostic[]=[];
 const fail=(code:string,p:string,message:string)=>errors.push({code,path,pointer:p,message,suggestion:'按当前交付契约修正此字段；不修改其他角色或验收条件。'});
 const visit=(v:unknown,s:Schema,p:string):void=>{
  if(s===true)return;if(s===false){fail('SCHEMA_MISMATCH',p,'该字段不符合 Schema');return;}
  const actual=v===null?'null':Array.isArray(v)?'array':typeof v;
  const allowed=s.type===undefined?null:Array.isArray(s.type)?s.type:[s.type];
  if(allowed&&!allowed.some(t=>t===actual||(t==='integer'&&typeof v==='number'&&Number.isInteger(v)))){fail('TYPE_MISMATCH',p,`字段类型应为 ${allowed.join(' 或 ')}`);return;}
  if(Array.isArray(s.anyOf)&&!s.anyOf.some(child=>{const n=errors.length;visit(v,child as Schema,p);const ok=n===errors.length;errors.splice(n);return ok;}))fail('SCHEMA_MISMATCH',p,'字段未匹配任一允许结构');
  if(Object.hasOwn(s,'const')&&!equal(v,s.const))fail('VALUE_MISMATCH',p,'字段不符合约定值');
  if(Array.isArray(s.enum)&&!s.enum.some(x=>equal(v,x)))fail('VALUE_MISMATCH',p,'字段不在允许的选项中');
  if(obj(v)){
   for(const k of (s.required??[]) as string[])if(!Object.hasOwn(v,k))fail('MISSING_FIELD',pointer(p,k),'缺少必填字段');
   const props=(s.properties??{}) as Record<string,Schema>;
   for(const k of Object.keys(props))if(Object.hasOwn(v,k))visit(v[k],props[k]!,pointer(p,k));
   for(const k of Object.keys(v))if(!Object.hasOwn(props,k)&&s.additionalProperties!==undefined){if(s.additionalProperties===false)fail('UNKNOWN_FIELD',p,'对象包含未声明字段');else visit(v[k],s.additionalProperties as Schema,p);}
  }
  if(Array.isArray(v)){if(typeof s.minItems==='number'&&v.length<s.minItems)fail('TOO_FEW_ITEMS',p,'数组项数不足');if(typeof s.maxItems==='number'&&v.length>s.maxItems)fail('TOO_MANY_ITEMS',p,'数组项数过多');if(s.items!==undefined)v.forEach((item,i)=>visit(item,s.items as Schema,pointer(p,String(i))));}
  if(typeof v==='string'){const n=Array.from(v).length;if(typeof s.minLength==='number'&&n<s.minLength)fail('STRING_TOO_SHORT',p,'文本长度不足');if(typeof s.maxLength==='number'&&n>s.maxLength)fail('STRING_TOO_LONG',p,'文本长度过长');}
  if(typeof v==='number'){if(typeof s.minimum==='number'&&v<s.minimum)fail('NUMBER_TOO_SMALL',p,'数值小于约定范围');if(typeof s.maximum==='number'&&v>s.maximum)fail('NUMBER_TOO_LARGE',p,'数值大于约定范围');}
 };visit(value,schema,'');return errors;
}
