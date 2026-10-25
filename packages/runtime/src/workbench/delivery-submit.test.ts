import{afterEach,beforeEach,expect,it}from'vitest';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{WorkbenchDeliverable,validateOrFirstError}from'@pi-harness/contracts';
import{checkDeliverables,resolveDeliverables,DeliveryValidationError}from'./deliverables.js';
import{submitDeliverable,deliveryToken}from'./delivery-submit.js';
import{serializeJson,validateDataSchema,schemaDiagnostics as schemaDiagnosticsForTest}from'./delivery-schema.js';
let root:string;
const owned=['data','docs'];const items:WorkbenchDeliverable[]=[{path:'data/result.json',format:'json',schema:{type:'object',required:['version','items'],additionalProperties:false,properties:{version:{type:'string',const:'1.0'},items:{type:'array',minItems:1,items:{type:'object',required:['id'],additionalProperties:false,properties:{id:{type:'string',minLength:1}}}}}}},{path:'docs/PRD.md',format:'text',sections:[{id:'mvp',title:'MVP范围'},{id:'acceptance',title:'验收标准'}]}];
const token=()=>deliveryToken('task',owned,items);const submit=(value:unknown,t=token())=>submitDeliverable(root,owned,items,token(),{contractToken:t,path:'data/result.json',format:'json',data:value},()=>{});
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'pih-submit-'));});afterEach(()=>{rmSync(root,{recursive:true,force:true});rmSync(root+'-delivery-state',{recursive:true,force:true});});
it('serializes quotes/newlines safely and uses the same schema for submission and current-file handoff',()=>{
 const data={version:'1.0',items:[{id:'引号"换行\n'}]};const receipt=submit(data);expect(JSON.parse(readFileSync(join(root,receipt.path),'utf8'))).toEqual(data);expect(checkDeliverables(root,owned,[items[0]!]).status).toBe('passed');
 writeFileSync(join(root,receipt.path),'{"version":"1.0","items":[{}]}');const check=checkDeliverables(root,owned,[items[0]!]);expect(check.status).toBe('failed');expect(check.diagnostics).toContainEqual(expect.objectContaining({code:'MISSING_FIELD',pointer:'/items/0/id'}));
});
it('rejects bad data without changing existing bytes or creating output directories; diagnostics never echo rejected values',()=>{
 expect(()=>submit({version:'PRIVATE_REJECTED_VALUE',items:[]})).toThrow(DeliveryValidationError);expect(existsSync(join(root,'data'))).toBe(false);
 submit({version:'1.0',items:[{id:'good'}]});const before=readFileSync(join(root,'data/result.json'),'utf8');
 try{submit({version:123,items:[{id:42}]});throw Error('unexpected success');}catch(e){expect(e).toBeInstanceOf(DeliveryValidationError);expect((e as DeliveryValidationError).diagnostics).toContainEqual(expect.objectContaining({code:'TYPE_MISMATCH',pointer:'/version'}));expect(String(e)).not.toContain('123');}
 expect(readFileSync(join(root,'data/result.json'),'utf8')).toBe(before);
});
it('does not let a worker add invented conditions, paths or weaken an authoritative contract',()=>{
 const a:WorkbenchDeliverable[]=[{path:'docs/PRD.md',format:'text',includes:['真实要求']}];expect(resolveDeliverables(a,[{path:'docs/PRD.md',format:'text',includes:['幻觉精确标题']},{path:'docs/extra.md',format:'text'}],owned)).toEqual(a);
 expect(()=>resolveDeliverables([{path:'data/x',format:'json',fields:[{pointer:'/duration',equals:30}]}],[{path:'data/x',format:'json',fields:[{pointer:'/duration',equals:15}]}],owned)).toThrow('分工不一致');
 expect(resolveDeliverables([],a,owned)).toEqual(a);
});
it('rejects stale contracts, undeclared paths, traversal, symlinks and revoked execution without writing',()=>{
 expect(()=>submit({version:'1.0',items:[{id:'x'}]},'stale')).toThrow('契约已变化');
 for(const path of ['../escape.json','/tmp/escape.json','data/undeclared.json'])expect(()=>submitDeliverable(root,owned,items,token(),{contractToken:token(),path,format:'json',data:{}},()=>{})).toThrow();
 symlinkSync(tmpdir(),join(root,'data'));expect(()=>submit({version:'1.0',items:[{id:'x'}]})).toThrow();rmSync(join(root,'data'));
 let calls=0;expect(()=>submitDeliverable(root,owned,items,token(),{contractToken:token(),path:'data/result.json',format:'json',data:{version:'1.0',items:[{id:'x'}]}},()=>{if(++calls===2)throw Error('已暂停');})).toThrow('已暂停');expect(existsSync(join(root,'data/result.json'))).toBe(false);
});
it('renders canonical ordered sections from IDs and leaves legacy exact text checks exact',()=>{
 submitDeliverable(root,owned,items,token(),{contractToken:token(),path:'docs/PRD.md',format:'sections',sections:[{id:'acceptance',content:'可验证条件'},{id:'mvp',content:'范围正文'}]},()=>{});
 const p=join(root,'docs/PRD.md'),text=readFileSync(p,'utf8');expect(text.indexOf('MVP范围')).toBeLessThan(text.indexOf('验收标准'));expect(checkDeliverables(root,owned,[items[1]!]).status).toBe('passed');
 writeFileSync(p,text.replace('MVP范围','MVP 范围'));expect(checkDeliverables(root,owned,[items[1]!]).status).toBe('passed');expect(checkDeliverables(root,owned,[{path:'docs/PRD.md',format:'text',includes:['MVP范围']}]).status).toBe('failed');
 const before=readFileSync(p,'utf8');expect(()=>submitDeliverable(root,owned,items,token(),{contractToken:token(),path:'docs/PRD.md',format:'sections',sections:[{id:'invented',content:'x'}]},()=>{})).toThrow();expect(readFileSync(p,'utf8')).toBe(before);
});
it('requires mutually exclusive declaration shapes and rejects unsupported schemas and non-JSON JS values',()=>{
 expect(validateOrFirstError(WorkbenchDeliverable,{path:'data/x',format:'json',includes:[]}).ok).toBe(false);expect(validateOrFirstError(WorkbenchDeliverable,{path:'docs/x',format:'text',fields:[]}).ok).toBe(false);
 for(const schema of [{$ref:'https://never-fetch.invalid/schema'},{type:'invented'},{type:'array',minItems:-1},{minimum:2,maximum:1}])expect(()=>validateDataSchema(schema)).toThrow();
 let getterCalls=0;const cycle:any={};cycle.self=cycle;for(const value of [cycle,{x:undefined},{x:Infinity},{x:1n},new Date(),{get secret(){getterCalls++;return 'not to be read';}}])expect(()=>serializeJson(value)).toThrow();expect(getterCalls).toBe(0);
});
it('keeps malformed JSON content out of shared validation errors, including generic and directory declarations',()=>{
 mkdirSync(join(root,'data'));writeFileSync(join(root,'data/bad.json'),'PRIVATE_INVALID_JSON');
 for(const requirement of [{path:'data/bad.json',format:'json'},{path:'data/bad.json',format:'file'},{path:'data',format:'directory'}]as WorkbenchDeliverable[]){const c=checkDeliverables(root,owned,[requirement]);expect(c.status).toBe('failed');expect(JSON.stringify(c)).not.toContain('PRIVATE_INVALID_JSON');expect(c.diagnostics?.[0]?.code).toBe('INVALID_JSON');}
});
it('matches standard validation for the supported schema subset across nested objects, unions, enums and bounds',()=>{
 const schemas=[{type:'integer',minimum:0,maximum:3},{type:'string',minLength:1,maxLength:2},{type:'array',minItems:1,maxItems:2,items:{enum:[1,2]}},{type:'object',required:['x'],properties:{x:{anyOf:[{type:'null'},{type:'integer'}]}},additionalProperties:false},{enum:[{a:1,b:2},null]},{type:['string','null']}];
 for(const schema of schemas){validateDataSchema(schema);for(const value of [null,0,1,1.5,4,'','a','abc',[],[1],[1,3],{x:null},{x:2},{x:'bad'},{a:1,b:2}]){
  const errors=checkValue(value,schema);expect(errors).toBe(validateOrFirstError(schema as any,value).ok);
 }}
});
function checkValue(value:unknown,schema:Record<string,unknown>){return schemaDiagnosticsForTest(value,schema,'result.json').length===0;}

it('applies declared text conditions as well as JSON syntax when a text artifact uses a .json extension',()=>{
 mkdirSync(join(root,'data'));writeFileSync(join(root,'data/text.json'),'{}');
 const contract:WorkbenchDeliverable={path:'data/text.json',format:'text',includes:['required']};
 expect(checkDeliverables(root,owned,[contract]).diagnostics).toContainEqual(expect.objectContaining({code:'MISSING_TEXT'}));
 writeFileSync(join(root,'data/text.json'),'"required"');expect(checkDeliverables(root,owned,[contract]).status).toBe('passed');
});

it('rejects nonfinite parsed JSON just as structured submission does',()=>{
 mkdirSync(join(root,'data'));writeFileSync(join(root,'data/overflow.json'),'{"value":1e999}');
 expect(checkDeliverables(root,owned,[{path:'data/overflow.json',format:'json'}]).status).toBe('failed');
 expect(()=>serializeJson({value:Infinity})).toThrow();
});
it('reports the exact format-specific declaration location instead of a union-root error without exposing rejected values',()=>{
 try{resolveDeliverables([],[{path:'data/content-model.json',format:'json',fields:[{pointer:'/projects',type:'PRIVATE_BAD_TYPE'}]}] as any,owned);throw Error('unexpected pass');}
 catch(error){expect(error).toBeInstanceOf(DeliveryValidationError);expect((error as DeliveryValidationError).diagnostics[0]?.pointer).toBe('/fields/0/type');expect(String(error)).not.toContain('PRIVATE_BAD_TYPE');}
});
