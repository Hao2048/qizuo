// Run ONLY in a disposable acceptance copy. No network or user files are accessed.
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=process.cwd(),results=[];
function check(id,passed,detail){results.push({id,passed,...(detail?{detail}: {})});console.log(JSON.stringify(results.at(-1)));}
const files=['brief/brief.json','script/script.json','storyboard/storyboard.json'];
const [brief,script,board]=files.map(p=>JSON.parse(readFileSync(p,'utf8')));
check('brief-brand-and-duration',brief.brand==='慢半拍'&&brief.duration===30&&Boolean(brief.cta&&brief.audience&&brief.promise));
check('script-duration',script.duration===30&&script.scenes.length===3);
check('storyboard-format',board.duration===30&&board.width===720&&board.height===1280&&board.fps===24&&board.scenes.length===3);
for(let i=0;i<3;i++){
 const s=script.scenes[i],b=board.scenes[i];
 check('timing-'+i,s.id==='s'+(i+1)&&s.start===i*10&&s.end===(i+1)*10&&b.id===s.id&&b.start===s.start&&b.end===s.end);
 check('wording-handoff-'+i,s.headline===b.headline&&s.caption===b.caption);
 check('text-length-'+i,[...s.headline].length<=12&&[...s.caption].length<=18);
 check('visual-design-'+i,/^#[a-f\d]{6}$/i.test(b.background)&&/^#[a-f\d]{6}$/i.test(b.accent)&&Boolean(b.visual&&b.motion));
}
check('final-cta',JSON.stringify(script.scenes[2]).includes(brief.cta));
check('private-canaries-absent',!files.some(p=>readFileSync(p,'utf8').includes('VIDEO_PRIVATE_')));
const render=spawnSync(process.execPath,['editor/render.mjs'],{encoding:'utf8',timeout:120000,maxBuffer:3000000});
check('renderer-exit',render.status===0,render.status===0?undefined:(render.stderr||render.stdout||String(render.error)).slice(-1200));
const video='delivery/final.mp4';check('mp4-exists',existsSync(video)&&readFileSync(video).length>5000);
if(existsSync(video)){
 const metadata=spawnSync('./tools/ffmpeg',['-hide_banner','-i',video,'-f','null','-'],{encoding:'utf8',timeout:120000,maxBuffer:3000000});
 check('video-decodes',metadata.status===0);
 check('duration-30',/Duration: 00:00:30\.0/.test(metadata.stderr));
 check('video-720x1280',/720x1280/.test(metadata.stderr));
 check('video-24fps',/24 fps/.test(metadata.stderr));
 check('video-h264-yuv420p',/Video: h264/.test(metadata.stderr)&&/yuv420p/.test(metadata.stderr));
 check('no-unrequested-audio',!/Stream #\d+:\d+.*Audio:/.test(metadata.stderr));
 const samples=[];for(const second of[2,7,12,17,22,27]){const f='delivery/frame-'+second+'.png';const r=spawnSync('./tools/ffmpeg',['-v','error','-y','-ss',String(second),'-i',video,'-frames:v','1',f],{encoding:'utf8',timeout:20000});check('frame-'+second,r.status===0&&existsSync(f));if(existsSync(f))samples.push(createHash('sha256').update(readFileSync(f)).digest('hex'));}
 check('three-distinct-scenes',new Set([samples[0],samples[2],samples[4]]).size===3);
 const manifest=JSON.parse(readFileSync('delivery/manifest.json','utf8'));check('manifest-output-format',manifest.duration===30&&manifest.width===720&&manifest.height===1280&&manifest.fps===24);
 for(const file of files){const hash=createHash('sha256').update(readFileSync(file)).digest('hex');check('manifest-input-'+file,JSON.stringify(manifest).includes(hash));}
 // A deliberately invalid upstream spec must fail, without accepting a stale render as new success.
 const original=readFileSync(files[0]);try{writeFileSync(files[0],JSON.stringify({...brief,duration:29}));const invalid=spawnSync(process.execPath,['editor/render.mjs'],{encoding:'utf8',timeout:15000,maxBuffer:1000000});check('invalid-spec-rejected',invalid.status!==0&&invalid.status!==null);}finally{writeFileSync(files[0],original);}
}
console.log(JSON.stringify({passed:results.filter(r=>r.passed).length,total:results.length}));if(results.some(r=>!r.passed))process.exitCode=1;
