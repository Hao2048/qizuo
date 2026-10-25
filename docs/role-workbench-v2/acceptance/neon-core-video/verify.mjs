/** Independent acceptance: inspect actual output, never fabricate or repair role artifacts. */
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const results=[];function check(id,passed,detail){const r={id,passed,...(detail===undefined?{}:{detail})};results.push(r);console.log(JSON.stringify(r));}
const json=p=>JSON.parse(readFileSync(p,'utf8')),sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
try{
 const brief=json('brief/brief.json'),visual=json('design/visual.json'),score=json('audio/score.json');
 for(const [id,data] of [['brief',brief],['visual',visual]])check(id+'-format',data.duration===30&&data.width===1920&&data.height===1080&&data.fps===30);
 const ids=['awakening','orbit','overdrive','resolve'],bounds=[0,6,14,23,30];
 for(const [id,scenes] of [['brief',brief.acts],['visual',visual.scenes]])check(id+'-four-acts',scenes?.length===4&&scenes.every((s,i)=>s.id===ids[i]&&s.start===bounds[i]&&s.end===bounds[i+1]));
 check('title-handoff',visual.title===brief.title&&visual.subtitle===brief.subtitle);
 check('palette-defined',['background','cyan','magenta','gold'].every(k=>/^#[a-f0-9]{6}$/i.test(visual.palette[k])));
 check('numeric-motion',visual.scenes.every(s=>typeof s.energy==='number'&&s.energy>=0&&s.energy<=1&&s.cameraDistance?.length===2&&s.cameraDistance.every(v=>typeof v==='number'&&v>0)&&typeof s.orbitSpeed==='number'&&typeof s.particleSpeed==='number'&&Number.isInteger(s.ringCount)));
 check('audio-score',score.duration===30&&score.sampleRate===48000&&score.channels===2&&score.bpm===120&&JSON.stringify(score.markers)==='[0,6,14,23]');
 const inputs=['brief/brief.json','design/visual.json','audio/score.json','audio/soundtrack.wav'];
 check('no-private-canaries',!inputs.filter(p=>p.endsWith('.json')).some(p=>/NEON_PRIVATE_\d/.test(readFileSync(p,'utf8'))));
 const manifest=json('delivery/manifest.json');check('manifest-format',manifest.duration===30&&manifest.width===1920&&manifest.height===1080&&manifest.fps===30&&manifest.frameCount===900);
 for(const p of inputs)check('manifest-hash-'+p,JSON.stringify(manifest).includes(sha(p)));
 const video='delivery/neon-core-30s.mp4';check('real-mp4',existsSync(video)&&readFileSync(video).length>100000);
 const dec=spawnSync('./tools/ffmpeg',['-hide_banner','-i',video,'-f','null','-'],{encoding:'utf8',timeout:60000,maxBuffer:3000000});
 check('complete-decode',dec.status===0,dec.status===0?undefined:dec.stderr?.slice(-1000));
 check('duration-exact-30',/Duration: 00:00:30\.0/.test(dec.stderr));check('1080p',/1920x1080/.test(dec.stderr));check('30fps',/30 fps/.test(dec.stderr));check('h264-yuv420p',/Video: h264/.test(dec.stderr)&&/yuv420p/.test(dec.stderr));check('aac-stereo-48k',/Audio: aac.*48000 Hz, stereo/.test(dec.stderr));
 const frames=spawnSync('./tools/ffmpeg',['-v','error','-i',video,'-vf','fps=2,scale=160:90','-an','-f','rawvideo','-pix_fmt','rgb24','-'],{timeout:30000,maxBuffer:10000000});
 const step=160*90*3,n=Math.floor((frames.stdout?.length??0)/step);check('60-sampled-frames',frames.status===0&&n===60);
 const hashes=new Set();let visible=0,moving=0;for(let f=0;f<n;f++){const frame=frames.stdout.subarray(f*step,(f+1)*step);hashes.add(createHash('sha256').update(frame).digest('hex'));let sum=0,squares=0,diff=0;for(let i=0;i<step;i++){const v=frame[i];sum+=v;squares+=v*v;if(f)diff+=Math.abs(v-frames.stdout[(f-1)*step+i]);}const mean=sum/step,std=Math.sqrt(squares/step-mean*mean);if(mean>1&&std>4)visible++;if(f&&diff/step>0.15)moving++;}
 check('not-black-or-flat',visible>=50,{visible,total:n});check('continuous-motion',moving>=45,{moving,total:n-1});check('not-looped-stills',hashes.size>=55,{distinct:hashes.size});
 const wav=spawnSync('./tools/ffmpeg',['-v','error','-i','audio/soundtrack.wav','-f','f32le','-acodec','pcm_f32le','-'],{timeout:30000,maxBuffer:14000000});
 const buffer=wav.stdout;let peak=0,power=0,stereo=0,count=0;for(let i=0;i+7<(buffer?.length??0);i+=8){const l=buffer.readFloatLE(i),r=buffer.readFloatLE(i+4);peak=Math.max(peak,Math.abs(l),Math.abs(r));power+=l*l+r*r;stereo+=Math.abs(l-r);count++;}
 const rms=Math.sqrt(power/Math.max(1,count*2));check('wav-duration-30',wav.status===0&&count===30*48000);check('audio-not-silent',rms>0.015,{rms});check('audio-no-clipping',peak<0.999,{peak});check('genuine-stereo',stereo/Math.max(1,count)>0.0001);
 for(const sec of ['03','10','18','26'])check('preview-'+sec,existsSync('delivery/preview-'+sec+'.png'));
}catch(error){check('verifier-exception',false,String(error));}
console.log(JSON.stringify({passed:results.filter(x=>x.passed).length,total:results.length}));if(results.some(x=>!x.passed))process.exitCode=1;
