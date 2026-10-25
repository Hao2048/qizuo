import type {WorkbenchDeliverable} from '@pi-harness/contracts';
import {validateDataSchema} from './delivery-schema.js';
import {owns,validOwnedPaths} from './workspace.js';

/** Optional business checks are explicitly versioned shared contracts, not routing output. */
export function bindContractSchemas(items:WorkbenchDeliverable[],contracts:{id:string;roles:string[];content:string}[],roleId:string,owned:string[]):WorkbenchDeliverable[]{
 const result=structuredClone(items),bound=new Map<string,string>();
 for(const c of contracts){
  if(!c.roles.includes(roleId))continue;
  let value:unknown;try{value=JSON.parse(c.content);}catch{continue;}
  if(!value||typeof value!=='object'||Array.isArray(value))continue;
  const {$id,$schema,...schema}=value as Record<string,unknown>;
  if(typeof $id!=='string'||!$id.toLowerCase().endsWith('.json')||!owns($id,owned))continue;
  if(validOwnedPaths([$id])[0]!==$id)throw Error('业务 Schema 的文件路径无效');
  try{validateDataSchema(schema);}catch{throw Error('业务 Schema 不符合当前支持的标准子集，请核对 '+$id);}
  const signature=JSON.stringify(schema);
  if(bound.has($id)&&bound.get($id)!==signature)throw Error('同一文件存在冲突的业务 Schema，请先确认唯一约定');
  bound.set($id,signature);
  const item:WorkbenchDeliverable={path:$id,format:'json',schema};
  const index=result.findIndex(x=>x.path===$id);
  if(index<0)result.push(item);else result[index]=item;
 }
 return result;
}
