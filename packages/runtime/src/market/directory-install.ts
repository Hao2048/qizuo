import {existsSync,lstatSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {basename,join,resolve} from "node:path";
import {sealInstall} from "./install-operations.js";

const PREFIX=".pih-install-";
const active=new Set<string>();
const targets=new Set<string>();
type Journal={target:string;hadTarget:boolean;committed:boolean};
function checkDirectory(path:string):void {
 let stat:ReturnType<typeof lstatSync>;
 try{stat=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
 if(!stat.isDirectory() || stat.isSymbolicLink())throw new Error("安装目录必须是普通目录。");
}
function save(dir:string,journal:Journal):void {
 const path=join(dir,"journal.json");writeFileSync(`${path}.tmp`,JSON.stringify(journal));renameSync(`${path}.tmp`,path);
}
function recover(dir:string,parent:string):void {
 checkDirectory(dir);
 const file=join(dir,"journal.json");
 if(!existsSync(file)){rmSync(dir,{recursive:true,force:true});return;}
 if(lstatSync(file).isSymbolicLink())throw new Error("安装记录不能是符号链接。");
 const j=JSON.parse(readFileSync(file,"utf8")) as Journal;
 if(!/^[A-Za-z0-9_-]+$/.test(j.target) || typeof j.hadTarget!=="boolean" || typeof j.committed!=="boolean")throw new Error("安装记录格式无效，已保留现场。");
 const target=join(parent,j.target),old=join(dir,"old"),next=join(dir,"new");
 checkDirectory(target);checkDirectory(old);checkDirectory(next);
 if(j.committed && existsSync(target)){rmSync(dir,{recursive:true,force:true});return;}
 if(existsSync(old)){rmSync(target,{recursive:true,force:true});renameSync(old,target);}
 else if(!j.hadTarget && !existsSync(next)){rmSync(target,{recursive:true,force:true});}
 else if(j.hadTarget && !existsSync(target))throw new Error("原安装目录缺失，已保留恢复记录。");
 rmSync(dir,{recursive:true,force:true});
}
/** Roll back unpublished replacements after an interrupted installation. */
export function recoverDirectoryInstalls(parent:string):void {
 if(!existsSync(parent))return;
 checkDirectory(parent);
 for(const entry of readdirSync(parent,{withFileTypes:true}))if(entry.name.startsWith(PREFIX) && !active.has(join(parent,entry.name)))recover(join(parent,entry.name),parent);
}
/** Build off to the side; publish a whole directory or preserve the previous one. */
export async function installDirectory<T>(target:string,build:(staging:string)=>Promise<T>,signal?:AbortSignal):Promise<T> {
 signal?.throwIfAborted();
 const key=resolve(target);
 if(targets.has(key))throw new Error("该目录正在安装，请稍后重试。");
 const name=basename(target),parent=join(target,"..");
 if(!/^[A-Za-z0-9_-]+$/.test(name))throw new Error("非法安装目录名称。");
 checkDirectory(parent);mkdirSync(parent,{recursive:true});recoverDirectoryInstalls(parent);checkDirectory(target);
 const dir=mkdtempSync(join(parent,PREFIX));active.add(dir);targets.add(key);
 const next=join(dir,"new"),old=join(dir,"old");
 const j:Journal={target:name,hadTarget:existsSync(target),committed:false};
 try {
  mkdirSync(next);
  const result=await build(next);
  sealInstall(signal);
  save(dir,j);
  if(j.hadTarget)renameSync(target,old);
  renameSync(next,target);j.committed=true;save(dir,j);
  try{rmSync(dir,{recursive:true,force:true});}catch{/* Committed journal is cleaned on the next startup. */}return result;
 }catch(error){try{recover(dir,parent);}catch{throw new Error("安装失败且自动恢复未完成，已保留目录和恢复记录，请重启后重试。");}throw error;}
 finally{active.delete(dir);targets.delete(key);}
}
