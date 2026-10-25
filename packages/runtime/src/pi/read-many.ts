import {Type} from "typebox";
import type {ToolDefinition} from "@earendil-works/pi-coding-agent";

/** Combine independent reads in one model round; SDK nested calls keep read approvals and cancellation. */
export function readManyTool():ToolDefinition {
 return {name:"read_many",label:"读取多个文件",description:"一次读取已明确的多个独立文件片段，减少模型往返。每个文件独立经过原 read 工具权限；默认从第 1 行读取 100 行，不替代依赖前一结果的查询。",parameters:Type.Object({files:Type.Array(Type.Object({path:Type.String(),offset:Type.Optional(Type.Integer({minimum:1})),limit:Type.Optional(Type.Integer({minimum:1,maximum:400}))}),{minItems:2,maxItems:8})}),execute:async(_id,params,signal,_update,ctx)=>{
  const files=(params as {files:Array<{path:string;offset?:number;limit?:number}>}).files;
  const results=await Promise.all(files.map(async file=>{signal?.throwIfAborted();return ctx.executeTool("read",{...file,limit:file.limit ?? 100},{signal});}));
  return {content:results.flatMap((outcome,i)=>[{type:"text" as const,text:`文件 ${JSON.stringify(files[i]!.path)}${outcome.isError ? "（读取失败）" : ""}:`},...outcome.result.content]),isError:results.some(result=>result.isError),details:{files:files.map((file,i)=>({path:file.path,isError:results[i]!.isError}))}};
 }} as ToolDefinition;
}
