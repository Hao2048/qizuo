import{afterEach,beforeEach,expect,it}from'vitest';
import{mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{checkDeliverables,validateDeliverables}from'./deliverables.js';
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'pih-deliverables-'));mkdirSync(join(root,'audio'));});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
it('rejects missing, empty and malformed JSON artifacts instead of trusting completion',()=>{
 expect(checkDeliverables(root,['audio']).status).toBe('failed');
 writeFileSync(join(root,'audio/score.json'),'');expect(checkDeliverables(root,['audio']).status).toBe('failed');
 writeFileSync(join(root,'audio/score.json'),'{broken');expect(checkDeliverables(root,['audio']).issues.join()).toContain('audio/score.json');
});
it('checks required JSON fields, exact types and values including escaped keys and null',()=>{
 writeFileSync(join(root,'audio/score.json'),JSON.stringify({duration:30,channels:2,'a/b':{'x~y':null},tracks:[{}]}));
 const rules=[{path:'audio/score.json',format:'json' as const,fields:[{pointer:'/duration',type:'number' as const,equals:30},{pointer:'/a~1b/x~0y',equals:null},{pointer:'/tracks',type:'array' as const}]}];
 expect(checkDeliverables(root,['audio'],rules).status).toBe('passed');
 rules[0]!.fields[0]!.equals=15;expect(checkDeliverables(root,['audio'],rules).status).toBe('failed');
 expect(checkDeliverables(root,['audio'],[{path:'audio/score.json',format:'json',fields:[{pointer:'/missing'}]}]).status).toBe('failed');
 expect(checkDeliverables(root,['audio'],[{path:'audio/score.json',format:'json',fields:[{pointer:'/tracks',type:'object'}]}]).status).toBe('failed');
});
it('checks nonempty directories and UTF8 text clauses without executing their contents',()=>{
 expect(checkDeliverables(root,['audio'],[{path:'audio',format:'directory'}]).status).toBe('failed');
 writeFileSync(join(root,'audio/README.md'),'接口：POST /save');
 expect(checkDeliverables(root,['audio'],[{path:'audio/README.md',format:'text',includes:['POST /save']}]).status).toBe('passed');
 expect(checkDeliverables(root,['audio'],[{path:'audio/README.md',format:'text',includes:['GET /save']}]).status).toBe('failed');
 expect(checkDeliverables(root,['audio'],[{path:'audio',format:'directory'}]).status).toBe('passed');
});
it('rejects out-of-scope, traversal, duplicate paths, invalid pointers and symlinks',()=>{
 for(const path of ['../other','/tmp/other','peer.txt'])expect(()=>validateDeliverables([{path,format:'file'}],['audio'])).toThrow();
 expect(()=>validateDeliverables([{path:'audio/x',format:'json',fields:[{pointer:'/x~2'}]}],['audio'])).toThrow();
 expect(()=>validateDeliverables([{path:'audio/x',format:'file'},{path:'audio/x',format:'file'}],['audio'])).toThrow();
 symlinkSync('/etc/passwd',join(root,'audio/link'));expect(checkDeliverables(root,['audio']).status).toBe('failed');
});
it('rechecks current bytes instead of reusing a previous success receipt',()=>{
 writeFileSync(join(root,'audio/score.json'),'{"duration":30}');const first=checkDeliverables(root,['audio']);expect(first.status).toBe('passed');
 writeFileSync(join(root,'audio/score.json'),'{"duration":15}');const second=checkDeliverables(root,['audio']);expect(second.files).not.toEqual(first.files);
});
it('allows optional empty legacy scaffolding but still rejects malformed JSON declared as a generic file or directory',()=>{
 writeFileSync(join(root,'audio/__init__.py'),'');writeFileSync(join(root,'audio/readme.txt'),'real handoff');
 expect(checkDeliverables(root,['audio']).status).toBe('passed');
 writeFileSync(join(root,'audio/score.json'),'{broken');
 expect(checkDeliverables(root,['audio'],[{path:'audio/score.json',format:'file'}]).status).toBe('failed');
 expect(checkDeliverables(root,['audio'],[{path:'audio',format:'directory'}]).status).toBe('failed');
});
