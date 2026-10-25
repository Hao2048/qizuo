import {resolve,basename} from "node:path";
import type {ApprovalRequest} from "@pi-harness/contracts";

/** Deterministic descriptions, never used as a permission or execution decision. */
export function explainToolApproval(name:string,value:unknown,cwd?:string):Pick<ApprovalRequest,"summary"|"effects"> {
 const input=(value && typeof value==="object" ? value : {}) as Record<string,unknown>;
 const path=(p:string)=>cwd ? resolve(cwd,p) : p;
 const result=(summary:string,...effects:string[])=>({summary,effects});
 if(["read","write","edit","ls","find","grep"].includes(name)){
  const target=typeof input.path==="string" ? path(input.path) : cwd ?? "当前工作目录";
  const summary=({read:"读取文件",write:"写入文件",edit:"修改文件内容",ls:"查看文件夹",find:"查找文件",grep:"搜索文件内容"} as Record<string,string>)[name]!;
  return result(summary,target,...(name==="write" ? ["如果文件已存在，将覆盖其内容。"] : []));
 }
 if(name==="save_time_memory"){
  const rule=input.rule as {kind?:string;at?:string;time?:string;timezone?:string;weekdays?:number[]}|undefined;
  const when=rule?.kind==="once"?String(rule.at??""):rule?.kind==="daily"?`每天 ${rule.time} · ${rule.timezone}`:`每周 ${(rule?.weekdays??[]).map(d=>["日","一","二","三","四","五","六"][d]).join("、")} ${rule?.time??""} · ${rule?.timezone??""}`;
  return result("创建角色定时任务",String(input.title??""),`时间：${when}`,`行动：${String(input.instructions??"").slice(0,500)}`,"绑定当前对话角色；应用运行时到点触发，错过不补跑，执行仍按权限询问。可在角色记忆页停用或移除。");
 }
 if(name==="list_time_memories")return result("查看角色的时间安排","只读取当前角色的定时任务与当前时间，不启动任务。");
 if(name==="workbench_submit_deliverable")return result("提交交付文件",typeof input.path==="string"?path(input.path):"本角色声明的交付路径","宿主校验后写入角色隔离副本；已存在的文件将被替换，不会直接应用到共享项目。");
 if(name==="workbench_delivery_contract")return result("读取本角色交付要求","只查看本角色已声明的文件、格式和检查条件。");
 if(name==="harness_subagent")return result("委派子任务",typeof input.task==="string" ? input.task.slice(0,400) : "独立分析任务",input.allowWrites ? "允许提出写操作；仍遵守当前审批规则。" : "只读分析，不修改文件。");
 if(name==="workbench_plugin")return result("使用远程插件",`服务器：${String(input.server??"")}`,`操作：${String(input.tool??"读取可用工具")}`,"提交的参数会发送给此服务，批准后执行；停止不能撤销已经完成的远程操作。");
 if(name==="workbench_command")return {...explainToolApproval("bash",input,cwd),effects:[...(explainToolApproval("bash",input,cwd).effects??[]),"在角色隔离副本中运行，仅可修改职责范围；网络按本角色授权限制。"]};
 if(name!=="bash")return result("执行工具操作",`工具：${name}`,"请查看详情确认参数和操作范围。");
 const command=typeof input.command==="string" ? input.command : "";
 // Shell evaluation, pipelines, loops and redirects can hide additional effects.
 // Only describe a small literal subset; never claim complex shell code is harmless.
 if(/[\n;&|<>`$(){}*?\[\]]/.test(command))return result("运行多步或动态命令","此命令可能读取、修改文件或调用其他程序，请展开详情核对具体操作。",...(cwd ? [`工作目录：${cwd}`] : []));
 const tokens:string[]=[];
 const pattern=/\s*(?:"([^"\\]*)"|'([^']*)'|([^\s"'\\]+))/gy;
 let end=0,match:RegExpExecArray|null;
 while((match=pattern.exec(command))){tokens.push(match[1] ?? match[2] ?? match[3]!);end=pattern.lastIndex;}
 if(command.slice(end).trim() || !tokens.length)return result("运行命令","无法可靠识别操作范围，请展开详情核对。",...(cwd ? [`工作目录：${cwd}`] : []));
 const executable=basename(tokens[0]!);const args=tokens.slice(1);
 // Unknown option meanings can change command behavior (e.g. find -delete, sed -i).
 const operands=args.filter(token=>!token.startsWith("-"));
 if(executable==="rm" && args.every(a=>!a.startsWith("-") || /^-[rfvi]+$|^--$|^--recursive$|^--force$/.test(a)) && operands.length)return result("删除文件或文件夹",...operands.map(path),"直接删除，不会移到废纸篓。" );
 if(["cp","mv"].includes(executable) && args.every(a=>!a.startsWith("-") || /^-[rRfivn]+$|^--$/.test(a)) && operands.length>=2)return result(executable==="cp" ? "复制文件或文件夹" : "移动或重命名文件",`来源：${operands.slice(0,-1).map(path).join("、")}`,`目标：${path(operands.at(-1)!)}`,"目标已存在时可能被覆盖。" );
 if(executable==="mkdir" && args.every(a=>!a.startsWith("-") || a==="-p" || a==="--") && operands.length)return result("创建文件夹",...operands.map(path));
 if(executable==="cat" && args.every(a=>!a.startsWith("-")) && operands.length)return result("读取文件",...operands.map(path));
 if(executable==="ls" && args.every(a=>!a.startsWith("-") || /^-[alhtr]+$/.test(a)))return result("查看文件夹",...(operands.length ? operands.map(path) : [cwd ?? "当前工作目录"]));
 if(executable==="open" && args.every(a=>!a.startsWith("-")) && operands.length)return result("使用系统应用打开",...operands.map(a=>/^https?:\/\//.test(a) ? a : path(a)));
 if(["python","python3","node"].includes(executable) && args[0] && !args[0].startsWith("-"))return result("运行脚本",path(args[0]),"脚本可能修改文件或访问网络，请查看详情确认。" );
 return result("运行程序",executable,"程序可能读取、修改文件或访问网络，请展开详情核对。",...(cwd ? [`工作目录：${cwd}`] : []));
}
