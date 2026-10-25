import { expect, it } from "vitest";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { contextPolicy, contextInputBreakdown, projectToolOutputs, projectToolImages, protectedContext } from "./context-policy.js";
import { buildSystemPrompt } from "../roles/prompts.js";
it("scales compaction reserves and recent context with the model window",()=>{
 for(const window of [4096,8192,32000,128000,1000000]){
  const policy=contextPolicy(window);expect(policy.reserveTokens+policy.keepRecentTokens).toBeLessThan(window);expect(policy.keepRecentTokens).toBeLessThanOrEqual(20000);expect(policy.thresholdTokens).toBe(window-policy.reserveTokens);
 }
 expect(contextPolicy(8192).reserveTokens).toBeLessThan(8192/3);expect(contextPolicy(NaN)).toEqual(contextPolicy(128000));
});
it("prioritizes recent tool results and retains errors, image blocks and the canonical source",()=>{
 const messages:ContextEvent["messages"]=Array.from({length:8},(_,i)=>({role:"toolResult" as const,toolCallId:`c${i}`,toolName:"read",isError:i===0,content:[{type:"text" as const,text:`OUTPUT${i}:`+"x".repeat(4000)},{type:"image" as const,data:"image",mimeType:"image/png"}],timestamp:i}));
 const saved:string[]=[];const result=projectToolOutputs(messages,8000,text=>{saved.push(text);return "a".repeat(64);});
 expect(result.trimmedOutputs).toBeGreaterThan(0);expect(result.toolCharsAfter).toBeLessThan(result.toolCharsBefore);
 expect(JSON.stringify(result.messages.at(-1))).toContain("x".repeat(3000));expect(JSON.stringify(result.messages[0])).not.toContain("x".repeat(3000));
 expect(result.messages[0]).toMatchObject({isError:true,content:expect.arrayContaining([{type:"image",data:"image",mimeType:"image/png"}])});
 expect(JSON.stringify(messages[0])).toContain("x".repeat(3000));expect(saved[0]).toContain("OUTPUT");
 const failed=projectToolOutputs(messages,1000,()=>{throw new Error("disk full");});expect(failed.messages).toEqual(messages);
});
it("keeps bounded pending state, output IDs and file clues without creating new authorization",()=>{
 const state=protectedContext([],"当前请求",[{status:"completed",content:"完成事项"},{status:"in_progress",content:"正在执行"},{status:"pending",content:"剩余事项"}],{read:new Set(["a.ts"]),written:new Set(["b.ts"]),edited:new Set()},10);
 expect(state.text).toContain("正在执行");expect(state.text).toContain("1 项完成");expect(state.text).toContain("b.ts");expect(state.text).toContain("不是新的执行授权");expect(state.text.length).toBeLessThan(10000);
});
it("stabilizes resource ordering without mutating source lists",()=>{
 const resources={packages:["b","a"],skills:["z","x"],extensions:["2","1"]};
 expect(buildSystemPrompt({resources})).toBe(buildSystemPrompt({resources:{packages:["a","b"],skills:["x","z"],extensions:["1","2"]}}));expect(resources.packages).toEqual(["b","a"]);
});

it("keeps only recent tool screenshots in requests, with recoverable branch references and untouched originals",()=>{
 const messages:ContextEvent["messages"]=Array.from({length:8},(_,i)=>({role:"toolResult" as const,toolCallId:`image-call-${i}`,toolName:"screenshot",isError:false,content:[{type:"image" as const,data:`image-${i}`,mimeType:"image/png"}],timestamp:i}));
 const result=projectToolImages(messages);
 expect(result.flatMap(m=>m.role==="toolResult" ? m.content.filter(c=>c.type==="image") : [])).toHaveLength(2);
 expect(JSON.stringify(result[0])).toContain('read_tool_image');expect(JSON.stringify(result[0])).toContain('image-call-0');
 expect(messages[0]).toMatchObject({content:[{type:"image",data:"image-0"}]});
 expect(projectToolImages([{role:"user",content:[{type:"image",data:"user-original",mimeType:"image/png"}],timestamp:1}])).toMatchObject([{content:[{type:"image",data:"user-original"}]}]);
});

it("keeps routine log context small even for large-window models and preserves both ends of failures",()=>{
 const messages:ContextEvent["messages"]=Array.from({length:12},(_,i)=>({role:"toolResult",toolCallId:`log-${i}`,toolName:"bash",isError:i===0,content:[{type:"text",text:`BEGIN-${i}\n`+"log entry\n".repeat(550)+`\nEND-${i}: important diagnostic`}],timestamp:i}));
 const result=projectToolOutputs(messages,contextPolicy(128000).toolPreviewChars,()=>"a".repeat(64));
 console.info("log projection chars",{before:result.toolCharsBefore,after:result.toolCharsAfter});
 expect(result.toolCharsAfter).toBeLessThan(22000);
 expect(JSON.stringify(result.messages[0])).toContain("END-0: important diagnostic");
 expect(JSON.stringify(messages[0])).toContain("log entry".repeat(1));
});
it("does not clip the latest explicitly requested output page",()=>{
 const text="PAGE-START"+"x".repeat(11990)+"PAGE-END\n[next offset:12000]";
 const message:ContextEvent["messages"][number]={role:"toolResult",toolCallId:"page",toolName:"read_tool_output",isError:false,content:[{type:"text",text}],timestamp:1};
 expect(projectToolOutputs([message],2000,()=>"a".repeat(64)).messages).toEqual([message]);
});

it("accounts for prompt, history, tool results and definitions without double-counting or persisting content",()=>{
 const messages:ContextEvent["messages"]=[{role:"system",content:"system prompt",toolsAdded:[{name:"read",description:"read files",parameters:{type:"object",properties:{}}}],timestamp:0},{role:"user",content:"private user request",timestamp:1},{role:"toolResult",toolName:"read",toolCallId:"a",content:[{type:"text",text:"private output"}],isError:false,timestamp:2}];
 const parts=contextInputBreakdown(messages,1);
 expect(parts.activeToolCount).toBe(1);expect(parts.toolDefinitionTokens).toBeGreaterThan(0);expect(parts.systemTokens).toBeGreaterThanOrEqual(parts.toolDefinitionTokens);
 expect(parts.historyTokens).toBe(5);expect(parts.toolResultTokens).toBe(4);expect(JSON.stringify(parts)).not.toContain("private");
});
it("compresses older recovered pages after a new model response while preserving current multi-page reads",()=>{
 const page=(id:string):ContextEvent["messages"][number]=>({role:"toolResult",toolName:"read_tool_output",toolCallId:id,isError:false,content:[{type:"text",text:"x".repeat(12000)}],timestamp:1});
 const assistant:any={role:"assistant",content:[],timestamp:2};
 const messages=[page("old"),assistant,page("current-1"),page("current-2")];
 const result=projectToolOutputs(messages,2000,()=>"a".repeat(64));
 expect(result.messages[0]).not.toEqual(messages[0]);expect(result.messages.slice(2)).toEqual(messages.slice(2));
});

it("does not include timestamps in prefix fingerprints and changes them when real instructions change",()=>{
 const a:any={role:"system",content:"stable prompt",toolsAdded:[],timestamp:1};
 expect(contextInputBreakdown([a],0).prefixHash).toBe(contextInputBreakdown([{...a,timestamp:999}],0).prefixHash);
 expect(contextInputBreakdown([a],0).prefixHash).not.toBe(contextInputBreakdown([{...a,content:"changed prompt"}],0).prefixHash);
});
