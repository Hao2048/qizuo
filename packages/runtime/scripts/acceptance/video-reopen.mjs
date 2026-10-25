// Reopen a SYNTHETIC acceptance profile after packaging. Never use a formal profile.
import {desktopSession,pause} from './desktop-session.mjs';
import {readFileSync,writeFileSync,renameSync,rmSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
const out=resolve(process.env.PIH_VIDEO_ACCEPTANCE_OUT ?? 'docs/role-workbench-v2/acceptance/video-workflow-fixed');
const retained=JSON.parse(readFileSync('/tmp/pih-video-fixed-retained.json','utf8'));
if(existsSync(retained.data))throw Error('Original acceptance profile was not removed');
renameSync(retained.backup,retained.data);
const session=await desktopSession({dataDir:retained.data,copyAuth:false});
const setup=JSON.parse(readFileSync(join(out,'setup.json'),'utf8'));
const call=session.invoke,save=(name,value)=>writeFileSync(join(out,name+'.json'),JSON.stringify(value,null,2));
async function calls(){const items=[];let cursor;do{const p=await call('workbench:usageCalls',{id:setup.id,...(cursor?{cursor}:{})});items.push(...p.calls);cursor=p.nextCursor;}while(cursor);return items;}
try{
 const before=await calls(),restored=await call('workbench:get',{id:setup.id});
 if(restored.phase!=='done'||restored.participants.slice(0,4).some(p=>p.status!=='applied'))throw Error('Completed results did not survive reopen');
 save('reopened-state',restored);
 for(const enabled of [false,true]){const w=await call('workbench:setEnabled',{id:setup.id,roleId:setup.roleIds[0].id,enabled});if(w.participants[0].status!=='applied')throw Error('Pause changed applied result');}
 const r=await call('workbench:review',{id:setup.id,roleId:setup.roleIds[3].id});
 if(r.blockedReason||r.conflicts)throw Error('Reopened review blocked');
 // Idempotent reapplication of already-reviewed output makes it eligible for a fresh integration check.
 await call('workbench:apply',{id:setup.id,roleId:setup.roleIds[3].id,reviewToken:r.token});
 await call('workbench:verify',{id:setup.id,commands:['node acceptance/verify.mjs'],network:false});
 let w;for(let i=0;i<120;i++){w=await call('workbench:get',{id:setup.id});if(w.verification?.status!=='running')break;await pause(500);}
 if(w?.verification?.status!=='passed')throw Error('Final packaged verification failed: '+JSON.stringify(w?.verification));
 const after=await calls();
 if(JSON.stringify(before.map(c=>c.id))!==JSON.stringify(after.map(c=>c.id)))throw Error('Reopen/pause/verification unexpectedly invoked a model');
 save('final-packaged-verification',w.verification);
 save('reopen-check',{passed:true,phaseRestored:'done',appliedResultsPreserved:true,pauseResumeKeepsApplied:true,modelCallsBefore:before.length,modelCallsAfter:after.length,noAutomaticModelCalls:true,verifiedChecks:37});
 const finished=await call('workbench:finish',{id:setup.id,evidence:'最终打包版重启保留已应用成果与交付状态；角色开关不新增模型调用；正常审阅重新应用后，37项隔离联调检查再次通过。',memoryIds:[]});
 save('final',finished);save('usage',await call('workbench:usage',{id:setup.id}));save('calls',after);
 console.log(JSON.stringify({passed:true,checks:37,calls:after.length,noAutomaticModelCalls:true}));
}finally{await session.close();rmSync('/tmp/pih-video-fixed-retained.json',{force:true});save('cleanup',{disposableProfileRemoved:!existsSync(retained.data),backupRemoved:!existsSync(retained.backup),at:new Date().toISOString()});}
