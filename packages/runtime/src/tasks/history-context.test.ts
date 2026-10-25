import { expect, it } from "vitest";
import { isHistoryReview, referenceContext, referenceSnapshot } from "./history-context.js";
import { toTranscript } from "../pi/agent-events.js";
it("recognizes explicit history questions while preserving new action requests",()=>{
 for(const text of ["之前做了什么？","总结之前的进展","刚才执行了哪些命令"])expect(isHistoryReview(text)).toBe(true);
 for(const text of ["继续修复","总结之前做了什么，然后继续修复","帮我修改之前的代码","执行测试","之前做了什么，修复一下登录问题"])expect(isHistoryReview(text)).toBe(false);
});
it("captures bounded text without tool calls or private thinking",()=>{
 const ref=referenceSnapshot("ref","source","标题",[
  {id:"u",role:"user",text:"安装插件"},{id:"tool",role:"toolResult",text:"secret"},
  {id:"phase",role:"assistant",kind:"phase",text:"执行中"},
  {id:"a",role:"assistant",text:"安装完成",thinking:"private",toolCalls:[{id:"c",name:"bash"}]}
 ],100);
 expect(ref.text).toBe("用户：安装插件\n\n助手：安装完成");
 expect(referenceContext([ref])).toContain("不属于当前请求");
 expect(ref.text).not.toContain("secret");
 const long=referenceSnapshot("r","s","t",[{id:"1",role:"user",text:"old"},{id:"2",role:"assistant",text:"x".repeat(10000)}]);
 expect(long.text.length).toBeLessThanOrEqual(8000);expect(long.truncated).toBe(true);expect(long.omittedMessages).toBe(1);
});
it("preserves reference provenance on the following user message only",()=>{
 const ref=referenceSnapshot("r","s","title",[],100);
 const transcript=toTranscript([{role:"custom",customType:"harness_session_references",details:{references:[ref]}},{role:"user",content:"本轮"},{role:"assistant",content:[]},{role:"user",content:"下一轮"}]);
 expect(transcript).toHaveLength(3);expect(transcript[0]?.references).toEqual([ref]);expect(transcript[2]?.references).toBeUndefined();
});
