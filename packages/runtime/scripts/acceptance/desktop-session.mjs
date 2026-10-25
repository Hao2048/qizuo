/** Local acceptance only: packaged production IPC, encrypted auth copy, no formal project/profile copy. */
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,copyFileSync,chmodSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
export const pause=ms=>new Promise(r=>setTimeout(r,ms));
export async function desktopSession({dataDir,copyAuth=true,enableFaux=false,development=false}={}) {
 const data=dataDir??mkdtempSync(join(tmpdir(),'pih-acceptance-'));mkdirSync(data,{recursive:true});chmodSync(data,0o700);mkdirSync(join(data,'pi'),{recursive:true});
 if(copyAuth){const source=join(homedir(),'Library/Application Support/@pi-harness/desktop/data/pi/auth.json');if(JSON.parse(readFileSync(source,'utf8')).pihEnc!=='v1')throw Error('Only encrypted credentials may be copied');copyFileSync(source,join(data,'pi/auth.json'));chmodSync(join(data,'pi/auth.json'),0o600);}
 const desktop=resolve('apps/desktop'),app=development?desktop:resolve('apps/desktop/release/latest/mac-arm64/栖作.app');let child,ws,server,sequence=0;const pending=new Map();
 async function close({remove=true}={}) {server?.closeAllConnections();server?.close();ws?.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Acceptance closed'));}pending.clear();if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),pause(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}if(remove)rmSync(data,{recursive:true,force:true});}
 try{
 rmSync(join(data,'DevToolsActivePort'),{force:true});
 child=spawn(development?createRequire(join(desktop,'package.json'))('electron'):join(app,'Contents/MacOS/栖作'),[...(development?[desktop]:[]),'--remote-debugging-port=0'],{cwd:desktop,env:{...process.env,PIH_DATA_DIR:data,PIH_ENABLE_FAUX:enableFaux?'1':'0'},stdio:'ignore'});
 let port;for(let i=0;i<300;i++){try{port=Number(readFileSync(join(data,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break;}catch{}await pause(100);}if(!port)throw Error('Packaged app startup timeout');
 let target;for(let i=0;i<300;i++){target=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t=>t.type==='page');if(target)break;await pause(100);}if(!target)throw Error('Packaged IPC not ready');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',no,{once:true});});
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error||m.result.exceptionDetails?p.reject(Error(m.result?.exceptionDetails?.exception?.description??'IPC failure')):p.resolve(m.result.result.value);}});
 ws.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Acceptance renderer disconnected'));}pending.clear();});
 function run(expression){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Acceptance IPC timeout'));},120000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});}
 for(let i=0;i<300&&!(await run('Boolean(window.pih)'));i++)await pause(100);
 const invoke=(name,input={})=>run(`(async()=>{const r=await window.pih.invoke(${JSON.stringify(name)},${JSON.stringify(input)});if(!r.ok)throw Error(r.error.message);return r.result;})()`);
 return {data,app,invoke,close,evaluate:run,pid:child.pid,
 async quit(){const owned=child;let timer;try{const exited=new Promise((ok,no)=>{owned.once('exit',code=>code===0?ok():no(Error('Test app quit failed: '+code)));timer=setTimeout(()=>no(Error('Graceful test app quit timed out')),12000);});void run('window.close();true').catch(()=>{});await exited;child=undefined;await close({remove:false});}finally{clearTimeout(timer);}},
 async crash(){if(child){const owned=child;const exited=new Promise(r=>owned.once('exit',r));owned.kill('SIGKILL');await Promise.race([exited,pause(5000)]);if(owned.exitCode===null&&!owned.signalCode)throw Error('Test app did not exit');child=undefined;}await close({remove:false});},
 async bridge(file){const token=randomBytes(32).toString('hex');server=createServer(async(req,res)=>{if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(403);res.end();return;}try{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2000000)throw Error('Request too large');}const {name,input}=JSON.parse(raw);const result=await invoke(name,input);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result}));}catch(error){res.end(JSON.stringify({ok:false,error:String(error).replace(/sk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]')}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));writeFileSync(file,JSON.stringify({port:server.address().port,token,data,pid:process.pid}),{mode:0o600});}};
 }catch(error){await close();throw error;}
}
