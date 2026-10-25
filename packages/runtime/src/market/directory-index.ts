import {statSync,readdirSync} from "node:fs";

/** Cache names only. Bodies, configuration, auth and visibility always stay live. */
export class DirectoryIndex {
 #entries=new Map<string,{stamp:string;names:string[]}>();
 list(path:string):string[]{
  let stamp:string;
  try {const s=statSync(path,{bigint:true});stamp=`${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}:${s.size}`;}
  catch {this.#entries.delete(path);return [];}
  const cached=this.#entries.get(path);if(cached?.stamp===stamp)return [...cached.names];
  try {
   const names=readdirSync(path,{withFileTypes:true}).filter(e=>!e.name.startsWith(".pih-install-")&&(e.isDirectory()||e.name.endsWith(".ts")||e.name.endsWith(".js"))).map(e=>e.name).sort();
   // If installation changed the directory while reading, do not cache this view.
   const s=statSync(path,{bigint:true});const after=`${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}:${s.size}`;
   if(after===stamp){if(this.#entries.size>=32)this.#entries.delete(this.#entries.keys().next().value!);this.#entries.set(path,{stamp,names});}
   else this.#entries.delete(path);
   return [...names];
  }catch{this.#entries.delete(path);return [];}
 }
}
