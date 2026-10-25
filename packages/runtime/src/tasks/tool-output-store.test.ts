import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessDatabase } from "../db/database.js";
import { ToolOutputStore, boundedOutput } from "./tool-output-store.js";
let db:HarnessDatabase,dir:string,store:ToolOutputStore;
beforeEach(()=>{
 dir=mkdtempSync(join(tmpdir(),"pih-output-"));db=HarnessDatabase.memory();store=new ToolOutputStore(db,dir);
 for(const id of ["parent","child","other"])db.prepare("INSERT INTO tasks(id,title,created_at,updated_at) VALUES (?,?,1,1)").run(id,id);
});
afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
it("pages saved output and rejects cross-session access and invalid offsets",()=>{
 const text="中".repeat(22000),id=store.save("parent",text);
 expect(store.read("parent",id,12000,12000)).toEqual({text:text.slice(12000),offset:12000,nextOffset:null,totalChars:22000});
 expect(()=>store.read("other",id)).toThrow(/不属于/);expect(()=>store.read("parent",id,-1)).toThrow();
 expect(boundedOutput(text,id).length).toBeLessThan(8000);
});
it("retains only selected inherited output until the last owner is deleted",()=>{
 const id=store.save("parent","saved"),unselected=store.save("parent","unselected");
 store.inherit("parent","child",[id,id]);store.removeTask("parent");
 expect(store.read("child",id).text).toBe("saved");expect(existsSync(join(dir,"tool-outputs",`${unselected}.txt`))).toBe(false);
 store.removeTask("child");expect(existsSync(join(dir,"tool-outputs",`${id}.txt`))).toBe(false);
 expect(db.prepare("SELECT * FROM tool_outputs").all()).toHaveLength(0);
});
it("refuses symbolic-link output roots",()=>{
 const external=mkdtempSync(join(tmpdir(),"pih-external-"));
 try{symlinkSync(external,join(dir,"tool-outputs"));expect(()=>store.save("parent","text")).toThrow(/符号链接/);}finally{rmSync(external,{recursive:true,force:true});}
});
