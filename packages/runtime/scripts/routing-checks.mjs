import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./evaluate-routing.mjs";
test("missing captures never count as successful routing", () => {
  const r = evaluate([{ id: "one", actions: ["clarify"], roles: [] }]);
  assert.equal(r.matchRate, null);
  assert.equal(r.missing, 1);
  assert.equal(r.passed, 0);
});
test("wrong role and paused-role activation fail even if the action label looks right", () => {
  const samples = [
    { id: "one", actions: ["dispatch"], roles: ["front"] },
    { id: "two", actions: ["dispatch"], roles: ["back"], paused: ["back"] },
  ];
  const r = evaluate(samples, {
    model: "explicit-capture",
    roleMap: { front: "f", back: "b" },
    responses: [
      { id: "one", decision: { action: "dispatch", roleIds: ["f"], assignments:[{roleId:"f"}] } },
      { id: "two", decision: { action: "dispatch", roleIds: ["b"], assignments:[{roleId:"b"}] } },
    ],
  });
  assert.equal(r.passed, 1);
  assert.equal(r.results[1].status, "failed");
  assert.throws(
    () => evaluate(samples, { responses: [{ id: "one" }, { id: "one" }] }),
    /重复/,
  );
});

test("declared roles cannot hide unrelated assignments or actual wakeups",()=>{
 const samples=[{id:'one',actions:['dispatch'],roles:['front']}];
 const report=evaluate(samples,{roleMap:{front:'f',back:'b'},responses:[{id:'one',decision:{action:'dispatch',roleIds:['f'],assignments:[{roleId:'b'}]},observed:{planningRoles:['b'],executionRoles:['b']}}]});
 assert.equal(report.passed,0);assert.equal(report.unnecessaryActualWakeups,1);assert.equal(report.missingActualWakeups,1);
 assert.match(report.results[0].reason,/声明角色与实际分工不一致/);
});
test("recommendation is not counted as waking an unjoined role and missing observation is explicit",()=>{
 const samples=[{id:'new',actions:['recommend','clarify'],roles:['qa'],allowEmpty:true}];
 const report=evaluate(samples,{responses:[{id:'new',decision:{action:'recommend',roleIds:['qa'],assignments:[]},observed:{planningRoles:[],executionRoles:[]}}]});
 assert.equal(report.passed,1);assert.equal(report.unnecessaryActualWakeups,0);assert.equal(report.observedSamples,1);
 assert.equal(evaluate(samples,{responses:[{id:'new',decision:{action:'recommend',roleIds:['qa']}}]}).passed,0);
});

test("malformed decisions count required misses rather than improving the denominator",()=>{
 const report=evaluate([{id:'one',actions:['dispatch'],roles:['front','back']}],{responses:[{id:'one',decision:null,observed:{planningRoles:[],executionRoles:[]}}]});
 assert.equal(report.passed,0);assert.equal(report.requiredSelectionMissRate,1);assert.equal(report.missingActualWakeups,2);
});

test("isolation checks include a positive control rather than accepting missing private context",()=>{
 const r=evaluate([{id:'one',actions:['dispatch'],roles:['front']}],{responses:[{id:'one',decision:{action:'dispatch',roleIds:['front'],assignments:[{roleId:'front'}]},observed:{planningRoles:['front'],executionRoles:['front'],ownCanaryChecks:[{seen:false}],isolationViolations:[]}}]});
 assert.equal(r.passed,0);assert.match(r.results[0].reason,/正对照缺失/);
});

test("changed samples cannot be scored under an old capture hash",()=>{
 assert.throws(()=>evaluate([{id:'one',actions:['clarify'],roles:[]}],{samplesHash:'wrong',responses:[]}),/哈希不匹配/);
});
