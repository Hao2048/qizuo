import {expect,it} from "vitest";
import {getCurrentSystemMessage,fauxAssistantMessage,fauxToolCall} from "@earendil-works/pi-ai";
import {contextInputBreakdown,projectRequestContext,projectReasoning,softCompactionThreshold} from "./context-policy.js";
const model:any={id:"glm-5.3",provider:"zai-coding-cn",api:"openai-completions"};
const assistant=(content:any[],overrides:any={})=>({...fauxAssistantMessage(content),model:model.id,provider:model.provider,api:model.api,...overrides});
it("keeps the serialized leading instruction identical when turn state changes",()=>{
 const system:any={role:"system",content:"fixed",sections:{rules:"stable",harness_current_request:"legacy dynamic request"},timestamp:0};
 const input:any=[system,{role:"user",content:"first",timestamp:1}];
 const a=projectRequestContext(input,["plan A"]),b=projectRequestContext([...input,{role:"user",content:"second",timestamp:2}],["plan B"]);
 expect(getCurrentSystemMessage(a)).toEqual(getCurrentSystemMessage(b));expect(JSON.stringify(a)).not.toContain("legacy dynamic");expect(JSON.stringify(a)).toContain("plan A");expect(JSON.stringify(input)).not.toContain("plan A");
});
it("detects changes in collapsed instructions and tool declarations after the first system item",()=>{
 const first:any={role:"system",content:"fixed",timestamp:0};
 expect(contextInputBreakdown([first,{role:"system",content:"A",timestamp:1}],0).prefixHash).not.toBe(contextInputBreakdown([first,{role:"system",content:"B",timestamp:2}],0).prefixHash);
});
it("preserves exact same-model reasoning required by tool providers",()=>{
 const block={type:"thinking",thinking:"original reasoning",thinkingSignature:"reasoning_content"};const messages:any=[assistant([block,fauxToolCall("read",{path:"a"})],{stopReason:"toolUse"}),{role:"toolResult",toolCallId:"a",toolName:"read",content:[],isError:false,timestamp:1},assistant([block,{type:"text",text:"done"}]),{role:"user",content:"next",timestamp:2}];
 expect(projectReasoning(messages,model)).toEqual(messages);
});
it("omits foreign plaintext thinking without dropping conclusions, tool calls or opaque state",()=>{
 const plain={type:"thinking",thinking:"foreign thoughts",thinkingSignature:"reasoning_content"};const opaque={type:"thinking",thinking:"",thinkingSignature:"encrypted-state",redacted:true};
 const messages:any=[assistant([plain,opaque,{type:"text",text:"verified conclusion"},fauxToolCall("read",{path:"a"})],{provider:"deepseek",model:"deepseek-flash"})];
 const projected=projectReasoning(messages,model);expect(JSON.stringify(projected)).not.toContain("foreign thoughts");expect(JSON.stringify(projected)).toContain("verified conclusion");expect(JSON.stringify(projected)).toContain("encrypted-state");expect(JSON.stringify(projected)).toContain('"read"');expect(messages[0].content).toContain(plain);
});
it("never downgrades foreign signed plaintext into ordinary assistant text",()=>{
 const message:any=assistant([{type:"thinking",thinking:"signed reasoning",thinkingSignature:"opaque-signature"}],{provider:"other"});expect(projectReasoning([message],model)[0]).toMatchObject({content:[]});expect(message.content[0].thinking).toBe("signed reasoning");
});
it("uses model capacity rather than a fixed token budget, retaining the small-window reserve",()=>{
 expect(softCompactionThreshold(1000000)).toBe(850000);expect(softCompactionThreshold(8192)).toBeLessThan(8192);expect(softCompactionThreshold(8192)).toBeGreaterThan(6000);
});
