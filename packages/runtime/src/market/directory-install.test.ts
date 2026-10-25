import {beforeEach,afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {installDirectory,recoverDirectoryInstalls} from "./directory-install.js";
import {mapConcurrent} from "./concurrency.js";
let root:string,target:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"pih-install-test-"));target=join(root,"skill");mkdirSync(target);writeFileSync(join(target,"old.txt"),"old");});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
it("publishes a complete directory and removes obsolete files",async()=>{
 await installDirectory(target,async staging=>{writeFileSync(join(staging,"new.txt"),"new");expect(readFileSync(join(target,"old.txt"),"utf8")).toBe("old");});
 expect(readdirSync(target)).toEqual(["new.txt"]);expect(readdirSync(root)).toEqual(["skill"]);
});
it("preserves previous files when staging fails and leaves no partially installed new directory",async()=>{
 await expect(installDirectory(target,async staging=>{writeFileSync(join(staging,"partial.txt"),"partial");throw new Error("disk full");})).rejects.toThrow("disk full");
 expect(readdirSync(target)).toEqual(["old.txt"]);expect(readdirSync(root)).toEqual(["skill"]);
 const other=join(root,"new-skill");await expect(installDirectory(other,async()=>{throw new Error("network");})).rejects.toThrow();expect(existsSync(other)).toBe(false);
});
function interrupted(committed:boolean){const tx=join(root,".pih-install-crash");mkdirSync(tx);mkdirSync(join(tx,"old"));writeFileSync(join(tx,"old","old.txt"),"backup");rmSync(target,{recursive:true});mkdirSync(target);writeFileSync(join(target,"new.txt"),"new");writeFileSync(join(tx,"journal.json"),JSON.stringify({target:"skill",hadTarget:true,committed}));return tx;}
it("rolls back an interrupted replacement and preserves a committed one",()=>{
 interrupted(false);recoverDirectoryInstalls(root);expect(readFileSync(join(target,"old.txt"),"utf8")).toBe("backup");
 interrupted(true);recoverDirectoryInstalls(root);expect(readdirSync(target)).toEqual(["new.txt"]);expect(readdirSync(root)).toEqual(["skill"]);
});
it("refuses symlink targets and malicious recovery paths without touching unrelated data",async()=>{
 const link=join(root,"link");symlinkSync(target,link);await expect(installDirectory(link,async()=>{})).rejects.toThrow("普通目录");
 const broken=join(root,"broken");symlinkSync(join(root,"missing"),broken);await expect(installDirectory(broken,async()=>{})).rejects.toThrow("普通目录");
 const tx=join(root,".pih-install-bad");mkdirSync(tx);writeFileSync(join(tx,"journal.json"),JSON.stringify({target:"../other",hadTarget:false,committed:false}));expect(()=>recoverDirectoryInstalls(root)).toThrow("格式无效");expect(existsSync(join(target,"old.txt"))).toBe(true);
});
it("rejects competing writes to the same target and ignores active staging during recovery",async()=>{
 let release!:()=>void;const waiting=new Promise<void>(r=>release=r);
 const running=installDirectory(target,async staging=>{writeFileSync(join(staging,"new.txt"),"new");await waiting;});
 recoverDirectoryInstalls(root);await expect(installDirectory(target,async()=>{})).rejects.toThrow("正在安装");release();await running;expect(existsSync(join(target,"new.txt"))).toBe(true);
});
it("drains pending download workers before returning an error",async()=>{
 let ended=false;await expect(mapConcurrent([0,1],2,async i=>{if(!i)throw new Error("failed");await new Promise(r=>setTimeout(r,20));ended=true;return i;})).rejects.toThrow("failed");expect(ended).toBe(true);
});
