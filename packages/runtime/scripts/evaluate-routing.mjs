import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const equal = (a,b) => [...a].sort().join('\0') === [...b].sort().join('\0');
export function evaluate(samples, capture = { responses: [], roleMap: {} }) {
  if(capture.samplesHash && capture.samplesHash!==createHash("sha256").update(JSON.stringify(samples)).digest("hex"))
    throw Error("样本哈希不匹配，不能把不同标签或输入的结果作为同一批评测");
  const mapped = Object.fromEntries(Object.entries(capture.roleMap ?? {}).map(([name,id])=>[id,name]));
  const rows = new Map();
  for (const row of capture.responses ?? []) {
    if (rows.has(row.id)) throw Error("样本输出ID重复："+row.id);
    rows.set(row.id,row);
  }
  const roleNames = ids => ids.map(id=>mapped[id]??id);
  const results = samples.map(sample=>{
    const row=rows.get(sample.id);
    if(!row) return {id:sample.id,status:'missing',reason:'未提供真实模型输出'};
    const d=row.decision;
    if(!d || typeof d.action!=='string' || !Array.isArray(d.roleIds) || !Array.isArray(d.assignments)) {
      const expectedWake=sample.actions.includes('dispatch')?(sample.roles??[]):[];
      const actual=row.observed?roleNames([...new Set([...(row.observed.planningRoles??[]),...(row.observed.executionRoles??[])])]):null;
      return {id:sample.id,status:'failed',reason:row.error??'输出缺少 action、roleIds 或 assignments',
        expectedWake,extra:[],missing:expectedWake,actual,actualExtra:actual?.filter(r=>!expectedWake.includes(r))??[],actualMissing:actual?expectedWake.filter(r=>!actual.includes(r)):[]};
    }
    const roles=roleNames(d.roleIds),assigned=roleNames(d.assignments.map(a=>a?.roleId));
    const expected=sample.roles??[],expectedWake=sample.actions.includes('dispatch')?expected:[];
    const reasons=[];
    if(!sample.actions.includes(d.action))reasons.push('请求类型判断错误');
    if(!((sample.allowEmpty && roles.length===0)||equal(roles,expected)))reasons.push('声明的角色不匹配');
    if(new Set(roles).size!==roles.length || new Set(assigned).size!==assigned.length)reasons.push('重复分配角色');
    if(d.action==='dispatch' && !equal(roles,assigned))reasons.push('声明角色与实际分工不一致');
    if(d.action!=='dispatch' && assigned.length)reasons.push('非执行请求仍携带分工');
    const proposed=d.action==='dispatch'?assigned:[];
    if(proposed.some(id=>(sample.paused??[]).includes(id)))reasons.push('向暂停角色分配工作');
    const extra=proposed.filter(id=>!expectedWake.includes(id)),missing=expectedWake.filter(id=>!proposed.includes(id));
    if(extra.length)reasons.push('多选无关执行角色');
    if(missing.length)reasons.push('漏选必要执行角色');
    const observed=row.observed;
    const actual=observed?roleNames([...new Set([...(observed.planningRoles??[]),...(observed.executionRoles??[])])]):null;
    const actualExtra=actual?.filter(id=>!expectedWake.includes(id))??[];
    const actualMissing=actual?expectedWake.filter(id=>!actual.includes(id)):[];
    if(actualExtra.length)reasons.push('实际唤醒无关角色');
    if(actualMissing.length)reasons.push('实际未唤醒必要角色');
    if(actual?.some(id=>(sample.paused??[]).includes(id)))reasons.push('实际唤醒暂停角色');
    if(observed?.error)reasons.push('内核未接受或未完成本轮：'+observed.error);
    if(observed?.isolationViolations?.length)reasons.push('执行角色上下文隔离检查失败');
    if(observed?.ownCanaryChecks?.some(check=>check.seen!==true))reasons.push('角色私有上下文正对照缺失');
    return {id:sample.id,status:reasons.length?'failed':'passed',action:d.action,roles,assigned,
      expectedWake,extra,missing,actual,actualExtra,actualMissing,reason:reasons.join('；')||undefined};
  });
  const evaluated=results.filter(r=>r.status!=='missing').length,passed=results.filter(r=>r.status==='passed').length;
  const observed=results.filter(r=>r.actual!==null && r.actual!==undefined);
  const count=(key,items=results)=>items.reduce((sum,r)=>sum+(r[key]?.length??0),0);
  const proposedRoles=count('assigned',results.filter(r=>r.action==='dispatch'));
  const required=count('expectedWake');
  return {model:capture.model??null,
    notice:'评分比较采集文件，程序本身不证明来源；真实模型采集方法、执行替身和隔离范围见对应报告。缺失样本不算通过。',
    total:samples.length,evaluated,passed,missing:results.length-evaluated,matchRate:evaluated?passed/evaluated:null,
    extraRoleSelections:count('extra'),missingRequiredSelections:count('missing'),
    unnecessarySelectionRate:proposedRoles?count('extra')/proposedRoles:null,
    requiredSelectionMissRate:required?count('missing')/required:null,
    observedSamples:observed.length,unnecessaryActualWakeups:count('actualExtra',observed),
    missingActualWakeups:count('actualMissing',observed),results};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const sampleFlag=process.argv.indexOf('--samples');
 const samples=JSON.parse(readFileSync(sampleFlag>=0?process.argv[sampleFlag+1]:new URL('../../../docs/role-workbench-v2/acceptance/chinese-routing-samples.json',import.meta.url),'utf8'));
 const report=evaluate(samples,process.argv[2]?JSON.parse(readFileSync(process.argv[2],'utf8')):undefined);
 console.log(JSON.stringify(report,null,2));
 if(report.missing || report.results.some(r=>r.status==='failed'))process.exitCode=1;
}
