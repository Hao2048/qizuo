import { createHash } from "node:crypto";
import { existsSync, mkdirSync, lstatSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HarnessDatabase } from "../db/database.js";

export class ToolOutputStore {
 private root:string;
 constructor(private db:HarnessDatabase,dataDir:string){this.root=join(dataDir,"tool-outputs");}
 private path(id:string):string {
  if(!/^[a-f0-9]{64}$/.test(id))throw new Error("输出编号无效");
  if(existsSync(this.root)&&lstatSync(this.root).isSymbolicLink())throw new Error("输出目录不能是符号链接");
  const path=join(this.root,`${id}.txt`);
  if(existsSync(path)&&!lstatSync(path).isFile())throw new Error("输出文件无效");
  return path;
 }
 save(taskId:string,text:string):string {
  const id=createHash("sha256").update(text).digest("hex"),path=this.path(id);
  mkdirSync(this.root,{recursive:true});
  if(!existsSync(path))writeFileSync(path,text,{encoding:"utf8",flag:"wx",mode:0o600});
  this.db.transaction(()=>{
   this.db.prepare("INSERT OR IGNORE INTO tool_outputs(id,size_chars,created_at) VALUES (?,?,?)").run(id,text.length,Date.now());
   this.db.prepare("INSERT OR IGNORE INTO task_tool_outputs(task_id,output_id) VALUES (?,?)").run(taskId,id);
  });
  return id;
 }
 read(taskId:string,id:string,offset=0,limit=12000){
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>20000)throw new Error("输出分页参数无效");
  if(!this.db.prepare("SELECT 1 FROM task_tool_outputs WHERE task_id=? AND output_id=?").get(taskId,id))throw new Error("输出不存在或不属于当前会话");
  const text=readFileSync(this.path(id),"utf8"),end=Math.min(text.length,offset+limit);
  return {text:text.slice(offset,end),offset,nextOffset:end<text.length ? end : null,totalChars:text.length};
 }
 inherit(sourceTaskId:string,targetTaskId:string,ids:string[]):void {
  for(const id of new Set(ids))this.db.prepare("INSERT OR IGNORE INTO task_tool_outputs(task_id,output_id) SELECT ?,output_id FROM task_tool_outputs WHERE task_id=? AND output_id=?").run(targetTaskId,sourceTaskId,id);
 }
 removeTask(taskId:string):void {
  const ids=this.db.prepare("SELECT output_id FROM task_tool_outputs WHERE task_id=?").all(taskId) as {output_id:string}[];
  this.db.prepare("DELETE FROM task_tool_outputs WHERE task_id=?").run(taskId);
  for(const {output_id:id} of ids){
   if(this.db.prepare("SELECT 1 FROM task_tool_outputs WHERE output_id=? LIMIT 1").get(id))continue;
   rmSync(this.path(id),{force:true});this.db.prepare("DELETE FROM tool_outputs WHERE id=?").run(id);
  }
 }
}
export const LONG_OUTPUT_CHARS=12000;
export function boundedOutput(text:string,id:string,maxChars=8000):string {
 const budget=Math.max(400,Number.isFinite(maxChars) ? Math.floor(maxChars) : 8000);
 if(text.length<=budget)return text;
 const notice=`\n\n[输出共 ${text.length} 字符，已省略中间内容。完整结果已保存，可用 read_tool_output({outputId:"${id}",offset:0,limit:12000}) 分页读取。偏移按字符计算。]\n\n`;
 const body=Math.max(0,budget-notice.length);
 const tail=Math.min(1200,Math.floor(body*.3)),head=Math.min(6000,body-tail);
 return `${text.slice(0,head)}${notice}${tail ? text.slice(-tail) : ""}`;
}
