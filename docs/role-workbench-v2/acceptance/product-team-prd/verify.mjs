/** Independent acceptance; owns no model credentials and does not modify deliverables. */
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const users=json('research/users.json'),market=json('research/market.json'),tech=json('research/technical.json'),trace=json('delivery/traceability.json'),review=json('validation/review.json');
const prd=readFileSync('delivery/PRD.md','utf8');
const sourceIds=new Set([...Array.from({length:12},(_,i)=>'U'+String(i+1).padStart(2,'0')),...Array.from({length:5},(_,i)=>'S'+(i+1))]);
let checks=0;const check=(condition,label)=>{assert(condition,label);checks++;};
check(users.kind==='synthetic','用户数据必须标记合成');check(users.needs?.length>=6,'至少六条有依据的用户需要');
check(market.sources?.length>=3,'至少三个公开来源');for(const s of market.sources??[])check(sourceIds.has(s.id)&&typeof s.url==='string'&&s.url.startsWith('https://'),'来源注册与URL');
check(Array.isArray(tech.constraints)&&tech.constraints.length>=4,'技术约束不少于四项');check(Array.isArray(tech.risks)&&tech.risks.length>=3,'技术风险不少于三项');
check(/合成/.test(prd)&&/待验证|待确认/.test(prd),'PRD标注合成与不确定性');
for(const text of ['背景与问题','目标用户','信息来源与可信度','产品目标与非目标','MVP范围','核心流程','功能需求','数据与权限','异常与边界','指标与验证','验收标准','风险与待确认'])check(prd.includes(text),'PRD章节 '+text);
check((trace.requirements??[]).length>=8,'至少八条可追溯需求');const reqIds=new Set();
for(const r of trace.requirements??[]){check(typeof r.id==='string'&&!reqIds.has(r.id),'需求编号唯一');reqIds.add(r.id);check(['P0','P1','P2'].includes(r.priority),'需求优先级');check(Array.isArray(r.sourceIds)&&r.sourceIds.length>0&&r.sourceIds.every(s=>sourceIds.has(s)),'需求有已知证据');check(Array.isArray(r.acceptance)&&r.acceptance.length>0&&r.acceptance.every(s=>typeof s==='string'&&s.trim().length>=5),'需求有验收条件');check(prd.includes(r.id),'PRD与追溯需求对应');}
check(Array.isArray(trace.assumptions)&&trace.assumptions.length>0,'假设明确');check(review.passed===true&&Array.isArray(review.issues)&&review.issues.length===0,'审阅不能留下未解决问题');check(review.checks?.length>=8&&review.checks.every(c=>c.passed===true),'独立审阅检查齐全');check(!/人工逐节|人工评审|真人|手工审阅/.test(review.method??''),'AI评审不能冒充真人确认');
for(const forbidden of ['PRODUCT_PRIVATE_','PRIVATE_MEMORY_'])check(!prd.includes(forbidden)&&!JSON.stringify([users,market,tech,trace,review]).includes(forbidden),'私有标记不进入交付物');
if(process.env.CHECK_PRODUCT_REVISION==='1'){
 check(trace.version==='1.1','修改后文档版本1.1');check(tech.mode==='local-only-mvp','首版仅本地');check(prd.includes('二次确认'),'删除需要二次确认');check(/7\s*天|七天/.test(prd),'7天内恢复');
 check(trace.requirements.some(r=>/二次确认/.test(r.description+' '+r.acceptance.join(' '))),'删除确认可追溯');
 check(trace.requirements.some(r=>/7\s*天|七天/.test(r.description+' '+r.acceptance.join(' '))),'恢复时限可追溯');
}
console.log(JSON.stringify({passed:true,checks,version:trace.version,note:'结构和追溯检查，不替代真实需求或商业可行性验证'}));
