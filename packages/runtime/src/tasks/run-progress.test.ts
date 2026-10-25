import { expect, it } from "vitest";
import type { RunProgress } from "@pi-harness/contracts";
import { RunProgressTracker } from "./run-progress.js";
it("separates preparation from first response and stops tracking settled runs", () => {
 let at = 100; const events: RunProgress[] = [];
 const tracker = new RunProgressTracker(p => events.push(structuredClone(p)), () => at);
 tracker.begin("t"); at=110; tracker.stage("t","git"); at=130; tracker.stage("t","request"); at=190; tracker.response("t");
 at=220; tracker.stage("t","request"); tracker.response("t"); at=250; tracker.finish("t","complete");
 expect(events.at(-1)).toMatchObject({preparationMs:30,firstResponseMs:60,elapsedMs:150,stage:"complete"});
 expect(events.at(-1)?.stages[1]).toEqual({stage:"git",durationMs:20});
 const count=events.length; tracker.stage("t","request"); tracker.response("t"); expect(events).toHaveLength(count);
});
it("keeps overlapping conversations isolated and never revives cancelled work",()=>{
 let at=0; const events: RunProgress[]=[]; const tracker=new RunProgressTracker(p=>events.push(structuredClone(p)),()=>at);
 tracker.begin("a"); tracker.begin("b"); at=20; tracker.finish("a","stopped"); at=30; tracker.stage("a","resources"); tracker.stage("b","request");
 expect(events.filter(p=>p.taskId==="a").at(-1)?.stage).toBe("stopped");
 expect(events.at(-1)).toMatchObject({taskId:"b",preparationMs:30});
 tracker.clear(); const count=events.length;tracker.finish("b","complete");expect(events).toHaveLength(count);
});

it("separates repeated provider waits, thinking and overlapping tool time without retaining a completed run",()=>{
 let at=0;const values:any[]=[];const t=new RunProgressTracker(p=>values.push(structuredClone(p)),()=>at);
 t.begin("a");at=10;t.stage("a","request");at=30;t.providerResponse("a");at=40;t.chunk("a","thinking_delta");at=70;t.chunk("a","text_delta");at=80;t.tool("a","one",true);at=90;t.tool("a","two",true);at=100;t.tool("a","one",false);at=120;t.tool("a","two",false);at=130;t.stage("a","request");at=160;t.providerResponse("a");at=170;t.chunk("a","text_delta");at=180;t.finish("a","complete");
 expect(values.at(-1)).toMatchObject({requestCount:2,providerWaitMs:50,thinkingMs:30,toolExecutionMs:40});
 const n=values.length;t.providerResponse("a");t.chunk("a","text_delta");t.tool("a","late",true);expect(values).toHaveLength(n);
});
