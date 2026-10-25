import {act,cleanup} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {openTask} from './data.js';
import {dispatchAppEvent} from './events.js';
import {useStore} from './store.js';
let resolveGet:(value:unknown)=>void;
const message=(id:string,text:string,entryId?:string)=>({id,role:'assistant' as const,text,timestamp:1,...(entryId?{entryId}:{})});
beforeEach(()=>{
 useStore.getState().resetConversation();
 window.pih={invoke:vi.fn(async(name:string)=>name==='task:get'?new Promise(r=>{resolveGet=r;}):{ok:true,result:name==='task:list'?{tasks:[]}:{} }),onEvent:()=>()=>{},platform:'darwin',versions:{electron:'',chrome:''}};
});
afterEach(()=>{cleanup();useStore.getState().resetConversation();delete window.pih;});
it('retains replies arriving during task hydration and deduplicates snapshot copies by persisted entry',async()=>{
 const loading=openTask('a');
 act(()=>dispatchAppEvent({type:'task:stream',ts:1,payload:{taskId:'a',kind:'assistant_message_end',message:message('live','new reply','entry-new')}}));
 resolveGet({ok:true,result:{task:{id:'a',status:'done'},transcript:[message('old','old reply','entry-old')]}});await loading;
 expect(useStore.getState().transcript.map(m=>m.text)).toEqual(['old reply','new reply']);
 const again=openTask('a');
 act(()=>dispatchAppEvent({type:'task:stream',ts:2,payload:{taskId:'a',kind:'assistant_message_end',message:message('live-new','new reply','entry-new')}}));
 resolveGet({ok:true,result:{task:{id:'a',status:'done'},transcript:[message('saved','new reply','entry-new')]}});await again;
 expect(useStore.getState().transcript.map(m=>m.text)).toEqual(['new reply']);
});
it('does not resurrect a resolved approval from an older snapshot',async()=>{
 const loading=openTask('a');
 act(()=>dispatchAppEvent({type:'task:state',ts:2,payload:{taskId:'a',status:'running'}}));
 resolveGet({ok:true,result:{task:{id:'a',status:'waiting_approval'},transcript:[],pendingApprovals:[{taskId:'a',toolCallId:'old-approval',toolName:'write',input:{}}]}});await loading;
 expect(useStore.getState().taskStatus).toBe('running');expect(useStore.getState().pendingApprovals).toHaveLength(0);
});
it('ignores the full late snapshot from a previously selected task',async()=>{
 const old=openTask('a'),finishOld=resolveGet;const latest=openTask('b'),finishLatest=resolveGet;
 finishLatest({ok:true,result:{task:{id:'b',status:'done'},transcript:[message('b','B only','entry-b')]}});await latest;
 finishOld({ok:true,result:{task:{id:'a',status:'done'},transcript:[message('a','A private','entry-a')]}});await old;
 expect(useStore.getState().currentTaskId).toBe('b');expect(useStore.getState().transcript.map(m=>m.text)).toEqual(['B only']);
});
