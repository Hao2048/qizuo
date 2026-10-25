import { act,cleanup,fireEvent,render,screen,within } from "@testing-library/react";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import type { TranscriptMessage } from "@pi-harness/contracts";
import TranscriptView from "./components/TranscriptView.js";
import { conversationTurns,turnAnchor } from "./components/conversation.js";
import { useStore } from "./store.js";
const markdownRenders=vi.hoisted(()=>({texts:[] as string[]}));
vi.mock("./components/Markdown.js",async importOriginal=>{
 const actual=await importOriginal<typeof import("./components/Markdown.js")>();
 return {...actual,Markdownish:(props:{text:string})=>{markdownRenders.texts.push(props.text);return <actual.Markdownish {...props}/>;}};
});
let observer:FakeIntersection;
class FakeIntersection {
 readonly targets=new Set<Element>();
 disconnect=vi.fn(()=>this.targets.clear());
 constructor(private callback:IntersectionObserverCallback,readonly options:IntersectionObserverInit){observer=this;}
 observe(target:Element){this.targets.add(target);}
 unobserve(target:Element){this.targets.delete(target);}
 show(target:Element,visible:boolean){this.callback([{target,isIntersecting:visible} as IntersectionObserverEntry],this as unknown as IntersectionObserver);}
}
function history(count:number):TranscriptMessage[]{return Array.from({length:count},(_,i)=>[{id:`u${i}`,role:"user" as const,text:`问题 ${i}`},{id:`a${i}`,role:"assistant" as const,text:`## 回答 ${i}\n\n详细内容。`}]).flat();}
beforeEach(()=>{
 markdownRenders.texts=[];
 vi.stubGlobal("IntersectionObserver",FakeIntersection);
 Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:vi.fn()});
 useStore.getState().resetConversation();useStore.setState({currentTaskId:"long",taskStatus:"done"});
 window.pih={invoke:vi.fn(async()=>({ok:true,result:{prompts:[]}})),onEvent:()=>()=>{},platform:"darwin",versions:{electron:"",chrome:""}};
});
afterEach(()=>{cleanup();useStore.getState().resetConversation();vi.unstubAllGlobals();vi.restoreAllMocks();delete window.pih;});
it("mounts only recent bodies in 500 turns while every navigation anchor remains available",()=>{
 useStore.setState({transcript:history(500)});const view=render(<TranscriptView/>);
 expect(view.container.querySelectorAll(".conversation-turn")).toHaveLength(500);
 expect(view.container.querySelectorAll(".turn-body")).toHaveLength(6);
 expect(view.container.querySelectorAll(".turn-placeholder")).toHaveLength(494);
 expect(observer.options.rootMargin).toBe("800px 0px");
 expect(screen.queryByRole("heading",{name:"回答 0"})).toBeNull();
 const nav=screen.getByRole("navigation",{name:"对话轮次导航"});
 fireEvent.click(within(nav).getByRole("button",{name:/跳转到第 1 轮：/}));
 expect(screen.getByRole("heading",{name:"回答 0"})).toBeTruthy();
 expect(view.container.querySelectorAll(".turn-body")).toHaveLength(7);
});
it("preserves disclosure state when a history body leaves and re-enters the viewport",()=>{
 const messages=history(12);messages[1]={...messages[1]!,thinking:"历史思考",toolCalls:[{id:"read0",name:"read",args:{path:"doc.md"}}]};messages.splice(2,0,{id:"r0",role:"toolResult",toolCallId:"read0",toolName:"read",text:"历史工具结果"});
 useStore.setState({transcript:messages});render(<TranscriptView/>);
 const turn=document.getElementById(turnAnchor("u0"))!;
 act(()=>observer.show(turn,true));fireEvent.click(within(turn).getByRole("button",{name:/已完成/}));fireEvent.click(screen.getByRole("button",{name:/read.*完成/}));
 expect(screen.getByText("历史工具结果")).toBeTruthy();expect(screen.getByText("历史思考")).toBeTruthy();
 // Simulate focus moving out before scrolling away.
 (document.activeElement as HTMLElement)?.blur();act(()=>observer.show(turn,false));
 expect(screen.queryByText("历史工具结果")).toBeNull();
 act(()=>observer.show(turn,true));expect(screen.getByText("历史工具结果")).toBeTruthy();expect(screen.getByText("历史思考")).toBeTruthy();
});
it("reuses complete turns but updates the original owner of a late tool result",()=>{
 const messages=history(100);messages[1]={...messages[1]!,toolCalls:[{id:"old-call",name:"read",args:{path:"old"}}]};
 const first=conversationTurns(messages,[]);
 const appended=conversationTurns([...messages,{id:"late",role:"toolResult",toolCallId:"old-call",toolName:"read",text:"late result"}],[],first);
 expect(appended[0]).not.toBe(first[0]);expect(appended[0]!.messages.at(-1)!.text).toBe("late result");
 for(let i=1;i<100;i++)expect(appended[i]).toBe(first[i]);
});
it("keeps historical nodes stable through streaming and disconnects observers on leave",()=>{
 useStore.setState({transcript:history(50),taskStatus:"running"});const view=render(<TranscriptView/>);
 const old=screen.getByRole("heading",{name:"回答 44"});
 act(()=>{for(let i=0;i<200;i++)useStore.getState().appendStreamText("新内容");});
 expect(screen.getByRole("heading",{name:"回答 44"})).toBe(old);
 expect(markdownRenders.texts.filter(text=>text.includes("## 回答 44\n"))).toHaveLength(1);
 expect(view.container.querySelectorAll(".turn-body")).toHaveLength(6);
 const currentObserver=observer;
 act(()=>{useStore.getState().resetConversation();useStore.getState().selectTask("empty");});
 expect(currentObserver.disconnect).toHaveBeenCalled();expect(screen.queryByRole("navigation")).toBeNull();
 view.unmount();expect(observer.disconnect).toHaveBeenCalled();
});
it("keeps an offscreen focused control until focus leaves, then releases its body",async()=>{
 const messages=history(12);messages[1]={...messages[1]!,thinking:"键盘查看思考"};
 useStore.setState({transcript:messages});render(<TranscriptView/>);const turn=document.getElementById(turnAnchor("u0"))!;
 act(()=>observer.show(turn,true));const thinking=within(turn).getByRole("button",{name:/已完成/});
 act(()=>thinking.focus());act(()=>observer.show(turn,false));expect(turn.querySelector(".turn-body")).toBeTruthy();
 const nav=screen.getByRole("navigation",{name:"对话轮次导航"});
 await act(async()=>within(nav).getByRole("button",{name:"展开对话导航"}).focus());
 expect(turn.querySelector(".turn-body")).toBeNull();
});
