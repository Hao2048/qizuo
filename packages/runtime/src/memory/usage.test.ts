import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { HarnessDatabase, MIGRATIONS } from "../db/database.js";
import { MemoryService } from "./memory-service.js";
let db: HarnessDatabase, memory: MemoryService;
beforeEach(()=>{
  db=HarnessDatabase.memory(); memory=new MemoryService(db);
  for(const id of ['a','b']) db.prepare("INSERT INTO roles(id,name,created_at,updated_at) VALUES(?,?,1,1)").run(id,id);
  db.prepare("INSERT INTO roles(id,name,is_default,created_at,updated_at) VALUES('default','任务助手',1,1,1)").run();
  for(const [id,role] of [['source','a'],['next','a'],['other','b']]) db.prepare("INSERT INTO tasks(id,title,role_id,created_at,updated_at) VALUES(?,?,?,1,1)").run(id,id,role);
});
afterEach(()=>{db.close();vi.restoreAllMocks();});
function write(roleId='a',extra:Record<string,unknown>={}) {
  return memory.write({scopeType:'role',scopeId:roleId,title:'Docker 部署方法',content:'先校验配置',...extra});
}
it('普通检索与查看不会伪造引用；实际引用合并重复请求，保留版本并拒绝跨角色和未知版本',()=>{
  const m=write();
  memory.retrieve({scopes:[{scopeType:'role',scopeId:'a'}],query:'Docker'});
  expect(memory.usage.get('a',m.id).referenceTotal).toBe(0);
  for(let i=0;i<3;i++) memory.usage.record('a',[m],{taskId:'next',stage:'execution'});
  memory.usage.record('b',[m],{taskId:'other',stage:'execution'});
  memory.usage.record('a',[m],{taskId:'other',stage:'execution'});
  memory.usage.record('a',[{id:m.id,version:999}],{taskId:'next',stage:'execution'});
  expect(memory.usage.get('a',m.id)).toMatchObject({referenceTotal:1,summary:{referencedMemories:1},references:[{version:1,taskId:'next',subsequent:true}]});
  memory.revise(m.id,{content:'先验证 Docker 配置再部署'});
  memory.usage.record('a',[memory.get(m.id)],{taskId:'next',stage:'execution'});
  expect(memory.usage.get('a',m.id).references.map(r=>r.version)).toEqual([2,1]);
  expect(()=>memory.usage.get('b',m.id)).toThrow('不属于');
  expect(memory.usage.get('b').summary.referencedMemories).toBe(0);
});
it('只记录当前角色、项目内已可用版本，候选不被注入；统计已采纳、待核对、忘记和正文修订而非审核版本数',()=>{
  const candidate=memory.propose({scopeType:'role',scopeId:'a',title:'Docker 部署方法',content:'先校验配置',sourceTaskId:'source'});
  memory.usage.record('a',[candidate],{taskId:'next',stage:'execution'});
  expect(memory.usage.get('a',candidate.id)).toMatchObject({referenceTotal:0,summary:{automaticTotal:1,automaticPending:1,automaticRevised:0}});
  memory.review({memoryId:candidate.id,expectedVersion:1,decision:'accept',conflicts:[],evidence:'已核对'});
  memory.usage.record('a',[memory.get(candidate.id)],{taskId:'source',stage:'execution'});
  expect(memory.usage.get('a').summary).toMatchObject({automaticRetained:1,automaticPending:0,automaticRevised:0,referencedMemories:0});
  memory.usage.record('a',[memory.get(candidate.id)],{taskId:'next',stage:'execution'});
  memory.revise(candidate.id,{content:'先校验配置与版本'});
  memory.forget(candidate.id);
  expect(memory.usage.get('a').summary).toMatchObject({automaticTotal:1,automaticRetained:0,automaticForgotten:1,automaticRevised:1,referencedMemories:1});
  const scoped=write('a',{title:'专用项目',projectId:'private-project'});
  memory.usage.record('a',[scoped],{taskId:'next',stage:'execution'});
  expect(memory.usage.get('a',scoped.id).referenceTotal).toBe(0);
});
function workbench() {
  db.prepare("INSERT INTO workbenches VALUES('w',?,1,1)").run(JSON.stringify({id:'w',title:'协作',projectId:null,participants:[{roleId:'a',enabled:true},{roleId:'b',enabled:false}]}));
  db.prepare("INSERT INTO workbench_runs VALUES('source','w','a','/test','{}','[]','q','{}')").run();
}
it('工作台来源规划和执行不计后续复用；协调只能用默认角色，暂停角色不能记录规划',()=>{
  workbench();
  const m=write('a',{sourceTaskId:'source'}), other=write('b'), assistant=write('default');
  memory.usage.record('a',[m],{workbenchId:'w',stage:'planning'});
  memory.usage.record('a',[m],{workbenchId:'w',stage:'routing'});
  memory.usage.record('b',[other],{workbenchId:'w',stage:'planning'});
  memory.usage.record('default',[assistant],{workbenchId:'w',stage:'routing'});
  expect(memory.usage.get('a',m.id)).toMatchObject({referenceTotal:1,summary:{referencedMemories:0},references:[{subsequent:false,workbenchId:'w'}]});
  expect(memory.usage.get('b',other.id).referenceTotal).toBe(0);
  expect(memory.usage.get('default',assistant.id).referenceTotal).toBe(1);
  memory.usage.record('a',[m],{taskId:'next',stage:'execution'});
  expect(memory.usage.get('a').summary.referencedMemories).toBe(1);
});
it('删除任务或工作台级联清理引用，不误删记忆、其他任务或其他角色；不保留正文快照',()=>{
  workbench(); const m=write(), b=write('b');
  memory.usage.record('a',[m],{taskId:'next',stage:'execution'});
  memory.usage.record('a',[m],{workbenchId:'w',stage:'planning'});
  memory.usage.record('b',[b],{taskId:'other',stage:'execution'});
  db.prepare("DELETE FROM tasks WHERE id='next'").run();
  expect(memory.usage.get('a',m.id).referenceTotal).toBe(1);
  db.prepare("DELETE FROM workbenches WHERE id='w'").run();
  expect(memory.usage.get('a',m.id).referenceTotal).toBe(0);
  expect(memory.usage.get('b',b.id).referenceTotal).toBe(1);
  expect(memory.get(m.id).content).toBe('先校验配置');
  const columns=db.prepare('PRAGMA table_info(memory_citations)').all() as {name:string}[];
  expect(columns.map(c=>c.name)).toEqual(['memory_id','version','owner_key','task_id','workbench_id','stage','first_at','last_at']);
  db.prepare('DELETE FROM memories WHERE id=?').run(b.id);
  expect(db.prepare('SELECT * FROM memory_citations').all()).toHaveLength(0);
});
it('引用读取最多20组且稳定排序，统计不受记忆列表分页影响',()=>{
  const m=write();
  for(let i=0;i<25;i++) {
    db.prepare("INSERT INTO tasks(id,title,role_id,created_at,updated_at) VALUES(?,?,'a',1,1)").run('extra'+i,'任务'+i);
    memory.usage.record('a',[m],{taskId:'extra'+i,stage:'execution'});
  }
  const result=memory.usage.get('a',m.id);
  expect(result.referenceTotal).toBe(25);expect(result.references).toHaveLength(20);
  expect(memory.usage.get('a',m.id).references).toEqual(result.references);
  expect(result.observedSince).toBeGreaterThan(0);
});
it('引用统计失败不会阻止原任务，错误日志不包含私有正文或数据库错误',()=>{
  const m=write(); db.prepare('DROP TABLE memory_citations').run();
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  expect(()=>memory.usage.record('a',[m],{taskId:'next',stage:'execution'})).not.toThrow();
  expect(warn).toHaveBeenCalledWith('记忆引用统计未写入；任务继续执行');
});
it('第16号迁移只新增引用元数据，不回填虚构的历史复用',()=>{
  expect(MIGRATIONS.find(m=>m.version===16)?.name).toBe('role-memory-citations');
  const m=write();expect(memory.usage.get('a',m.id).referenceTotal).toBe(0);
});
