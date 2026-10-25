import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {ArtifactPreview} from './artifact-preview.js';import {manifest} from './workspace.js';
const preview=new ArtifactPreview();let dir='';
afterEach(()=>{preview.close();if(dir)rmSync(dir,{recursive:true,force:true});});
function setup(){dir=mkdtempSync(join(tmpdir(),'pih-preview-'));mkdirSync(join(dir,'css'));writeFileSync(join(dir,'index.html'),'<link rel="stylesheet" href="/css/site.css"><script src="app.js"></script>测试');writeFileSync(join(dir,'app.js'),'fetch("data.json")');writeFileSync(join(dir,'css/site.css'),'body{color:blue}');writeFileSync(join(dir,'data.json'),'{"books":[]}');writeFileSync(join(dir,'.env'),'PRIVATE');writeFileSync(join(dir,'private.txt'),'NOT_WEB_ASSET');writeFileSync(join(dir,'run.exe'),'BINARY');}
async function authorize(url:string){const r=await fetch(url,{redirect:'manual'});expect(r.status).toBe(302);return r.headers.get('set-cookie')!.split(';')[0];}
it('serves an immutable authenticated static snapshot including relative and root assets, without exposing private files or accepting writes',async()=>{
 setup();const {url}=await preview.open('wb',dir,'index.html',manifest(dir)),origin=new URL(url).origin;
 expect((await fetch(origin+'/index.html')).status).toBe(403);const cookie=await authorize(url),headers={cookie};
 const page=await fetch(origin+'/index.html',{headers});expect(await page.text()).toContain('测试');expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
 for(const path of ['/css/site.css','/app.js','/data.json'])expect((await fetch(origin+path,{headers})).status).toBe(200);
 for(const path of ['/.env','/private.txt','/%2e%2e%2fsecret','/..%5csecret'])expect((await fetch(origin+path,{headers})).status).not.toBe(200);
 expect((await fetch(origin+'/index.html',{headers:{...headers,'Sec-Fetch-Site':'cross-site'}})).status).toBe(403);
 expect((await fetch(origin+'/index.html',{headers,method:'POST',body:'write'})).status).toBe(403);
 writeFileSync(join(dir,'data.json'),'CHANGED');expect(await(await fetch(origin+'/data.json',{headers})).text()).toBe('{"books":[]}');
 preview.close('other');expect((await fetch(origin+'/index.html',{headers})).status).toBe(200);preview.close('wb');await expect(fetch(origin+'/index.html',{headers})).rejects.toThrow();
});
it('rejects stale snapshots and non-html entry points and releases replaced previews',async()=>{
 setup();const files=manifest(dir);writeFileSync(join(dir,'data.json'),'changed');await expect(preview.open('wb',dir,'index.html',files)).rejects.toThrow('已变化');
 await expect(preview.open('wb',dir,'run.exe',manifest(dir))).rejects.toThrow('系统预览');
 const first=await preview.open('one',dir,'index.html',manifest(dir));await authorize(first.url);
 await preview.open('two',dir,'index.html',manifest(dir));await expect(fetch(first.url)).rejects.toThrow();
});
it('previews video, PDF, diagrams and source documents with correct MIME and media seeking',async()=>{
 setup();writeFileSync(join(dir,'clip.mp4'),Buffer.from('0123456789'));writeFileSync(join(dir,'report.pdf'),'%PDF-1.4');writeFileSync(join(dir,'chart.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');writeFileSync(join(dir,'report.md'),'# 交付文档\n<script>alert(1)</script>');
 for(const [path,mime] of [['clip.mp4','video/mp4'],['report.pdf','application/pdf'],['chart.svg','image/svg+xml'],['report.md','text/html']]){
  const {url}=await preview.open('wb',dir,path!,manifest(dir)),cookie=await authorize(url);const r=await fetch(new URL(url).origin+new URL(url).pathname,{headers:{cookie}});expect(r.status).toBe(200);expect(r.headers.get('content-type')).toContain(mime);
  if(path==='report.md'){const text=await r.text();expect(text).toContain('交付文档');expect(text).not.toContain('<script>alert(1)</script>');}
  if(path==='clip.mp4'){const base=new URL(url).origin+new URL(url).pathname;const range=await fetch(base,{headers:{cookie,range:'bytes=2-5'}});expect(range.status).toBe(206);expect(range.headers.get('content-range')).toBe('bytes 2-5/10');expect(await range.text()).toBe('2345');}
 }
});

it('resolves root-relative assets of a nested built website against its own output directory',async()=>{
 setup();mkdirSync(join(dir,'dist/assets'),{recursive:true});writeFileSync(join(dir,'dist/index.html'),'<link href="/assets/app.css">');writeFileSync(join(dir,'dist/assets/app.css'),'body{color:purple}');
 const {url}=await preview.open('wb',dir,'dist/index.html',manifest(dir,true)),cookie=await authorize(url);expect(await(await fetch(new URL(url).origin+'/assets/app.css',{headers:{cookie}})).text()).toBe('body{color:purple}');
});
