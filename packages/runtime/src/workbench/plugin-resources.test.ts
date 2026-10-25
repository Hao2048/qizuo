import{expect,it}from'vitest';import{PluginResources}from'./plugin-resources.js';
const signal=()=>new AbortController().signal,notify=()=>{};
const tick=()=>new Promise(r=>setTimeout(r,0));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};}
it('holds a continuous role session and admits other roles FIFO only after it finishes',async()=>{
 const q=new PluginResources(),events:string[]=[];
 await q.run('computer','a',signal(),notify,async()=>{events.push('a screenshot');});
 const b=q.run('computer','b',signal(),notify,async()=>{events.push('b');});
 const c=q.run('computer','c',signal(),notify,async()=>{events.push('c');});
 await tick();expect(events).toEqual(['a screenshot']);
 await q.run('computer','a',signal(),notify,async()=>{events.push('a click');});
 q.finish('a');await b;expect(events).toEqual(['a screenshot','a click','b']);
 q.finish('b');await c;q.finish('c');expect(q.snapshot()).toEqual([]);
});
it('cancels waiting roles without invoking their tool or blocking the next role',async()=>{
 const q=new PluginResources(),abort=new AbortController();let ran=false;
 await q.run('computer','a',signal(),notify,async()=>{});
 const b=q.run('computer','b',abort.signal,notify,async()=>{ran=true;});
 const rejected=expect(b).rejects.toThrow('取消');abort.abort();await rejected;
 const c=q.run('computer','c',signal(),notify,async()=>{});q.finish('a');await c;q.finish('c');expect(ran).toBe(false);expect(q.snapshot()).toEqual([]);
});
it('does not release an active operation until its promise actually settles after stopping',async()=>{
 const q=new PluginResources(),started=deferred(),done=deferred();let next=false;
 const a=q.run('computer','a',signal(),notify,async()=>{started.resolve();await done.promise;});await started.promise;
 const b=q.run('computer','b',signal(),notify,async()=>{next=true;});
 q.finish('a');await tick();expect(next).toBe(false);done.resolve();await a;await b;q.finish('b');expect(next).toBe(true);expect(q.snapshot()).toEqual([]);
});
it('releases a failed session and allows independent resources concurrently',async()=>{
 const q=new PluginResources();await expect(q.run('computer','a',signal(),notify,async()=>{throw Error('plugin failed');})).rejects.toThrow('plugin failed');
 await q.run('computer','b',signal(),notify,async()=>{});await q.run('other-computer','c',signal(),notify,async()=>{});
 expect(q.snapshot()).toHaveLength(2);q.finish('b');q.finish('c');expect(q.snapshot()).toEqual([]);
});
it('rejects circular waits and gives up the blocked roles leases instead of hanging',async()=>{
 const q=new PluginResources();await q.run('x','a',signal(),notify,async()=>{});await q.run('y','b',signal(),notify,async()=>{});
 const wait=q.run('y','a',signal(),notify,async()=>{});
 await expect(q.run('x','b',signal(),notify,async()=>{})).rejects.toThrow('循环等待');
 await wait;q.finish('a');expect(q.snapshot()).toEqual([]);
});
it('serializes concurrent calls from the same role and cancels all queued calls when finishing',async()=>{
 const q=new PluginResources(),began=deferred(),end=deferred();let ran=false;
 const a=q.run('x','a',signal(),notify,async()=>{began.resolve();await end.promise;});await began.promise;
 const queued=q.run('x','a',signal(),notify,async()=>{ran=true;});const rejected=expect(queued).rejects.toThrow('取消');
 q.finish('a');await rejected;end.resolve();await a;expect(ran).toBe(false);expect(q.snapshot()).toEqual([]);
});
