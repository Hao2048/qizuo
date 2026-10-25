import {createHash, randomBytes} from 'node:crypto';
import {createServer, type Server} from 'node:http';
import {readFileSync} from 'node:fs';
import {extname,basename,posix} from 'node:path';
import {safePath, type Manifest} from './workspace.js';

const types:Record<string,string>={'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.m4v':'video/mp4','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.ogg':'audio/ogg','.pdf':'application/pdf'};
const textTypes=/\.(md|markdown|txt|csv|tsv|json|jsonl|ya?ml|xml|log|py|[cm]?jsx?|tsx?|css|scss|sql|sh|bash|go|rs|java|c|h|cpp|vue|svelte|toml|ini)$/i;
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
/** One immutable, browser-only snapshot. Non-web documents expose only the selected file. */
export class ArtifactPreview {
 private generation=0;
 private active?:{owner:string;server:Server};
 close(owner?:string){if(owner&&owner!==this.active?.owner)return;this.generation++;if(!this.active)return;this.active.server.closeAllConnections();this.active.server.close();this.active=undefined;}
 async open(owner:string,root:string,entry:string,files:Manifest,download=false){
  const web=/\.html?$/i.test(entry),text=textTypes.test(entry),mime=types[extname(entry).toLowerCase()];
  if(!files[entry]||(!mime&&!text&&!download))throw Error('此文件请使用系统预览或下载原文件查看');
  const snapshot=new Map<string,Buffer>();
  for(const [path,hash] of Object.entries(files)){
   if(path.split('/').some(part=>part.startsWith('.'))||(!web&&path!==entry)||(web&&!types[extname(path).toLowerCase()]))continue;
   const bytes=readFileSync(safePath(root,path));
   if(createHash('sha256').update(bytes).digest('hex')!==hash)throw Error('成果文件已变化，请重新查看文件变化');
   snapshot.set(path,bytes);
  }
  if(!snapshot.has(entry))throw Error('此成果路径不可预览');
  if(text&&!download){const bytes=snapshot.get(entry)!;if(bytes.includes(0)||!Buffer.from(bytes.toString('utf8')).equals(bytes))throw Error('此文件不是 UTF-8 文本，请下载原文件查看');}
  this.close();const generation=this.generation;
  const token=randomBytes(32).toString('hex'),cookie='pih_preview_'+token.slice(0,12);
  const server=createServer((req,res)=>{
   const host='127.0.0.1:'+((server.address() as {port:number})?.port);
   const reject=(code:number)=>{res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end('预览不可用，请从角色成果重新打开。');};
   if(req.headers.host!==host||!['GET','HEAD'].includes(req.method??'')||
    (req.headers['sec-fetch-site']&&!['none','same-origin'].includes(String(req.headers['sec-fetch-site']))))return reject(403);
   try{
    const url=new URL(req.url??'/',`http://${host}`);
    if(url.searchParams.get('preview')===token){
     url.searchParams.delete('preview');res.writeHead(302,{'Location':url.pathname+url.search,'Set-Cookie':`${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/`,'Referrer-Policy':'no-referrer','Cache-Control':'no-store'});res.end();return;
    }
    if(!req.headers.cookie?.split(';').some(c=>c.trim()===`${cookie}=${token}`))return reject(403);
    const path=decodeURIComponent(url.pathname).slice(1)||'index.html';
    if(path.split('/').some(p=>p==='..'||p==='.'||p.startsWith('.'))||path.includes('\\'))return reject(403);
    const base=posix.dirname(entry),scoped=web&&base!=='.'&&!path.startsWith(base+'/')?base+'/'+path:path;
    let content=snapshot.get(scoped)??snapshot.get(path),type=types[extname(path).toLowerCase()]??'application/octet-stream';
    if(!content)return reject(404);
    if(path===entry&&text&&!download){type='text/html; charset=utf-8';content=Buffer.from(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(basename(entry))}</title><style>body{margin:32px;font:15px/1.7 system-ui;color:#222;background:#fafafa}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.7 ui-monospace,monospace}h1{font-size:20px}</style><h1>${escape(basename(entry))}</h1><pre>${escape(content.toString('utf8'))}</pre>`);}
    const headers:Record<string,string|number>={'Content-Type':type,'Content-Length':content.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','Content-Security-Policy':"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'self'"};
    if(download)headers['Content-Disposition']=`attachment; filename*=UTF-8''${encodeURIComponent(basename(entry))}`;
    // Browsers seek videos and PDF pages using byte-range requests.
    headers['Accept-Ranges']='bytes';let status=200;
    if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);const size=content.length;let start=0,end=size-1;
     if(match){if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end);}else if(match[2])start=Math.max(0,size-Number(match[2]));}
     if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`,'Cache-Control':'no-store'});res.end();return;}
     status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;content=content.subarray(start,end+1);headers['Content-Length']=content.length;
    }
    res.writeHead(status,headers);res.end(req.method==='HEAD'?undefined:content);
   }catch{return reject(400);}
  });
  await new Promise<void>((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>{server.off('error',no);ok();});});
  if(this.generation!==generation){server.closeAllConnections();server.close();throw Error('预览已关闭或被替换，请重新打开');}
  this.active={owner,server};
  return {url:`http://127.0.0.1:${(server.address() as {port:number}).port}/${entry.split('/').map(encodeURIComponent).join('/')}?preview=${token}`};
 }
}
