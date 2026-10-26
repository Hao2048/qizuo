import {TimeMemoryService} from "../memory/time-memory.js";
import { DraftService } from "../drafts/draft-service.js";
/**
 * HarnessCore：主进程持有的核心服务集合。
 * M0：DB + 日志 + 路由 + 健康检查
 * M1：+ PiRuntime（模型） + TaskService（任务/审批/设置/项目）
 * M2：+ RoleService（角色卡） + MemoryService（三层记忆） + CheckpointService（检查点） + LoginService（订阅 OAuth）
 */
import { removeRetiredData } from "../maintenance/retired-data.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  commandSchemas,
  type CommandInput,
  type HealthReport,
} from "@pi-harness/contracts";
import { HarnessDatabase, MIGRATIONS } from "../db/database.js";
import { Logger, type LogLevel } from "../logging/logger.js";
import { MessageRouter } from "../bus/router.js";
import { PiRuntime } from "../pi/pi-runtime.js";
import { LoginService } from "../pi/login-service.js";
import { MemoryService } from "../memory/memory-service.js";
import { RoleService } from "../roles/role-service.js";
import { CheckpointService } from "../tasks/checkpoint-service.js";
import { GitService } from "../git/git-service.js";
import { WorkbenchService } from "../workbench/workbench-service.js";
import type { AnyAppEvent } from "@pi-harness/contracts";
import { TaskService } from "../tasks/task-service.js";
import { InstallOperations } from "../market/install-operations.js";
import { MarketService } from "../market/market-service.js";
import { BackupService } from "../market/backup-service.js";
import { McpDiagnostics } from "../mcp/mcp-diagnostics.js";
import { McpService } from "../mcp/mcp-service.js";
import { installClaudePackage } from "../market/claude-install.js";
import { recoverBundleInstalls } from "../market/bundle-install.js";
import { ClaudeSkillSource } from "../market/claude-source.js";
import { CatalogService } from "../market/catalog-service.js";
import { MarketAuthService } from "../market/auth-service.js";
import { ResourcePolicy } from "../market/resource-policy.js";
import { prewarmMcpSupport } from "../market/mcp-authorization.js";
import { schedulePreparation } from "../pi/resource-prewarm.js";

export interface HarnessCoreOptions {
  dataDir: string;
  gitBinary?: string | null;
  appVersion?: string;
  logLevel?: LogLevel;
  /** 测试/冒烟：注册 faux 假模型 */
  enableFaux?: boolean;
  /** 打开外部 URL（订阅登录浏览器）；不传则只推送事件 */
  openExternal?: (url: string) => void;
  onPluginAuthorized?: () => void;
  openWorkbenchPreview?: (url:string) => Promise<void>;
  revealWorkbenchFile?: (path:string) => void;
  openWorkbenchDocument?: (path:string) => Promise<void>;
  /** M7：凭证加密（Electron safeStorage 等） */
  credentialCipher?: import("../pi/credentials.js").CredentialCipher | null;
}

export interface HarnessCore {
  router: MessageRouter;
  db: HarnessDatabase;
  logger: Logger;
  pi: PiRuntime;
  tasks: TaskService;
  workbench: WorkbenchService;
  drafts: DraftService;
  roles: RoleService;
  memory: MemoryService;
  timeMemories: TimeMemoryService;
  checkpoints: CheckpointService;
  login: LoginService;
  market: MarketService;
  installs: InstallOperations;
  catalog: CatalogService;
  marketAuth: MarketAuthService;
  backup: BackupService;
  mcp: McpService;
  mcpDiagnostics: McpDiagnostics;
  claude: ClaudeSkillSource;
  policy: ResourcePolicy;
  dataDir: string;
  logsDir: string;
  appVersion: string;
  startedAt: number;
  dispose(): void;
  shutdown(): Promise<void>;
}

export function latestMigrationVersion(): number {
  return Math.max(...MIGRATIONS.map((m) => m.version));
}

export async function createHarnessCore(
  opts: HarnessCoreOptions,
): Promise<HarnessCore> {
  const dataDir = opts.dataDir;
  const logsDir = join(dataDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  // Recover installation config before Pi or MCP reads it; preserve malformed records.
  try {
    recoverBundleInstalls(dataDir);
  } catch (error) {
    throw new Error(`安装恢复失败，已保留现场：${String(error)}`);
  }

  // pi 的部分子系统（如 MCP 扩展的 defaultLoadConfig）读全局 getAgentDir()；
  // 指向我们的隔离 agentDir，确保 mcp.json 等配置不与用户 ~/.pi 混用
  process.env["PI_CODING_AGENT_DIR"] = join(dataDir, "pi");

  const logger = new Logger({
    dir: logsDir,
    module: "core",
    level: opts.logLevel,
  });
  const db = HarnessDatabase.open(join(dataDir, "harness.db"));
  removeRetiredData(db, dataDir);
  const router = new MessageRouter({ logger: logger.child("router") });
  const pi = await PiRuntime.create({
    dataDir,
    logger: logger.child("pi"),
    enableFaux: opts.enableFaux,
    credentialCipher: opts.credentialCipher ?? null,
  });

  const memory = new MemoryService(db);
  const roles = new RoleService({ db, memory });
  const checkpoints = new CheckpointService(
    db,
    dataDir,
    logger.child("checkpoints"),
  );
  const git = new GitService(opts.gitBinary);
  const mcp = new McpService(pi.piDir);
  const mcpDiagnostics = new McpDiagnostics(mcp, pi.piDir);
  const claude = new ClaudeSkillSource({
    agentDir: pi.piDir,
    logger: logger.child("claude-market"),
    emit: (type, payload) => router.emit(type, payload),
  });

  const market = await MarketService.create({
    agentDir: pi.piDir,
    cwd: dataDir,
    logger: logger.child("market"),
    emit: (type, payload) => router.emit(type, payload),
    getVisibility: (name, kind) => {
      const row = db
        .prepare(
          "SELECT visibility FROM resource_visibility WHERE name = ? AND kind = ?",
        )
        .get(name, kind) as { visibility: string } | undefined;
      return row?.visibility === "private" ? "private" : "public";
    },
    getVisibilitySource: (name) => {
      const row = db
        .prepare("SELECT source FROM resource_visibility WHERE name = ?")
        .get(name) as { source: string | null } | undefined;
      return row?.source ?? null;
    },
    listPrivatePackages: () =>
      db
        .prepare(
          "SELECT name, source FROM resource_visibility WHERE kind = 'package' AND visibility = 'private'",
        )
        .all() as Array<{ name: string; source: string | null }>,
    deleteVisibilityRow: (name, kind) => {
      db.prepare(
        "DELETE FROM resource_visibility WHERE name = ? AND kind = ?",
      ).run(name, kind);
    },
    setVisibilityRow: (name, kind, visibility, source) => {
      db.prepare(
        "INSERT INTO resource_visibility (name, kind, visibility, source, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, visibility = excluded.visibility, source = excluded.source, updated_at = excluded.updated_at",
      ).run(name, kind, visibility, source, Date.now());
    },
  });
  const catalog = new CatalogService(market, claude, {
    get: (key) => db.getMeta(key),
    set: (key, value) => db.setMeta(key, value),
  });
  const marketAuth = new MarketAuthService(
    market,
    mcp,
    pi.piDir,
    opts.openExternal ?? (() => {}),
    opts.onPluginAuthorized,
  );
  const policy = new ResourcePolicy({
    db,
    resolvePackagePath: (source) => market.resolvePackagePath(source),
  });

  const tasks = new TaskService({
    dataDir,
    db,
    logger: logger.child("tasks"),
    pi,
    roles,
    memory,
    checkpoints,
    git,
    mcp,
    policy,
    listResources: () => market.listInstalled(),
    emit: (type, payload) => router.emit(type, payload),
  });
  const timeMemories = new TimeMemoryService({db,tasks,roles,emit:(type,payload)=>router.emit(type,payload)});
  tasks.setTimeMemoryTools((id,request)=>timeMemories.toolsFor(id,request));
  const backup = new BackupService(dataDir, logger.child("backup"), (path) =>
    db.snapshot(path),
  );
  const login = new LoginService({
    modelRuntime: () => pi.raw,
    openExternal: opts.openExternal ?? (() => {}),
    emit: (type, payload) => router.emit(type, payload),
    logger: logger.child("login"),
  });

  // 记忆归属标签解析（角色名/项目名，fallback 到 ID 片段）
  memory.setLabelResolver((scope) => {
    try {
      return `角色·${roles.get(scope.scopeId).name}`;
    } catch {
      return `角色·${scope.scopeId.slice(0, 8)}`;
    }
  });

  // 框架默认角色（幂等 seed）
  roles.seedDefault();
  const workbench = new WorkbenchService({
    mcp,
    db,
    roles,
    memory,
    tasks,
    pi,
    dataDir,
    emit: (type, payload) => router.emit(type, payload),
  });
  tasks.setWorkbenchTools((id) => workbench.toolsFor(id));
  tasks.setWorkbenchExecution((id) => workbench.canExecute(id));
  tasks.setWorkbenchContext((id) => workbench.contextForRequest(id), (id, ids) => workbench.recordNotificationDelivery(id, ids));
  tasks.setWorkbenchMemory((id, input) => workbench.stageMemory(id, input));
  const unsubscribeWorkbench = router.onEvent((e) =>
    workbench.onEvent(e as AnyAppEvent),
  );

  let recommendInitial: ReturnType<typeof setTimeout> | undefined;
  const cancelPrewarm = schedulePreparation(prewarmMcpSupport, (error) =>
    logger.warn("MCP 支持模块预热失败，将在使用时重试", {
      error: String(error),
    }),
  );
  let recommendTimer: ReturnType<typeof setInterval> | undefined;
  const core: HarnessCore = {
    installs: new InstallOperations(),
    router,
    db,
    logger,
    pi,
    tasks,
    workbench,
    drafts: new DraftService(db),
    roles,
    memory,
    timeMemories,
    checkpoints,
    login,
    market,
    catalog,
    marketAuth,
    backup,
    mcp,
    mcpDiagnostics,
    claude,
    policy,
    dataDir,
    logsDir,
    appVersion: opts.appVersion ?? "0.0.0-dev",
    startedAt: Date.now(),
    async shutdown() {
      await timeMemories.shutdown();
      await workbench.shutdown();
      await Promise.allSettled([
        tasks.shutdown(),
        core.installs.shutdown(),
        mcpDiagnostics.shutdown(),
      ]);
      core.dispose();
    },
    dispose() {
      timeMemories.dispose();
      unsubscribeWorkbench();
      workbench.dispose();
      cancelPrewarm();
      mcpDiagnostics.dispose();
      clearTimeout(recommendInitial);
      clearInterval(recommendTimer);
      core.installs.dispose();
      catalog.dispose();
      marketAuth.dispose();
      // 兼容同步 dispose；桌面正常退出使用 shutdown，先排空任务与扩展钩子再关库。
      try {
        tasks.dispose();
      } catch {
        /* 释放尽力 */
      }
      try {
        db.close();
      } catch {
        /* 关闭幂等 */
      }
      logger.info("harness core 已释放");
    },
  };

  timeMemories.start();
  registerCoreCommands(core, opts.openExternal ?? (() => {}), opts);
  if (!opts.enableFaux) {
    const refresh = () => {
      for (const source of ["pi", "claude"] as const)
        for (const kind of ["plugins", "skills"] as const)
          void catalog.recommend(source, kind).catch(() => {});
    };
    recommendInitial = setTimeout(refresh, 5000);
    recommendInitial.unref();
    recommendTimer = setInterval(refresh, 3600_000);
    recommendTimer.unref();
  }
  logger.info("harness core 启动", {
    dataDir,
    dbVersion: db.version,
    appVersion: core.appVersion,
    faux: opts.enableFaux ?? false,
  });
  return core;
}

function registerCoreCommands(
  core: HarnessCore,
  openExternal: (url: string) => void,
  artifactUI: Pick<HarnessCoreOptions,"openWorkbenchPreview"|"revealWorkbenchFile"|"openWorkbenchDocument">,
): void {
  const reg = <N extends keyof typeof commandSchemas>(
    name: N,
    handler: (input: CommandInput<N>, ctx: never) => unknown,
  ) => {
    const schemas = commandSchemas[name];
    core.router.register(name as string, {
      input: schemas.input,
      output: schemas.output,
      handler: handler as (input: unknown, ctx: unknown) => unknown,
    });
  };

  reg("dev:ping", (input) => ({
    echo: input.echo,
    pong: true,
    ts: Date.now(),
  }));
  reg("health:get", () => buildHealthReport(core));

  // 模型
  reg("model:list", async () => ({ providers: await core.pi.listProviders() }));
  reg("model:setApiKey", async (input) => {
    await core.pi.setApiKey(input.provider, input.apiKey);
    return { ok: true };
  });
  reg("model:removeApiKey", async (input) => {
    await core.pi.removeApiKey(input.provider);
    return { ok: true };
  });
  reg("model:testConnection", async (input) =>
    core.pi.testConnection(input.provider, input.modelId),
  );
  reg("model:login", (input) => core.login.start(input.provider));
  reg("model:loginAnswer", (input) => ({
    ok: core.login.answer(input.flowId, input.answer),
  }));
  reg("model:loginCancel", (input) => ({
    ok: core.login.cancel(input.flowId),
  }));

  // 设置
  reg("settings:get", () => core.tasks.getSettings());
  reg("settings:set", (input) => core.tasks.setSettings(input));

  // 项目
  reg("project:list", () => ({ projects: core.tasks.listProjects() }));
  reg("project:add", (input) => core.tasks.addProject(input.dir));
  // project:pickFolder 由 Electron main 注册（需要系统对话框）

  // 任务
  reg("workbench:setApprovalMode", (input) => core.workbench.setApprovalMode(input));
  reg("workbench:setAccess", (input) => core.workbench.setAccess(input));
  reg("workbench:verificationPlan", (input) =>
    core.workbench.verificationPlan(input.id),
  );
  reg("workbench:verify", (input) => core.workbench.verify(input));
  reg("workbench:fromConversation", (input) =>
    core.workbench.fromConversation(input),
  );
  reg("workbench:reviewImage", (input) =>
    core.workbench.reviewImage(input.id, input.roleId, input.token, input.path),
  );
  reg("workbench:create", (input) => core.workbench.create(input));
  reg("workbench:list", (input) => core.workbench.listPage(input));
  reg("workbench:get", (input) => core.workbench.get(input.id));
  reg("workbench:usage", (input) => core.workbench.modelUsage(input.id, input.requestId));
  reg("workbench:usageCalls", (input) => core.workbench.modelCalls.calls(core.workbench.get(input.id), input));
  reg("workbench:attach", (input) => core.workbench.attachments.add(input));
  reg("workbench:readAttachment", (input) =>
    core.workbench.attachments.read(input.id, input.attachmentId),
  );
  reg("workbench:discardAttachment", (input) =>
    core.workbench.attachments.discard(input.id, input.attachmentId),
  );
  reg("workbench:draftFiles", ({id}) => ({ attachments: core.workbench.attachments.manifest(id, core.drafts.get({kind:"workbench",id}).draft.attachmentIds) }));
  reg("draft:get", (input) => core.drafts.get(input));
  reg("draft:save", (input) => core.drafts.save(input, input.revision, input.patch));
  reg("draft:references", (input) => ({ references: core.drafts.references(input) }));
  reg("draft:moveChat", (input) => core.drafts.moveChat(input.taskId, input.revision));
  reg("workbench:send", (input) => core.db.transaction(() => {
    const result = core.workbench.send(input);
    if (result.accepted && input.draftRevision !== undefined) core.drafts.acknowledge({kind:"workbench",id:input.id}, input.draftRevision);
    return result;
  }));
  reg("workbench:resume", (input) => core.workbench.resume(input));
  reg("workbench:confirm", (input) =>
    core.workbench.confirm(input.id, input.roleIds),
  );
  reg("workbench:setEnabled", (input) =>
    core.workbench.setEnabled(input.id, input.roleId, input.enabled),
  );
  reg("workbench:stop", (input) => core.workbench.stop(input.id));
  reg("workbench:delete", (input) => core.workbench.remove(input.id));
  reg("workbench:propose", (input) => core.workbench.propose(input));
  reg("workbench:keepContract", (input) =>
    core.workbench.keepContract(input.id, input.contractId, input.revision),
  );
  reg("workbench:choose", (input) =>
    core.workbench.choose(input.id, input.proposalId, input.revision),
  );
  reg("workbench:finish", (input) =>
    core.workbench.finish(input.id, input.evidence, input.memoryIds, input.completionToken),
  );
  reg("completion:get", input => input.scope === "chat" ? core.tasks.completionReport(input.id) : core.workbench.completionReport(input.id));
  reg("workbench:review", (input) =>
    core.workbench.review(input.id, input.roleId, input.offset, input.limit),
  );
  reg("workbench:reviewFile", (input) =>
    core.workbench.reviewFile(input.id, input.roleId, input.token, input.path),
  );
  reg("workbench:preview", async input=>{
    const result=await core.workbench.preview(input.id,input.roleId,input.token,input.path,input.download);
    await artifactUI.openWorkbenchPreview?.(result.url);
    return result;
  });
  reg("workbench:openDocument", async input=>{
    const file=core.workbench.artifactFile(input.id,input.roleId,input.token,input.path);
    if(!/\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|pages|numbers|key|pdf|mp4|webm|mov|m4v|mp3|wav|m4a|ogg|png|jpe?g|gif|webp|avif)$/i.test(input.path))throw Error("此文件请使用成果预览或下载查看");
    if(!artifactUI.openWorkbenchDocument)throw Error("当前环境不支持系统文档预览，请下载原文件查看");
    await artifactUI.openWorkbenchDocument(file.path);return {ok:true};
  });
  reg("workbench:revealFile", input=>{
    const file=core.workbench.artifactFile(input.id,input.roleId,input.token,input.path);
    if(!artifactUI.revealWorkbenchFile)throw Error("当前环境不支持显示本地文件");
    artifactUI.revealWorkbenchFile(file.path);return {ok:true};
  });
  reg("workbench:repair", (input) => core.workbench.repair(input));
  reg("workbench:roleChangePreview", (input) =>
    core.workbench.roleChangePreview(
      input.id,
      input.roleId,
      input.targetRoleId,
    ),
  );
  reg("workbench:applyRoleChange", (input) =>
    core.workbench.applyRoleChange(input),
  );
  reg("task:roleChangePreview", (input) =>
    core.tasks.roleChangePreview(input.taskId, input.targetRoleId),
  );
  reg("task:applyRoleChange", (input) => core.tasks.applyRoleChange(input));
  reg("workbench:apply", (input) =>
    core.workbench.apply(input.id, input.roleId, input.reviewToken),
  );
  reg("task:create", (input) => core.tasks.createTask(input));
  reg("task:list", async () => ({ tasks: await core.tasks.listTasks() }));
  reg("task:get", async (input) => core.tasks.getTask(input.taskId, input.includeTranscript));
  reg("task:prompt", async (input) => {
    const result = await core.tasks.promptTask(input);
    if (result.accepted && input.draftRevision !== undefined) core.drafts.acknowledge({kind:"chat",id:input.taskId}, input.draftRevision);
    return result;
  });
  reg("task:steer", (input) => core.tasks.steerTask(input));
  reg("task:approvePlan", (input) =>
    core.tasks.approvePlan(input.taskId, input.revision),
  );
  reg("task:abort", (input) => core.tasks.abortTask(input.taskId));
  reg("approval:decide", (input) => core.tasks.decideApproval(input));

  // 角色
  reg("role:list", (input) => ({
    roles: core.roles.list(input.includeArchived ?? false),
  }));
  reg("role:create", (input) => core.roles.create(input));
  reg("role:update", (input) => {
    const role = core.roles.update(input.roleId, {
      name: input.name,
      intro: input.intro,
      systemPrompt: input.systemPrompt,
      boundSkills: input.boundSkills,
      boundPlugins: input.boundPlugins,
      preferredModel: input.preferredModel,
      preferredThinking: input.preferredThinking,
    });
    core.workbench.notifyRoleChange(input.roleId);
    return role;
  });
  reg("role:impact", (input) => {
    core.roles.get(input.roleId);
    const tasks = core.db
      .prepare(
        "SELECT id,title,status FROM tasks WHERE role_id=? AND workbench_owner IS NULL ORDER BY updated_at DESC",
      )
      .all(input.roleId) as { id: string; title: string; status: string }[];
    const workbenches = core.db
      .prepare(
        "SELECT DISTINCT w.id,json_extract(w.body,'$.title') title,json_extract(w.body,'$.phase') phase FROM workbenches w,json_each(w.body,'$.participants') p WHERE json_extract(p.value,'$.roleId')=? ORDER BY w.updated_at DESC",
      )
      .all(input.roleId) as { id: string; title: string; phase: string }[];
    return {
      tasks: tasks.slice(0, 100),
      workbenches: workbenches.slice(0, 100),
      total: tasks.length + workbenches.length,
    };
  });
  reg("role:archive", async (input) => {
    core.roles.archive(input.roleId, input.archived);
    if (input.archived) {
      await core.workbench.suspendRole(input.roleId);
      await core.tasks.suspendRole(input.roleId);
    }
    core.workbench.notifyRoleChange(input.roleId);
    return { ok: true };
  });
  reg("role:clone", (input) =>
    core.roles.clone(input.roleId, input.withMemory, input.name),
  );

  // 记忆
  reg("time-memory:attention", ()=>core.timeMemories.attention());
  reg("time-memory:list", input=>core.timeMemories.list(input.roleId));
  reg("time-memory:create", input=>core.timeMemories.create(input));
  reg("time-memory:setEnabled", input=>core.timeMemories.setEnabled(input.id,input.roleId,input.enabled));
  reg("time-memory:remove", input=>core.timeMemories.remove(input.id,input.roleId));
  reg("time-memory:run", input=>core.timeMemories.run(input.id,input.roleId));
  reg("memory:usage", (input) => {
    core.roles.get(input.roleId);
    return core.memory.usage.get(input.roleId, input.memoryId);
  });
  reg("memory:list", (input) =>
    core.memory.list({
      verification: input.verification,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      query: input.query,
      status: input.status,
      limit: input.limit,
      offset: input.offset,
    }),
  );
  reg("memory:write", (input) => {
    core.roles.get(input.scopeId ?? "");
    return core.memory.write({
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? "",
      title: input.title,
      content: input.content,
      summary: input.summary,
      tags: input.tags,
      category: input.category,
      appliesTo: input.appliesTo,
      projectId: input.projectId,
    });
  });
  reg("memory:revise", (input) =>
    core.memory.revise(input.memoryId, {
      title: input.title,
      content: input.content,
      reason: input.reason,
      expectedVersion: input.expectedVersion,
      category: input.category,
      appliesTo: input.appliesTo,
      projectId: input.projectId,
    }),
  );
  reg("memory:conflicts", (input) => ({
    items: core.memory.conflicts(input.memoryId),
  }));
  reg("memory:review", (input) => {
    const m = core.memory.review(input);
    core.router.emit("memory:changed", { scopeType: "role" });
    return m;
  });
  reg("memory:forget", (input) => {
    core.memory.forget(input.memoryId);
    core.router.emit("memory:changed", { scopeType: "unknown" });
    return { ok: true };
  });
  reg("memory:restore", (input) => {
    core.memory.restore(input.memoryId);
    core.router.emit("memory:changed", { scopeType: "unknown" });
    return { ok: true };
  });
  reg("memory:history", (input) => ({
    versions: core.memory.history(input.memoryId),
  }));

  // M3 多 Agent
  reg("task:answerQuestion", (input) =>
    core.tasks.answerQuestion(input.taskId, input.questionId, input.answer),
  );
  reg("task:getUsage", (input) => core.tasks.getUsage(input.taskId));
  reg("task:activityResult", (input) =>
    core.tasks.activityResult(input.taskId),
  );
  reg("task:listActivity", () => core.tasks.listActivity());
  reg("task:listAgents", (input) => core.tasks.listAgents(input.taskId));
  reg("task:getWorkspaceFiles", (input) =>
    core.tasks.getWorkspaceFiles(input.taskId),
  );

  // M4 市场 / 备份
  reg("market:list", () => core.market.listInstalled());
  reg("market:searchNpm", async (input) => ({
    items: await core.market.searchNpm(input.query),
  }));
  reg("market:cancelInstall", (input) => ({
    ok: core.installs.cancel(input.operationId),
  }));
  reg("market:installNpm", (input) =>
    core.installs.run(
      input.operationId,
      (signal) => core.market.installFromNpm(input.spec, signal),
      () => ({ ok: false, message: "已取消安装" }),
    ),
  );
  reg("market:installLocal", (input) => core.market.installLocal(input.path));
  reg("market:remove", (input) => core.market.remove(input.source));
  reg("market:setVisibility", (input) =>
    core.market.setVisibility(input.name, input.kind, input.visibility),
  );
  reg("market:listPi", (input) =>
    input.kind
      ? core.catalog.list("pi", input.kind, input.query)
      : core.market.listPiGallery(input.query),
  );
  reg("resource:listBindable", () => ({ items: core.market.listBindable() }));
  reg("market:listClaude", async (input) => {
    const items = await core.claude.list(input.query, input.kind);
    return { items, fallbackSource: items.length > 0 && items[0]!.fallback };
  });
  reg("market:claudeDetail", async (input) => ({
    content: await core.claude.detail(input.name, input.kind),
  }));
  reg("market:installClaude", (input) =>
    core.installs.run(
      input.operationId,
      (signal) =>
        input.as === "package"
          ? installClaudePackage(core, input.name, signal)
          : core.claude.install(input.name, signal),
      () => ({ ok: false, message: "已取消安装", files: [] }),
    ),
  );
  reg("backup:create", () => core.backup.create());
  // 系统浏览器打开令牌获取页等外链（仅 https，防任意协议）
  reg("sys:openExternal", (input) => {
    if (!/^https:\/\//.test(input.url)) return { ok: false };
    openExternal(input.url);
    return { ok: true };
  });
  reg("backup:list", () => ({ backups: core.backup.list() }));
  reg("backup:restore", (input) => core.backup.requestRestore(input.id));

  // M5 MCP / 上下文 / 模型 / 提示词
  reg("mcp:diagnostics", () => ({ items: core.mcpDiagnostics.list() }));
  reg("mcp:check", (input) => core.mcpDiagnostics.check(input.name));
  reg("mcp:list", () => ({ servers: core.mcp.list() }));
  reg("mcp:setResourcePolicy", input=>{core.workbench.assertResourcePolicyEditable();return {ok:core.mcp.setResourcePolicy(input.name,input.exclusive,input.resourceGroup)};});
  reg("mcp:add", (input) => core.mcp.add(input));
  reg("mcp:remove", (input) => ({ ok: core.mcp.remove(input.name) }));
  reg("mcp:setEnabled", (input) => ({
    ok: core.mcp.setEnabled(input.name, input.enabled),
  }));
  reg("mcp:setCredential", (input) =>
    core.mcp.setCredential(input.varName, input.value),
  );
  reg("mcp:clearCredential", (input) => ({
    ok: core.mcp.clearCredential(input.varName),
  }));
  reg("task:getContext", (input) => core.tasks.getContext(input.taskId));
  reg("task:getRoleContexts", (input) => ({
    roles: core.tasks.getRoleContexts(input.taskId),
  }));
  reg("task:compact", (input) =>
    core.tasks.compactTask(input.taskId, input.instructions),
  );
  reg("task:setModel", (input) =>
    core.tasks.setTaskModel(
      input.taskId,
      input.provider,
      input.modelId,
      input.auto,
    ),
  );
  reg("task:setThinking", (input) =>
    core.tasks.setTaskThinking(input.taskId, input.level),
  );
  reg("prompt:list", () => ({ prompts: core.tasks.listPromptTemplates() }));
  reg("task:captureReference", (input) =>
    core.tasks.captureReference(input.sourceTaskId),
  );
  reg("task:readOutput", (input) =>
    core.tasks.readOutput(
      input.taskId,
      input.outputId,
      input.offset,
      input.limit,
    ),
  );
  reg("task:getTree", (input) => core.tasks.getTree(input.taskId));
  reg("task:fork", (input) => core.tasks.forkTask(input.taskId, input.entryId));
  reg("market:authInfo", (input) => core.marketAuth.refresh(input.source));
  reg("market:authStart", (input) => core.marketAuth.start(input.source));
  reg("market:recommend", (input) =>
    core.catalog.recommend(input.source, input.kind),
  );
  reg("settings:setApproval", (input) => {
    core.tasks.setSettings({ autoApproveTools: input.autoApproveTools });
    return { ok: true };
  });

  reg("git:status", (input) => core.tasks.gitStatus(input.taskId));
  reg("git:diff", (input) =>
    core.tasks.gitDiff(input.taskId, input.paths, input.scope, input.commit),
  );
  reg("git:mutate", (input) => core.tasks.gitMutate(input.taskId, input));
  reg("task:delete", (input) => core.tasks.deleteTask(input.taskId));
}

export function buildHealthReport(core: HarnessCore): HealthReport {
  const steps: HealthReport["steps"] = [];

  const sqliteVersion = (
    core.db.prepare("SELECT sqlite_version() AS v").get() as { v: string }
  ).v;
  steps.push({ name: "sqlite", ok: true, detail: `SQLite ${sqliteVersion}` });

  const migrationsOk = core.db.version === latestMigrationVersion();
  steps.push({
    name: "migrations",
    ok: migrationsOk,
    detail: `schema v${core.db.version}（期望 v${latestMigrationVersion()}）`,
  });

  const logFile = core.logger.currentFile();
  const logOk = logFile !== "" && existsSync(logFile);
  steps.push({ name: "logger", ok: logOk, detail: logFile || "未配置文件" });

  const routerOk =
    core.router.has("dev:ping") &&
    core.router.has("task:prompt") &&
    core.router.has("role:list");
  steps.push({
    name: "router",
    ok: routerOk,
    detail: `${core.router.names().length} 个命令已注册`,
  });

  const defaultRole = core.roles.list().find((r) => r.isDefault);
  steps.push({
    name: "default-role",
    ok: Boolean(defaultRole),
    detail: defaultRole
      ? `${defaultRole.name}（记忆 ${defaultRole.memoryCount} 条）`
      : "默认角色缺失",
  });

  return {
    ok: steps.every((s) => s.ok),
    appVersion: core.appVersion,
    schemaVersion: core.db.version,
    dataDir: core.dataDir,
    logFile,
    uptimeMs: Date.now() - core.startedAt,
    steps,
  };
}
