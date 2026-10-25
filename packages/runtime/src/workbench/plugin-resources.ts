/** FIFO role-session leases. Cancellation never frees a resource while its operation is still running. */
type State='waiting'|'using'|'released';
type Observer=(state:State,position:number)=>void;
type Request={owner:string;signal:AbortSignal;notify:Observer;resolve:(release:()=>void)=>void;reject:(error:Error)=>void;cancel:()=>void};
type Lease={owner:string;running:boolean;closing:boolean;notify:Observer};
export class PluginResources {
 #leases=new Map<string,Lease>();
 #pending=new Map<string,Request[]>();
 #notify(fn:Observer,state:State,position=0){try{fn(state,position);}catch{/* UI observers cannot change lock ownership. */}}
 #positions(key:string){
  const positions=new Map<string,number>(),owner=this.#leases.get(key)?.owner;
  for(const r of this.#pending.get(key)??[]){
   if(r.owner===owner){this.#notify(r.notify,'using');continue;}
   if(!positions.has(r.owner))positions.set(r.owner,positions.size+1);
   this.#notify(r.notify,'waiting',positions.get(r.owner)!);
  }
 }
 #cycle(owner:string,holder:string):boolean {
  const visited=new Set<string>(),stack=[holder];
  while(stack.length){const current=stack.pop()!;if(current===owner)return true;if(visited.has(current))continue;visited.add(current);
   for(const [key,list]of this.#pending){const held=this.#leases.get(key)?.owner;if(held && held!==current && list.some(r=>r.owner===current))stack.push(held);}
  }return false;
 }
 #pump(key:string){
  const list=this.#pending.get(key)??[];let lease=this.#leases.get(key);
  if(lease?.running || lease?.closing)return;
  const index=lease?list.findIndex(r=>r.owner===lease!.owner):0;
  if(index<0 || !list.length){if(!list.length)this.#pending.delete(key);return;}
  const request=list.splice(index,1)[0]!;request.signal.removeEventListener('abort',request.cancel);
  if(!list.length)this.#pending.delete(key);
  lease??={owner:request.owner,running:false,closing:false,notify:request.notify};lease.running=true;this.#leases.set(key,lease);
  this.#notify(request.notify,'using');this.#positions(key);
  let released=false;
  request.resolve(()=>{if(released)return;released=true;lease!.running=false;if(lease!.closing){this.#leases.delete(key);this.#notify(lease!.notify,'released');}this.#pump(key);});
 }
 async #acquire(key:string,owner:string,signal:AbortSignal,notify:Observer):Promise<()=>void>{
  signal.throwIfAborted();const held=this.#leases.get(key);
  if(held && held.owner!==owner && this.#cycle(owner,held.owner))throw Error('插件资源形成循环等待，已让出当前角色的资源；请调整使用顺序后继续');
  return new Promise((resolve,reject)=>{
   const request:Request={owner,signal,notify,resolve,reject,cancel:()=>{
    const list=this.#pending.get(key),index=list?.indexOf(request)??-1;if(index<0)return;
    list!.splice(index,1);if(!list!.length)this.#pending.delete(key);signal.removeEventListener('abort',request.cancel);
    this.#notify(notify,this.#leases.get(key)?.owner===owner?'using':'released');reject(Error('插件排队已取消'));this.#positions(key);this.#pump(key);
   }};
   const list=this.#pending.get(key)??[];list.push(request);this.#pending.set(key,list);signal.addEventListener('abort',request.cancel,{once:true});
   this.#positions(key);this.#pump(key);if(signal.aborted)request.cancel();
  });
 }
 async run<T>(key:string,owner:string,signal:AbortSignal,notify:Observer,work:()=>Promise<T>):Promise<T>{
  let release:(()=>void)|undefined;let failed=false;
  const abort=()=>this.finish(owner);signal.addEventListener('abort',abort,{once:true});
  try{release=await this.#acquire(key,owner,signal,notify);signal.throwIfAborted();return await work();}
  catch(error){failed=true;throw error;}
  finally{if(failed||signal.aborted)this.finish(owner);release?.();signal.removeEventListener('abort',abort);}
 }
 finish(owner:string){
  for(const lease of this.#leases.values())if(lease.owner===owner)lease.closing=true;
  for(const [key,list]of [...this.#pending]){
   for(const request of [...list])if(request.owner===owner)request.cancel();
  }
  for(const [key,lease]of [...this.#leases])if(lease.owner===owner){
   lease.closing=true;if(!lease.running){this.#leases.delete(key);this.#notify(lease.notify,'released');this.#pump(key);}
  }
 }
 /** Diagnostics only: never includes tool arguments, credentials or role history. */
 snapshot(){return [...new Set([...this.#leases.keys(),...this.#pending.keys()])].map(resource=>({resource,owner:this.#leases.get(resource)?.owner??null,queue:(this.#pending.get(resource)??[]).map(r=>r.owner)}));}
}
