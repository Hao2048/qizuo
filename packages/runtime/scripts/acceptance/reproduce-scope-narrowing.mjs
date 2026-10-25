/** Diagnosis only: preserves the real workspace guard and demonstrates an unresolved handoff case. */
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cloneWorkspace,manifest,applyWorkspace} from '../../src/workbench/workspace.ts';
const temp=mkdtempSync(join(tmpdir(),'pih-scope-repro-'));
try {
 const source=join(temp,'source'),first=join(temp,'first'),second=join(temp,'second'),downstream=join(temp,'downstream');
 mkdirSync(source);const initial=cloneWorkspace(source,first);
 mkdirSync(join(first,'brief'));mkdirSync(join(first,'contracts'));
 writeFileSync(join(first,'brief/brief.json'),'{"duration":15}');
 writeFileSync(join(first,'contracts/video-delivery.json'),'{"duration":15}');
 const baseline=cloneWorkspace(source,second);
 applyWorkspace(first,second,initial,['brief','contracts/video-delivery.json']);
 writeFileSync(join(second,'brief/brief.json'),'{"duration":30}');
 cloneWorkspace(source,downstream);
 let message='';try{applyWorkspace(second,downstream,baseline,['brief']);}catch(error){message=String(error.message);}
 if(!message.includes('职责外文件：contracts/video-delivery.json'))throw Error('Known handoff failure did not reproduce');
 console.log(JSON.stringify({workflowDefectReproduced:true,guardBlocked:true,error:message,sourceUntouched:Object.keys(manifest(source)).length===0,downstreamUntouched:Object.keys(manifest(downstream)).length===0}));
}finally{rmSync(temp,{recursive:true,force:true});}
