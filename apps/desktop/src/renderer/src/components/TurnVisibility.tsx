import { memo, useEffect, useRef, useState } from "react";
import { turnAnchor, type ConversationTurn } from "./conversation.js";

/** One pair of observers for the conversation; only nearby message bodies are mounted. */
export class TurnVisibility {
 readonly disclosures=new Map<string,boolean>();
 readonly supported=typeof IntersectionObserver!=="undefined";
 #entries=new Map<HTMLElement,(visible:boolean)=>void>();
 #intersection:IntersectionObserver|null=null;
 #resize:ResizeObserver|null=null;
 #near=new Map<HTMLElement,boolean>();
 #root:HTMLElement|null=null;
 #focusOut=()=>queueMicrotask(()=>{for(const [element,near] of this.#near){if(!near)this.#entries.get(element)?.(element.contains(document.activeElement));}});
 connect(root:HTMLElement):void {
  if(!this.supported)return;
  this.#root=root;root.addEventListener("focusout",this.#focusOut);
  this.#intersection=new IntersectionObserver(entries=>{
   for(const entry of entries){
    const element=entry.target as HTMLElement;
    this.#near.set(element,entry.isIntersecting);
    // Keep the focused control mounted while navigating with a keyboard.
    this.#entries.get(element)?.(entry.isIntersecting || element.contains(document.activeElement));
   }
  },{root,rootMargin:"800px 0px"});
  this.#resize=typeof ResizeObserver!=="undefined" ? new ResizeObserver(entries=>{
   for(const entry of entries){
    const body=entry.target as HTMLElement;
    const shell=body.parentElement;
    if(shell && body.getBoundingClientRect().height>0)shell.style.minHeight=`${this.#height(body,shell)}px`;
   }
  }) : null;
  for(const element of this.#entries.keys()){this.#intersection.observe(element);const body=element.querySelector<HTMLElement>(".turn-body");if(body)this.#resize?.observe(body);}
 }
 #height(body:HTMLElement,shell:HTMLElement):number {const style=getComputedStyle(shell);return body.getBoundingClientRect().height+(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0);}
 register(element:HTMLElement,show:(visible:boolean)=>void):()=>void {
  this.#entries.set(element,show);this.#intersection?.observe(element);
  return ()=>{this.#entries.delete(element);this.#near.delete(element);this.#intersection?.unobserve(element);};
 }
 measure(body:HTMLElement):()=>void {
  // Preserve measured height when the heavy content is replaced by a placeholder.
  const height=body.getBoundingClientRect().height;
  if(height>0 && body.parentElement)body.parentElement.style.minHeight=`${this.#height(body,body.parentElement)}px`;
  this.#resize?.observe(body);
  return ()=>this.#resize?.unobserve(body);
 }
 disconnect():void {this.#root?.removeEventListener("focusout",this.#focusOut);this.#root=null;this.#near.clear();this.#intersection?.disconnect();this.#resize?.disconnect();this.#intersection=null;this.#resize=null;}
}

export const VisibleTurn=memo(function VisibleTurn({turn,registry,eager,targeted,children}:{turn:ConversationTurn;registry:TurnVisibility;eager:boolean;targeted:boolean;children:React.ReactNode}):React.ReactElement {
 const shell=useRef<HTMLElement>(null),body=useRef<HTMLDivElement>(null);
 const [near,setNear]=useState(false);
 const visible=!registry.supported || eager || targeted || near;
 useEffect(()=>{const element=shell.current;return element ? registry.register(element,setNear) : undefined;},[registry]);
 useEffect(()=>{const element=body.current;return element ? registry.measure(element) : undefined;},[registry,visible]);
 return <section ref={shell} id={turnAnchor(turn.id)} className="conversation-turn virtual-turn" data-conversation-turn={turn.user ? turn.id : undefined} style={{minHeight:registry.supported ? 220 : undefined}}>
  {visible ? <div ref={body} className="turn-body">{children}</div> : <div className="turn-placeholder" aria-label="历史轮次，滚动到此处加载"/>}
 </section>;
});
