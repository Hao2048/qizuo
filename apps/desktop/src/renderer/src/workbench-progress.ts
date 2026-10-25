import type { Workbench, WorkbenchParticipant } from "@pi-harness/contracts";

export type RoleProgress = {
  label: string;
  detail: string;
  tone: "active" | "waiting" | "attention" | "quiet";
  tab?: "conversation" | "records" | "contracts" | "results";
};
export function latestWorkbenchRequest(w: Workbench): string | undefined {
  return w.messages.findLast(m=>m.sender==="你"&&m.kind==="request")?.requestId
    ?? w.roundProgress?.requestId ?? w.messages.findLast(m=>m.kind==="dispatch")?.requestId;
}
export function currentRound(w: Workbench) {
  return w.roundProgress?.requestId===latestWorkbenchRequest(w)?w.roundProgress:undefined;
}
const name=(w:Workbench,id:string)=>w.participants.find(p=>p.roleId===id)?.name??w.roleHistory?.find(p=>p.roleId===id)?.name??"相关角色";
const item=(label:string,detail:string,tone:RoleProgress["tone"]="quiet",tab?:RoleProgress["tab"]):RoleProgress=>({label,detail,tone,tab});

/** Read-only projection of host receipts. Never parse instructions to guess dependencies. */
export function roleProgress(w: Workbench, p: WorkbenchParticipant): RoleProgress {
  const requestId=latestWorkbenchRequest(w), round=currentRound(w);
  const role=round?.roles.find(r=>r.roleId===p.roleId);
  const dispatch=w.messages.findLast(m=>m.kind==="dispatch"&&m.requestId===requestId);
  const assigned=!!role||!!dispatch?.recipients.includes(p.roleId);
  const started=role?role.stage==="running"||role.stage==="finished":w.messages.some(m=>m.requestId===requestId&&m.sender===p.roleId&&m.kind==="execution");
  const ended=role?.stage==="finished" || (!role&&assigned&&w.messages.some(m=>m.requestId===requestId&&m.sender===p.roleId&&m.kind==="result"));
  if(p.unavailable)return item("角色不可用","请通过“配置与交接”选择替代角色；不会自动更换。","attention");
  if(!p.enabled)return item(p.status==="applied"?"已暂停 · 已应用":p.status==="awaiting_review"?"已暂停 · 待审阅":"已暂停",p.status==="applied"?"成果已应用；恢复开关不会自动重跑。":ended||p.status==="awaiting_review"?"已完成的成果仍保留；恢复开关不会自动重跑。":"暂停期间不派发工作，已有协作请求会保留。","quiet");
  if(w.phase==="routing")return item("等待分工","任务助手正在判断本次要求涉及哪些角色。","waiting");
  if(w.phase==="waiting_decision"&&assigned&&!ended)return item("等待方案选择","共同约定有待确认的变更；请先选择方案，再继续安排。","attention","contracts");
  const active=w.phase==="running";
  if(active&&p.collaborationWait)return item("等待角色答复",p.collaborationWait,"waiting","conversation");
  const question=w.messages.find(m=>m.requestId===requestId&&m.recipients[0]===p.roleId&&m.notification?.purpose==="question"&&m.notification.automatic?.state==="running");
  if(active&&question)return item("正在只读答复",`正在答复${name(w,question.sender)}；此答复不执行工具或修改文件。`,"active","conversation");
  if(w.phase==="planning"&&assigned){
    if(role?.stage==="planning")return item("正在规划","正在明确本角色的职责、交付物和对接方式。","active");
    if(role?.stage==="ready")return item("规划已就绪","等待其他角色完成规划，尚未开始执行。","waiting");
    return item("等待规划","按本轮分工依次规划，尚未调用本角色执行工具。","waiting");
  }
  if(assigned&&role?.stage==="preparing"&&active)return item("准备执行","正在准备隔离工作副本并核对上游交付。","active");
  if(assigned&&started&&active&&!ended){
    if(p.status==="done")return item("整理执行结果","本角色执行已结束，正在记录成果和核对交付物。","active","records");
    if(["cancelled","interrupted"].includes(p.status))return item("正在停止","正在释放本角色执行资源并保留进度，不会自动重放操作。","waiting","records");
    if(p.status==="error")return item("执行失败","请查看本角色记录并核对已发生的操作，再安排修复。","attention","records");
    if(p.status==="waiting_approval")return item("等待你的批准","本角色的操作正在等待批准；可在下方审批区处理。","attention","records");
    if(p.status==="waiting_user")return item("等待你的回答","本角色需要你补充信息或选择方案；可在下方提问区回答。","attention","records");
    const resource=p.pluginResources?.find(r=>r.status==="waiting");
    if(resource)return item("等待插件资源",`等待插件资源 ${resource.resource} · 队列第 ${resource.position} 位；轮到后继续。`,"waiting","records");
    if(p.status==="running")return item("工作中","正在自己的隔离副本中处理本轮职责。","active","records");
  }
  if(p.status==="needs_update"&&(ended||!assigned))return item("需配套更新",p.deliveryCheck?.issues[0]??"共同约定或上游产出已变化；请安排配套更新，旧成果不能直接应用。","attention","results");
  if(assigned&&p.status==="blocked"){
    const permission=w.messages.findLast(m=>m.requestId===requestId&&m.sender===p.roleId&&m.kind==="notice"&&m.text.startsWith("等待授权："));
    if(permission)return item("等待授权","缺少本角色所需权限；请在执行记录中核对授权，再继续安排。","attention","records");
  }
  const dependencies=role?.dependsOn.map(id=>({id,p:w.participants.find(p=>p.roleId===id),r:round?.roles.find(r=>r.roleId===id)}))??[];
  const waiting=dependencies.filter(d=>d.r?.stage!=="finished"||!d.p?.enabled||d.p.unavailable||d.p.status==="needs_update"||d.p.deliveryCheck?.status==="failed");
  if(assigned&&waiting.length&&((active&&!started)||p.status==="blocked")){
    const reason=waiting.map(d=>`${name(w,d.id)}${!d.p||d.p.unavailable?"（不可用）":!d.p.enabled?"（已暂停）":d.p.deliveryCheck?.status==="failed"?"（交付检查未通过）":d.p.status==="needs_update"?"（需更新）":""}`).join("、");
    return item("等待上游交付",`等待${reason}交付并通过检查；本角色尚未开始执行。`,waiting.some(d=>!d.p?.enabled||d.p.unavailable||d.p.deliveryCheck?.status==="failed")?"attention":"waiting","records");
  }
  if(ended&&p.deliveryCheck?.status==="failed")return item("交付检查未通过",p.deliveryCheck.issues[0]??"请检查交付物，再安排修复。","attention","results");
  if(ended){
    const unresolved=w.messages.filter(m=>m.requestId===requestId&&m.sender===p.roleId&&m.notification?.purpose&&m.notification.purpose!=="information"&&m.notification.status!=="handled");
    if(unresolved.length)return item("执行已结束",`还有${unresolved.length}项发出的协作请求未解决；执行结束不等于交付完成。`,"attention","conversation");
    if(w.phase==="done")return item("已验收","用户已确认本次交付。","quiet","results");
    if(p.status==="applied")return item("已应用成果","成果已应用，仍需完成整体联调验收。","quiet","results");
    return item("待审阅成果","本角色执行已结束，成果尚需审阅与验收。","quiet","results");
  }
  if(assigned&&["stopped","error","pausing"].includes(w.phase))return item(w.phase==="pausing"?"正在停止":"本轮已停止",p.status==="error"?"本角色执行失败；请查看记录并核对已发生的操作。":"已保留进度和协作消息；继续前请核对结果，不自动重放。","attention","records");
  if(active&&assigned){
    return item("等待执行席位","依赖就绪后按当前并发顺序接手，未额外调用模型等待。","waiting");
  }
  if(!assigned&&requestId)return item("本轮无需参与",p.status==="applied"?"已有成果已应用；本轮未安排新工作。":p.status==="awaiting_review"?"已有成果待审阅；本轮未派发新工作。":"任务助手未向本角色派发本轮工作，已有成果和记忆保留。","quiet");
  // Older records have no reliable dependency snapshot; show known state only.
  if(p.status==="awaiting_review")return item("待审阅成果","已有成果待审阅；尚未验收。","quiet","results");
  if(p.status==="applied")return item("已应用成果","已有成果已应用，仍需整体联调验收。","quiet","results");
  if(p.status==="needs_update")return item("需配套更新","共同约定或上游产出已变化，请核对后安排更新。","attention","results");
  if(p.status==="interrupted"||p.status==="cancelled")return item("执行已中断","进度已保留，继续前请核对结果；不会自动重跑。","attention","records");
  return item("待命","收到明确分工后开始工作。","quiet");
}

export function workbenchProgress(w: Workbench) {
  const requestId=latestWorkbenchRequest(w),round=currentRound(w);
  const ids=round?.roles.map(r=>r.roleId)??w.messages.findLast(m=>m.requestId===requestId&&m.kind==="dispatch")?.recipients??[];
  const answering=w.phase==="running"?w.messages.filter(m=>m.requestId===requestId&&m.notification?.purpose==="question"&&m.notification.automatic?.state==="running").flatMap(m=>m.recipients):[];
  const roles=w.participants.filter(p=>ids.includes(p.roleId)||answering.includes(p.roleId)).map(p=>({participant:p,progress:roleProgress(w,p),assigned:ids.includes(p.roleId)}));
  const finished=roles.filter(({participant:p,assigned})=>assigned&&(round?round.roles.find(r=>r.roleId===p.roleId)?.stage==="finished":w.messages.some(m=>m.requestId===requestId&&m.sender===p.roleId&&m.kind==="result"))).length;
  const unresolved=w.messages.filter(m=>m.requestId===requestId&&m.notification?.purpose&&m.notification.purpose!=="information"&&m.notification.status!=="handled").length;
  return {roles,finished,unresolved,requestId,assignedCount:roles.filter(r=>r.assigned).length};
}

/** A later failed routing request must not hide a still-blocked worker's recovery entry. */
export function permissionBlockedRoles(w: Workbench): WorkbenchParticipant[] {
  return w.participants.filter(p=>p.enabled&&!p.unavailable&&p.status==="blocked"&&
    w.messages.findLast(m=>m.sender===p.roleId&&m.kind==="notice")?.text.startsWith("等待授权："));
}
