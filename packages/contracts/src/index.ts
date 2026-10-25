import {timeMemoryCommands} from "./time-memory.js";
export * from "./time-memory.js";
import { draftCommands, DraftTarget } from "./drafts.js";
import { CompletionReport } from "./completion.js";
export * from "./completion.js";
export * from "./drafts.js";
import { workbenchCommands, RoleChangePreview } from "./workbench.js";
export * from "./workbench.js";
/**
 * Pi Harness IPC 契约：主进程与渲染进程共享的唯一事实源。
 *
 * - command：请求/响应（渲染 → 主，经 preload bridge）
 * - event：单向推送（主 → 渲染）
 * - 全部 schema 用 typebox 定义，与 pi 生态同源；
 *   主进程 MessageRouter 与渲染端均用本包做运行时校验。
 */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { TLocalizedValidationError } from "typebox/error";

/* ------------------------------------------------------------------ */
/* 基础 schema                                                         */
/* ------------------------------------------------------------------ */

export const HealthStep = Type.Object({
  name: Type.String(),
  ok: Type.Boolean(),
  detail: Type.Optional(Type.String()),
});

export const HealthReport = Type.Object({
  ok: Type.Boolean(),
  appVersion: Type.String(),
  schemaVersion: Type.Integer(),
  dataDir: Type.String(),
  logFile: Type.String(),
  uptimeMs: Type.Integer(),
  steps: Type.Array(HealthStep),
});
export type HealthReport = Static<typeof HealthReport>;
export type HealthStep = Static<typeof HealthStep>;

export const PingInput = Type.Object({
  echo: Type.String({ minLength: 1, maxLength: 200 }),
});

export const PingOutput = Type.Object({
  echo: Type.String(),
  pong: Type.Boolean(),
  ts: Type.Integer(),
});

export const SmokeReportInput = Type.Object({
  rendererBoot: Type.Boolean(),
  health: Type.Union([HealthReport, Type.Null()]),
  ping: Type.Optional(Type.Boolean()),
  faux: Type.Optional(
    Type.Object({
      ok: Type.Boolean(),
      textChars: Type.Integer({ minimum: 0 }),
      toolCalls: Type.Integer({ minimum: 0 }),
      roleUsed: Type.Optional(Type.Boolean()),
      memorySaved: Type.Optional(Type.Boolean()),
      error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  ),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const SmokeReportOutput = Type.Object({
  received: Type.Boolean(),
});

/* ------------------------------------------------------------------ */
/* M1：模型与提供商                                                     */
/* ------------------------------------------------------------------ */

export const ModelRef = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
});
export type ModelRef = Static<typeof ModelRef>;

export const ModelInfo = Type.Object({
  thinkingLevels: Type.Optional(Type.Array(Type.String())),
  id: Type.String(),
  name: Type.String(),
  api: Type.String(),
  provider: Type.String(),
  contextWindow: Type.Optional(Type.Integer()),
  reasoning: Type.Optional(Type.Boolean()),
  input: Type.Optional(Type.Array(Type.String())),
});
export type ModelInfo = Static<typeof ModelInfo>;

export const ProviderInfo = Type.Object({
  id: Type.String(),
  name: Type.String(),
  authConfigured: Type.Boolean(),
  authType: Type.Optional(Type.String()),
  requiresApiKey: Type.Optional(Type.Boolean()),
  /** 是否提供订阅 OAuth 登录 */
  oauthSupported: Type.Optional(Type.Boolean()),
  models: Type.Array(ModelInfo),
});
export type ProviderInfo = Static<typeof ProviderInfo>;

export const ConnectionTestResult = Type.Object({
  ok: Type.Boolean(),
  latencyMs: Type.Optional(Type.Integer()),
  message: Type.String(),
  usage: Type.Optional(
    Type.Object({ input: Type.Integer(), output: Type.Integer() }),
  ),
});
export type ConnectionTestResult = Static<typeof ConnectionTestResult>;

/* ------------------------------------------------------------------ */
/* M1：项目与任务                                                       */
/* ------------------------------------------------------------------ */

export const ProjectInfo = Type.Object({
  id: Type.String(),
  name: Type.String(),
  dir: Type.String(),
  createdAt: Type.Integer(),
});
export type ProjectInfo = Static<typeof ProjectInfo>;

export const TaskStatus = Type.Union([
  Type.Literal("draft"),
  Type.Literal("running"),
  Type.Literal("waiting_approval"),
  Type.Literal("waiting_recommend"),
  Type.Literal("waiting_user"),
  Type.Literal("done"),
  Type.Literal("error"),
  Type.Literal("cancelled"),
]);
export type TaskStatus = Static<typeof TaskStatus>;

/** 任务计划步骤（update_plan 工具维护，UI 实时展示） */
export const PlanStep = Type.Object({
  content: Type.String({ maxLength: 300 }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
  ]),
});
export type PlanStep = Static<typeof PlanStep>;

export const PlanState = Type.Object({
  revision: Type.String(),
  requiresApproval: Type.Boolean(),
  status: Type.Union([
    Type.Literal("draft"),
    Type.Literal("approved"),
    Type.Literal("paused"),
    Type.Literal("complete"),
  ]),
});
export type PlanState = Static<typeof PlanState>;

export const TaskRecovery = Type.Object({
  interruptedAt: Type.Integer(),
  previousStatus: TaskStatus,
  stage: Type.Optional(Type.String()),
});
export type TaskRecovery = Static<typeof TaskRecovery>;

/** Local end-of-reply checks, not semantic acceptance of the delivered work. */
export const TaskCompletion = Type.Object({
  checkedAt: Type.Integer(),
  outcome: Type.Union([Type.Literal("reply_ended"), Type.Literal("needs_attention")]),
  issues: Type.Array(Type.Object({
    code: Type.Union([Type.Literal("plan_pending"), Type.Literal("plan_approval"), Type.Literal("tool_failed"), Type.Literal("tool_pending"), Type.Literal("response_incomplete"), Type.Literal("agent_unresolved")]),
    message: Type.String({ maxLength: 300 }),
  }), { maxItems: 6 }),
});
export type TaskCompletion = Static<typeof TaskCompletion>;

export const TaskInfo = Type.Object({
  completion: Type.Optional(Type.Union([TaskCompletion, Type.Null()])),
  modelOverride: Type.Optional(Type.Union([ModelRef, Type.Null()])),
  thinkingOverride: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  recovery: Type.Optional(Type.Union([TaskRecovery, Type.Null()])),
  id: Type.String(),
  title: Type.String(),
  projectId: Type.Optional(Type.Union([ProjectInfo, Type.Null()])),
  dir: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  status: TaskStatus,
  mode: Type.Literal("single"),
  model: Type.Optional(Type.Union([ModelRef, Type.Null()])),
  roleId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  roleName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  roleSuccessorId: Type.Optional(Type.String()),
  systemPrompt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  plan: Type.Optional(Type.Union([Type.Array(PlanStep), Type.Null()])),
  planState: Type.Optional(Type.Union([PlanState, Type.Null()])),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
export type TaskInfo = Static<typeof TaskInfo>;

/** 附件：图片（base64 data）或文本引用（已展开进 prompt 的记录） */
export const Attachment = Type.Object({
  kind: Type.Union([Type.Literal("image"), Type.Literal("text")]),
  name: Type.String(),
  mimeType: Type.Optional(Type.String()),
  /** image: base64（不含 data: 前缀）；text: 文件内容全文 */
  data: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
});
export type Attachment = Static<typeof Attachment>;

/* ------------------------------------------------------------------ */
/* M1：对话转录（UI 快照模型）                                          */
/* ------------------------------------------------------------------ */

export const ToolCallInfo = Type.Object({
  id: Type.String(),
  name: Type.String(),
  args: Type.Optional(Type.Any()),
});
export type ToolCallInfo = Static<typeof ToolCallInfo>;

export const UsageInfo = Type.Object({
  input: Type.Optional(Type.Integer()),
  output: Type.Optional(Type.Integer()),
  cacheRead: Type.Optional(Type.Integer()),
  cacheWrite: Type.Optional(Type.Integer()),
  totalTokens: Type.Optional(Type.Integer()),
});
export type UsageInfo = Static<typeof UsageInfo>;

export const ConversationReference = Type.Object({
  id: Type.String(),
  sourceTaskId: Type.String(),
  title: Type.String(),
  capturedAt: Type.Integer(),
  text: Type.String(),
  omittedMessages: Type.Integer(),
  truncated: Type.Boolean(),
});
export type ConversationReference = Static<typeof ConversationReference>;

export const TranscriptMessage = Type.Object({
  id: Type.String(),
  entryId: Type.Optional(Type.String()),
  role: Type.Union([
    Type.Literal("user"),
    Type.Literal("assistant"),
    Type.Literal("toolResult"),
  ]),
  text: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  turnDurationMs: Type.Optional(Type.Integer()),
  turnOutcome: Type.Optional(
    Type.Union([
      Type.Literal("complete"),
      Type.Literal("failed"),
      Type.Literal("stopped"),
    ]),
  ),
  references: Type.Optional(Type.Array(ConversationReference)),
  outputId: Type.Optional(Type.String()),
  toolCalls: Type.Optional(Type.Array(ToolCallInfo)),
  /** toolResult 行 */
  toolCallId: Type.Optional(Type.String()),
  toolName: Type.Optional(Type.String()),
  isError: Type.Optional(Type.Boolean()),
  usage: Type.Optional(UsageInfo),
  timestamp: Type.Optional(Type.Integer()),
  attachments: Type.Optional(Type.Array(Attachment)),
  delivery: Type.Optional(
    Type.Union([
      Type.Literal("sending"),
      Type.Literal("sent"),
      Type.Literal("failed"),
    ]),
  ),
  /** M3 多 Agent：发言成员 */
  roleId: Type.Optional(Type.String()),
  roleName: Type.Optional(Type.String()),
  /** M3 团队：轮次 */
  round: Type.Optional(Type.Integer()),
  kind: Type.Optional(
    Type.Union([
      Type.Literal("statement"),
      Type.Literal("final"),
      Type.Literal("dispute"),
      Type.Literal("phase"),
    ]),
  ),
});
export type TranscriptMessage = Static<typeof TranscriptMessage>;

/** 单轮发送阶段与实测耗时，不携带提示词或凭据。 */
export const RunProgress = Type.Object({
  taskId: Type.String(),
  runId: Type.String(),
  stage: Type.Union([
    Type.Literal("accepted"),
    Type.Literal("git"),
    Type.Literal("resources"),
    Type.Literal("mcp"),
    Type.Literal("preparing"),
    Type.Literal("request"),
    Type.Literal("response"),
    Type.Literal("complete"),
    Type.Literal("failed"),
    Type.Literal("stopped"),
  ]),
  startedAt: Type.Integer(),
  updatedAt: Type.Integer(),
  elapsedMs: Type.Integer(),
  preparationMs: Type.Optional(Type.Integer()),
  firstResponseMs: Type.Optional(Type.Integer()),
  requestCount: Type.Optional(Type.Integer()),
  providerWaitMs: Type.Optional(Type.Integer()),
  thinkingMs: Type.Optional(Type.Integer()),
  toolExecutionMs: Type.Optional(Type.Integer()),
  stages: Type.Array(
    Type.Object({ stage: Type.String(), durationMs: Type.Integer() }),
  ),
});
export type RunProgress = Static<typeof RunProgress>;

/** Lightweight overview; full conversation is fetched only when requested. */
export const TaskActivity = Type.Object({
  completion: Type.Optional(Type.Union([TaskCompletion, Type.Null()])),
  id: Type.String(),
  title: Type.String(),
  status: TaskStatus,
  mode: Type.Literal("single"),
  projectName: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.Integer(),
  busy: Type.Boolean(),
  progress: Type.Union([RunProgress, Type.Null()]),
  recovery: Type.Union([TaskRecovery, Type.Null()]),
});
export type TaskActivity = Static<typeof TaskActivity>;

/* ------------------------------------------------------------------ */
/* M1：审批                                                             */
/* ------------------------------------------------------------------ */

export const ApprovalRequest = Type.Object({
  taskId: Type.String(),
  toolCallId: Type.String(),
  toolName: Type.String(),
  input: Type.Optional(Type.Any()),
  description: Type.Optional(Type.String()),
  summary: Type.Optional(Type.String()),
  effects: Type.Optional(Type.Array(Type.String())),
  /** 任务工作区：write/edit 相对路径的解析基准（多 Agent 成员各自身份） */
  cwd: Type.Optional(Type.String()),
});
export type ApprovalRequest = Static<typeof ApprovalRequest>;
export const TaskQuestion = Type.Object({
  taskId: Type.String(),
  questionId: Type.String(),
  question: Type.String(),
  options: Type.Array(
    Type.Object({
      label: Type.String(),
      description: Type.Optional(Type.String()),
    }),
    {
      minItems: 2,
      maxItems: 4,
    },
  ),
});
export type TaskQuestion = Static<typeof TaskQuestion>;

/* ------------------------------------------------------------------ */
/* M1：设置                                                             */
/* ------------------------------------------------------------------ */

export const PermissionMode = Type.Union([
  Type.Literal("ask"),
  Type.Literal("auto_edit"),
  Type.Literal("plan"),
  Type.Literal("bypass"),
]);
export type PermissionMode = Static<typeof PermissionMode>;

export const AgentLimits = Type.Object({
  maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, maximum: 6 })),
  maxMembers: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
});
export type AgentLimits = Static<typeof AgentLimits>;
export const AgentRun = Type.Object({
  id: Type.String(),
  taskId: Type.String(),
  roleId: Type.String(),
  roleName: Type.String(),
  title: Type.String(),
  nodeId: Type.Optional(Type.String()),
  cwd: Type.String(),
  status: Type.Union([
    Type.Literal("queued"),
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("waiting_approval"),
    Type.Literal("done"),
    Type.Literal("error"),
    Type.Literal("cancelled"),
    Type.Literal("interrupted"),
  ]),
  startedAt: Type.Integer(),
  updatedAt: Type.Integer(),
  tokens: Type.Integer(),
  costUSD: Type.Number(),
  result: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
export type AgentRun = Static<typeof AgentRun>;

export const AppSettings = Type.Object({
  agentLimits: Type.Optional(AgentLimits),
  defaultModel: Type.Optional(Type.Union([ModelRef, Type.Null()])),
  autoApproveTools: Type.Array(Type.String()),
  /** 回合后自动记忆：在系统提示词中加入主动记忆指令 */
  autoMemory: Type.Optional(Type.Boolean()),
  /** bash 沙箱档位（macOS Seatbelt；off=关闭，read_only=全盘只读，workspace_write=仅工作区与临时目录可写） */
  sandboxMode: Type.Optional(
    Type.Union([
      Type.Literal("off"),
      Type.Literal("read_only"),
      Type.Literal("workspace_write"),
    ]),
  ),
  /** 工具权限模式：ask=写入/执行逐项审批（默认）；auto_edit=文件读写免审、bash 仍审；plan=只读探索（写/执行直接拦截）；bypass=全部放行 */
  permissionMode: Type.Optional(PermissionMode),
});
export type AppSettings = Static<typeof AppSettings>;

/* ------------------------------------------------------------------ */
/* M2：角色卡                                                           */
/* ------------------------------------------------------------------ */

export const RoleInfo = Type.Object({
  id: Type.String(),
  name: Type.String(),
  intro: Type.String(),
  systemPrompt: Type.String(),
  boundSkills: Type.Array(Type.String()),
  boundPlugins: Type.Array(Type.String()),
  preferredModel: Type.Optional(Type.Union([ModelRef, Type.Null()])),
  preferredThinking: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  isDefault: Type.Boolean(),
  status: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
  memoryCount: Type.Integer(),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
export type RoleInfo = Static<typeof RoleInfo>;

/* ------------------------------------------------------------------ */
/* M2：记忆                                                             */
/* ------------------------------------------------------------------ */

export const MemoryCategory = Type.Union([
  Type.Literal("experience"),
  Type.Literal("preference"),
]);
export const MemoryQuality = Type.Object({
  category: MemoryCategory,
  appliesTo: Type.String(),
  projectId: Type.Union([Type.String(), Type.Null()]),
  verification: Type.Union([
    Type.Literal("pending"),
    Type.Literal("confirmed"),
    Type.Literal("verified"),
    Type.Literal("legacy"),
  ]),
  source: Type.Union([
    Type.Literal("builtin"),
    Type.Literal("manual"),
    Type.Literal("agent"),
    Type.Literal("workbench"),
    Type.Literal("legacy"),
  ]),
  evidence: Type.String(),
  note: Type.String(),
});
export type MemoryQuality = Static<typeof MemoryQuality>;
export const MemoryDetails = {
  category: Type.Optional(MemoryCategory),
  appliesTo: Type.Optional(Type.String({ maxLength: 300 })),
  projectId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
};
export const MemoryInfo = Type.Object({
  id: Type.String(),
  scopeType: Type.Union([
    Type.Literal("user"),
    Type.Literal("role"),
    Type.Literal("project"),
  ]),
  scopeId: Type.String(),
  scopeLabel: Type.String(),
  title: Type.String(),
  content: Type.String(),
  summary: Type.String(),
  tags: Type.Array(Type.String()),
  status: Type.Union([Type.Literal("active"), Type.Literal("forgotten")]),
  sourceTaskId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sourceDeleted: Type.Optional(Type.Boolean()),
  sourceWorkbenchId: Type.Optional(Type.String()),
  quality: Type.Optional(MemoryQuality),
  version: Type.Integer(),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
export type MemoryInfo = Static<typeof MemoryInfo>;

export const MemoryUsageInfo = Type.Object({
  roleId: Type.String(), observedSince: Type.Integer(),
  summary: Type.Object({ total: Type.Integer(), automaticTotal: Type.Integer(),
    automaticRetained: Type.Integer(), automaticPending: Type.Integer(), automaticForgotten: Type.Integer(),
    automaticRevised: Type.Integer(), referencedMemories: Type.Integer() }),
  memoryId: Type.Union([Type.String(),Type.Null()]), referenceTotal: Type.Integer(),
  references: Type.Array(Type.Object({ version: Type.Integer(),
    taskId: Type.Union([Type.String(),Type.Null()]), workbenchId: Type.Union([Type.String(),Type.Null()]),
    title: Type.String(), stage: Type.Union([Type.Literal("routing"),Type.Literal("planning"),Type.Literal("execution")]),
    firstAt: Type.Integer(), lastAt: Type.Integer(), subsequent: Type.Boolean() })),
});
export type MemoryUsageInfo = Static<typeof MemoryUsageInfo>;

export const MemoryVersionInfo = Type.Object({
  quality: Type.Optional(MemoryQuality),
  ver: Type.Integer(),
  title: Type.String(),
  content: Type.String(),
  reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  createdAt: Type.Integer(),
});
export type MemoryVersionInfo = Static<typeof MemoryVersionInfo>;

/* ------------------------------------------------------------------ */
/* M2：检查点                                                           */
/* ------------------------------------------------------------------ */

export const CheckpointInfo = Type.Object({
  id: Type.String(),
  taskId: Type.String(),
  seq: Type.Integer(),
  tool: Type.String(),
  args: Type.Optional(Type.Any()),
  files: Type.Array(
    Type.Object({ path: Type.String(), backupPath: Type.String() }),
  ),
  createdAt: Type.Integer(),
});
export type CheckpointInfo = Static<typeof CheckpointInfo>;

export const GitFile = Type.Object({
  path: Type.String(),
  status: Type.String(),
  staged: Type.Boolean(),
  tracked: Type.Boolean(),
  conflicted: Type.Boolean(),
});
export const GitStatus = Type.Object({
  available: Type.Boolean(),
  repository: Type.Boolean(),
  root: Type.Union([Type.String(), Type.Null()]),
  branch: Type.Union([Type.String(), Type.Null()]),
  head: Type.Union([Type.String(), Type.Null()]),
  files: Type.Array(GitFile),
  branches: Type.Array(Type.String()),
  commits: Type.Array(
    Type.Object({
      id: Type.String(),
      message: Type.String(),
      timestamp: Type.Integer(),
    }),
  ),
  message: Type.Optional(Type.String()),
});
export type GitStatus = Static<typeof GitStatus>;
export const GitDiff = Type.Object({
  text: Type.String(),
  version: Type.String(),
  truncated: Type.Boolean(),
});
export type GitDiff = Static<typeof GitDiff>;
export const GitAction = Type.Object({
  action: Type.Union([
    Type.Literal("init"),
    Type.Literal("stage"),
    Type.Literal("unstage"),
    Type.Literal("discard"),
    Type.Literal("commit"),
    Type.Literal("create_branch"),
    Type.Literal("switch_branch"),
  ]),
  paths: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), { maxItems: 200 }),
  ),
  version: Type.Optional(Type.String()),
  message: Type.Optional(Type.String({ maxLength: 1000 })),
  branch: Type.Optional(Type.String({ maxLength: 200 })),
});
export type GitAction = Static<typeof GitAction>;

/* ------------------------------------------------------------------ */
/* M2：登录流                                                           */
/* ------------------------------------------------------------------ */

export const LoginEventPayload = Type.Object({
  flowId: Type.String(),
  kind: Type.Union([
    Type.Literal("url"),
    Type.Literal("device_code"),
    Type.Literal("prompt"),
    Type.Literal("info"),
    Type.Literal("progress"),
    Type.Literal("done"),
    Type.Literal("error"),
  ]),
  url: Type.Optional(Type.String()),
  userCode: Type.Optional(Type.String()),
  verificationUri: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  promptId: Type.Optional(Type.String()),
  promptText: Type.Optional(Type.String()),
  options: Type.Optional(
    Type.Array(Type.Object({ id: Type.String(), label: Type.String() })),
  ),
});
export type LoginEventPayload = Static<typeof LoginEventPayload>;

/* ------------------------------------------------------------------ */
/* M4：市场 / 备份 / 导出 / 工作区                                       */
/* ------------------------------------------------------------------ */

export const InstalledPackageInfo = Type.Object({
  source: Type.String(),
  scope: Type.String(),
  installedPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  visibility: Type.Optional(
    Type.Union([Type.Literal("public"), Type.Literal("private")]),
  ),
  /** 基础能力插件：单独分区展示，服务端禁止移除与设为私有 */
  core: Type.Optional(Type.Boolean()),
  /** 基础能力插件的简洁介绍 */
  intro: Type.Optional(Type.String()),
});
export type InstalledPackageInfo = Static<typeof InstalledPackageInfo>;

export const InstalledSkillInfo = Type.Object({
  name: Type.String(),
  source: Type.String(),
  visibility: Type.Union([Type.Literal("public"), Type.Literal("private")]),
});
export type InstalledSkillInfo = Static<typeof InstalledSkillInfo>;

export const NpmSearchItem = Type.Object({
  name: Type.String(),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  version: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  publisher: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  date: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type NpmSearchItem = Static<typeof NpmSearchItem>;

export const BackupInfo = Type.Object({
  id: Type.String(),
  createdAt: Type.Integer(),
  path: Type.String(),
  sizeBytes: Type.Optional(Type.Integer()),
});
export type BackupInfo = Static<typeof BackupInfo>;

export const WorkspaceFileInfo = Type.Object({
  relPath: Type.String(),
  sizeBytes: Type.Integer(),
});
export type WorkspaceFileInfo = Static<typeof WorkspaceFileInfo>;

/* ------------------------------------------------------------------ */
/* M5：MCP / 上下文 / 模型切换 / 提示词模板                                */
/* ------------------------------------------------------------------ */

export const McpServerInfo = Type.Object({
  exclusive: Type.Optional(Type.Boolean()),
  resourceGroup: Type.Optional(Type.String()),
  name: Type.String(),
  kind: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
  command: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  args: Type.Optional(Type.Array(Type.String())),
  url: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  enabled: Type.Boolean(),
  /** 配置里检测到的 ${VAR} 令牌占位符（如 GITHUB_PERSONAL_ACCESS_TOKEN） */
  authVars: Type.Optional(Type.Array(Type.String())),
  /** 尚未配置取值的占位符（需认证） */
  missingVars: Type.Optional(Type.Array(Type.String())),
});
export type McpServerInfo = Static<typeof McpServerInfo>;

export const McpDiagnostic = Type.Object({
  name: Type.String(),
  kind: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
  state: Type.Union([
    Type.Literal("unchecked"),
    Type.Literal("checking"),
    Type.Literal("ready"),
    Type.Literal("required"),
    Type.Literal("unavailable"),
    Type.Literal("disabled"),
  ]),
  message: Type.String(),
  checkedAt: Type.Union([Type.Number(), Type.Null()]),
  toolCount: Type.Union([Type.Integer(), Type.Null()]),
});
export type McpDiagnostic = Static<typeof McpDiagnostic>;

export const InputBreakdown = Type.Object({
  systemTokens: Type.Integer(),
  historyTokens: Type.Integer(),
  toolResultTokens: Type.Integer(),
  /** Already included in systemTokens; do not add it again. */
  toolDefinitionTokens: Type.Integer(),
  activeToolCount: Type.Integer(),
  prefixHash: Type.Optional(Type.String()),
});
export const ContextInfo = Type.Object({
  inputBreakdown: Type.Optional(InputBreakdown),
  currentTokens: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  source: Type.Optional(
    Type.Union([Type.Literal("estimate"), Type.Literal("unknown")]),
  ),
  compacting: Type.Optional(Type.Boolean()),
  compactionStartedAt: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  lastCompactedAt: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  thresholdTokens: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  trimmedOutputs: Type.Optional(Type.Integer()),
  /** 最近一次请求的真实回执（未知为 null） */
  lastRequestTokens: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  contextWindow: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  percent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  cacheRead: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  cacheWrite: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  cacheHitPercent: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  note: Type.Optional(Type.String()),
});
export type ContextInfo = Static<typeof ContextInfo>;

export const RoleContextInfo = Type.Object({
  roleId: Type.Union([Type.String(), Type.Null()]),
  roleName: Type.String(),
  kind: Type.Literal("single"),
  context: ContextInfo,
});
export type RoleContextInfo = Static<typeof RoleContextInfo>;

export const PromptTemplateInfo = Type.Object({
  name: Type.String(),
  description: Type.String(),
  argumentHint: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type PromptTemplateInfo = Static<typeof PromptTemplateInfo>;

/* ------------------------------------------------------------------ */
/* 命令注册表                                                          */
/* ------------------------------------------------------------------ */

export const MarketOrigin = Type.Union([
  Type.Literal("pi"),
  Type.Literal("claude"),
]);
export const MarketKind = Type.Union([
  Type.Literal("plugins"),
  Type.Literal("skills"),
]);
export const CatalogItem = Type.Object({
  name: Type.String(),
  source: Type.String(),
  origin: MarketOrigin,
  description: Type.Union([Type.String(), Type.Null()]),
  downloads: Type.Union([Type.Integer(), Type.Null()]),
  popularity: Type.Optional(Type.Number()),
  resourceKinds: Type.Array(MarketKind),
  installable: Type.Boolean(),
  compatibility: Type.Optional(Type.String()),
  auth: Type.Optional(
    Type.Union([
      Type.Literal("token"),
      Type.Literal("lark"),
      Type.Literal("oauth"),
    ]),
  ),
  reasons: Type.Optional(Type.Array(Type.String())),
});
export type CatalogItem = Static<typeof CatalogItem>;
export const MarketAuthInfo = Type.Object({
  source: Type.String(),
  kind: Type.Union([
    Type.Literal("none"),
    Type.Literal("token"),
    Type.Literal("lark"),
    Type.Literal("oauth"),
  ]),
  status: Type.Union([
    Type.Literal("required"),
    Type.Literal("ready"),
    Type.Literal("working"),
    Type.Literal("error"),
  ]),
  message: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  verificationCode: Type.Optional(
    Type.String({ pattern: "^[A-Z0-9]{4}-[A-Z0-9]{4}$" }),
  ),
  servers: Type.Array(McpServerInfo),
});
export type MarketAuthInfo = Static<typeof MarketAuthInfo>;

export const commandSchemas = {
  ...timeMemoryCommands,
  ...workbenchCommands,
  "completion:get": {
    input: Type.Object({ scope: Type.Union([Type.Literal("chat"), Type.Literal("workbench")]), id: Type.String({minLength:1,maxLength:200}) }),
    output: CompletionReport,
  },
  ...draftCommands,
  "draft:references": { input: DraftTarget, output: Type.Object({ references: Type.Array(ConversationReference) }) },
  "dev:ping": { input: PingInput, output: PingOutput },
  "health:get": { input: Type.Object({}), output: HealthReport },
  "smoke:report": { input: SmokeReportInput, output: SmokeReportOutput },

  // M1 模型
  "model:list": {
    input: Type.Object({}),
    output: Type.Object({ providers: Type.Array(ProviderInfo) }),
  },
  "model:setApiKey": {
    input: Type.Object({
      provider: Type.String({ minLength: 1 }),
      apiKey: Type.String({ minLength: 1 }),
    }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "model:removeApiKey": {
    input: Type.Object({ provider: Type.String({ minLength: 1 }) }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "model:testConnection": {
    input: Type.Object({ provider: Type.String(), modelId: Type.String() }),
    output: ConnectionTestResult,
  },

  // M1 设置
  "settings:get": { input: Type.Object({}), output: AppSettings },
  "settings:set": { input: AppSettings, output: AppSettings },

  // M1 项目
  "project:list": {
    input: Type.Object({}),
    output: Type.Object({ projects: Type.Array(ProjectInfo) }),
  },
  "project:add": {
    input: Type.Object({ dir: Type.String({ minLength: 1 }) }),
    output: ProjectInfo,
  },
  "project:pickFolder": {
    input: Type.Object({}),
    output: Type.Object({ dir: Type.Union([Type.String(), Type.Null()]) }),
  },

  // M1 任务
  "task:roleChangePreview": {
    input: Type.Object({
      taskId: Type.String(),
      targetRoleId: Type.Optional(Type.String()),
    }),
    output: RoleChangePreview,
  },
  "task:applyRoleChange": {
    input: Type.Object({
      taskId: Type.String(),
      targetRoleId: Type.String(),
      token: Type.String(),
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
      confirmed: Type.Literal(true),
    }),
    output: TaskInfo,
  },
  "role:impact": {
    input: Type.Object({ roleId: Type.String() }),
    output: Type.Object({
      tasks: Type.Array(
        Type.Object({
          id: Type.String(),
          title: Type.String(),
          status: Type.String(),
        }),
      ),
      workbenches: Type.Array(
        Type.Object({
          id: Type.String(),
          title: Type.String(),
          phase: Type.String(),
        }),
      ),
      total: Type.Integer(),
    }),
  },
  "task:create": {
    input: Type.Object({
      projectId: Type.Optional(Type.String()),
      title: Type.Optional(Type.String({ maxLength: 200 })),
      model: Type.Optional(ModelRef),
      thinkingLevel: Type.Optional(Type.String()),
      roleId: Type.Optional(Type.String()),
      mode: Type.Optional(Type.Literal("single")),
    }),
    output: TaskInfo,
  },
  "task:list": {
    input: Type.Object({}),
    output: Type.Object({ tasks: Type.Array(TaskInfo) }),
  },
  "task:get": {
    input: Type.Object({ taskId: Type.String() }),
    output: Type.Object({
      task: TaskInfo,
      transcript: Type.Array(TranscriptMessage),
      progress: Type.Optional(Type.Union([RunProgress, Type.Null()])),
      pendingApprovals: Type.Optional(Type.Array(ApprovalRequest)),
      question: Type.Optional(Type.Union([TaskQuestion, Type.Null()])),
    }),
  },
  "task:captureReference": {
    input: Type.Object({ sourceTaskId: Type.String() }),
    output: ConversationReference,
  },
  "task:readOutput": {
    input: Type.Object({
      taskId: Type.String(),
      outputId: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20000 })),
    }),
    output: Type.Object({
      text: Type.String(),
      offset: Type.Integer(),
      nextOffset: Type.Union([Type.Integer(), Type.Null()]),
      totalChars: Type.Integer(),
    }),
  },
  "task:prompt": {
    input: Type.Object({
      draftRevision: Type.Optional(Type.Integer({minimum:0})),
      taskId: Type.String(),
      referenceIds: Type.Optional(Type.Array(Type.String(), { maxItems: 3 })),
      text: Type.String({ minLength: 1, maxLength: 100_000 }),
      images: Type.Optional(
        Type.Array(
          Type.Object({ data: Type.String(), mimeType: Type.String() }),
        ),
      ),
    }),
    output: Type.Object({ accepted: Type.Boolean() }),
  },
  "task:approvePlan": {
    input: Type.Object({ taskId: Type.String(), revision: Type.String() }),
    output: Type.Object({ accepted: Type.Boolean() }),
  },
  "task:steer": {
    input: Type.Object({
      taskId: Type.String(),
      text: Type.String({ minLength: 1 }),
    }),
    output: Type.Object({ disposition: Type.String() }),
  },
  "task:abort": {
    input: Type.Object({ taskId: Type.String() }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "approval:decide": {
    input: Type.Object({
      taskId: Type.String(),
      toolCallId: Type.String(),
      approved: Type.Boolean(),
      reason: Type.Optional(Type.String()),
    }),
    output: Type.Object({ ok: Type.Boolean() }),
  },

  // M2 角色
  "role:list": {
    input: Type.Object({ includeArchived: Type.Optional(Type.Boolean()) }),
    output: Type.Object({ roles: Type.Array(RoleInfo) }),
  },
  "role:create": {
    input: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 80 }),
      intro: Type.Optional(Type.String({ maxLength: 2000 })),
      systemPrompt: Type.Optional(Type.String({ maxLength: 24_000 })),
      boundSkills: Type.Optional(Type.Array(Type.String())),
      boundPlugins: Type.Optional(Type.Array(Type.String())),
      preferredModel: Type.Optional(Type.Union([ModelRef, Type.Null()])),
      preferredThinking: Type.Optional(
        Type.Union([Type.String(), Type.Null()]),
      ),
    }),
    output: RoleInfo,
  },
  "role:update": {
    input: Type.Object({
      roleId: Type.String(),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      intro: Type.Optional(Type.String({ maxLength: 2000 })),
      systemPrompt: Type.Optional(Type.String({ maxLength: 24_000 })),
      boundSkills: Type.Optional(Type.Array(Type.String())),
      boundPlugins: Type.Optional(Type.Array(Type.String())),
      preferredModel: Type.Optional(Type.Union([ModelRef, Type.Null()])),
      preferredThinking: Type.Optional(
        Type.Union([Type.String(), Type.Null()]),
      ),
    }),
    output: RoleInfo,
  },
  "role:archive": {
    input: Type.Object({ roleId: Type.String(), archived: Type.Boolean() }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "role:clone": {
    input: Type.Object({
      roleId: Type.String(),
      withMemory: Type.Boolean(),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    }),
    output: RoleInfo,
  },

  // M2 记忆
  "memory:usage": {
    input: Type.Object({ roleId: Type.String(), memoryId: Type.Optional(Type.String()) }),
    output: MemoryUsageInfo,
  },
  "memory:list": {
    input: Type.Object({
      verification: Type.Optional(
        Type.Union([
          Type.Literal("all"),
          Type.Literal("pending"),
          Type.Literal("ready"),
        ]),
      ),
      scopeType: Type.Optional(Type.Literal("role")),
      scopeId: Type.Optional(Type.String()),
      query: Type.Optional(Type.String()),
      status: Type.Optional(
        Type.Union([
          Type.Literal("active"),
          Type.Literal("forgotten"),
          Type.Literal("all"),
        ]),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    output: Type.Object({
      items: Type.Array(MemoryInfo),
      total: Type.Integer(),
    }),
  },
  "memory:write": {
    input: Type.Object({
      scopeType: Type.Literal("role"),
      scopeId: Type.Optional(Type.String()),
      title: Type.String({ minLength: 1, maxLength: 200 }),
      content: Type.String({ minLength: 1, maxLength: 20_000 }),
      summary: Type.Optional(Type.String({ maxLength: 500 })),
      tags: Type.Optional(Type.Array(Type.String())),
      ...MemoryDetails,
    }),
    output: MemoryInfo,
  },
  "memory:revise": {
    input: Type.Object({
      memoryId: Type.String(),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
      reason: Type.Optional(Type.String({ maxLength: 500 })),
      expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
      ...MemoryDetails,
    }),
    output: MemoryInfo,
  },
  "memory:conflicts": {
    input: Type.Object({ memoryId: Type.String() }),
    output: Type.Object({ items: Type.Array(MemoryInfo) }),
  },
  "memory:review": {
    input: Type.Object({
      memoryId: Type.String(),
      expectedVersion: Type.Integer({ minimum: 1 }),
      decision: Type.Union([
        Type.Literal("accept"),
        Type.Literal("replace"),
        Type.Literal("discard"),
      ]),
      conflicts: Type.Array(
        Type.Object({
          id: Type.String(),
          version: Type.Integer({ minimum: 1 }),
        }),
      ),
      evidence: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    output: MemoryInfo,
  },
  "memory:forget": {
    input: Type.Object({ memoryId: Type.String() }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "memory:restore": {
    input: Type.Object({ memoryId: Type.String() }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "memory:history": {
    input: Type.Object({ memoryId: Type.String() }),
    output: Type.Object({ versions: Type.Array(MemoryVersionInfo) }),
  },

  // Project version management uses the installed Git; no automatic file snapshots.
  "git:status": {
    input: Type.Object({ taskId: Type.String() }),
    output: GitStatus,
  },
  "git:diff": {
    input: Type.Object({
      taskId: Type.String(),
      paths: Type.Array(Type.String(), { maxItems: 200 }),
      scope: Type.Optional(
        Type.Union([
          Type.Literal("working"),
          Type.Literal("staged"),
          Type.Literal("all"),
        ]),
      ),
      commit: Type.Optional(Type.String()),
    }),
    output: GitDiff,
  },
  "git:mutate": {
    input: Type.Intersect([Type.Object({ taskId: Type.String() }), GitAction]),
    output: GitStatus,
  },
  "task:delete": {
    input: Type.Object({ taskId: Type.String() }),
    output: Type.Object({ ok: Type.Boolean() }),
  },

  // M2 登录流（订阅 OAuth）
  "model:login": {
    input: Type.Object({ provider: Type.String({ minLength: 1 }) }),
    output: Type.Object({ flowId: Type.String() }),
  },
  "model:loginAnswer": {
    input: Type.Object({ flowId: Type.String(), answer: Type.String() }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "model:loginCancel": {
    input: Type.Object({ flowId: Type.String() }),
    output: Type.Object({ ok: Type.Boolean() }),
  },

  "task:answerQuestion": {
    input: Type.Object({
      taskId: Type.String(),
      questionId: Type.String(),
      answer: Type.String({ minLength: 1, maxLength: 4000 }),
    }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "task:getUsage": {
    input: Type.Object({ taskId: Type.String() }),
    output: Type.Object({
      byRole: Type.Array(
        Type.Object({
          roleId: Type.Union([Type.String(), Type.Null()]),
          roleName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          input: Type.Integer(),
          output: Type.Integer(),
          cacheRead: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
          cacheWrite: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
          calls: Type.Integer(),
        }),
      ),
      total: Type.Object({
        input: Type.Integer(),
        output: Type.Integer(),
        calls: Type.Integer(),
      }),
    }),
  },
  "task:activityResult": {
    input: Type.Object({ taskId: Type.String() }),
    output: Type.Object({ text: Type.String(), truncated: Type.Boolean() }),
  },
  "task:listActivity": {
    input: Type.Object({}),
    output: Type.Object({ items: Type.Array(TaskActivity) }),
  },
  "task:listAgents": {
    input: Type.Object({ taskId: Type.String() }),
    output: Type.Object({ agents: Type.Array(AgentRun) }),
  },
  "market:list": {
    input: Type.Object({}),
    output: Type.Object({
      packages: Type.Array(InstalledPackageInfo),
      localSkills: Type.Array(InstalledSkillInfo),
      localExtensions: Type.Array(Type.String()),
    }),
  },
  "market:setVisibility": {
    input: Type.Object({
      name: Type.String({ minLength: 1 }),
      kind: Type.Union([Type.Literal("skill"), Type.Literal("package")]),
      visibility: Type.Union([Type.Literal("public"), Type.Literal("private")]),
    }),
    output: Type.Object({
      ok: Type.Boolean(),
      message: Type.Optional(Type.String()),
    }),
  },
  "resource:listBindable": {
    input: Type.Object({}),
    output: Type.Object({
      items: Type.Array(
        Type.Object({
          name: Type.String(),
          kind: Type.Union([Type.Literal("skill"), Type.Literal("package")]),
        }),
      ),
    }),
  },
  "market:listPi": {
    input: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 200 })),
      kind: Type.Optional(MarketKind),
    }),
    output: Type.Object({
      items: Type.Array(
        Type.Object({
          source: Type.String(),
          name: Type.String(),
          description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          /** npm 近 30 天下载量（git 源或接口不可用时为 null） */
          downloads: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        }),
      ),
      note: Type.Optional(Type.String()),
    }),
  },
  "market:searchNpm": {
    input: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 200 }),
    }),
    output: Type.Object({ items: Type.Array(NpmSearchItem) }),
  },
  "market:installNpm": {
    input: Type.Object({
      spec: Type.String({ minLength: 1, maxLength: 300 }),
      operationId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    }),
    output: Type.Object({
      ok: Type.Boolean(),
      message: Type.Optional(Type.String()),
    }),
  },
  "market:cancelInstall": {
    input: Type.Object({
      operationId: Type.String({ minLength: 1, maxLength: 100 }),
    }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "market:installLocal": {
    input: Type.Object({ path: Type.String({ minLength: 1 }) }),
    output: Type.Object({
      ok: Type.Boolean(),
      message: Type.Optional(Type.String()),
    }),
  },
  "market:remove": {
    input: Type.Object({ source: Type.String({ minLength: 1 }) }),
    output: Type.Object({
      ok: Type.Boolean(),
      message: Type.Optional(Type.String()),
    }),
  },
  "market:pickLocal": {
    input: Type.Object({}),
    output: Type.Object({ path: Type.Union([Type.String(), Type.Null()]) }),
  },

  // M6 Claude 技能源
  "market:listClaude": {
    input: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 200 })),
      kind: Type.Optional(MarketKind),
    }),
    output: Type.Object({
      items: Type.Array(
        Type.Object({
          name: Type.String(),
          description: Type.String(),
          license: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          fileCount: Type.Integer(),
          kind: Type.Optional(Type.String()),
          sourceLabel: Type.Optional(Type.String()),
          installable: Type.Optional(Type.Boolean()),
          compatibility: Type.Optional(Type.String()),
          fallback: Type.Boolean(),
        }),
      ),
      fallbackSource: Type.Boolean(),
    }),
  },
  "market:claudeDetail": {
    input: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 100 }),
      kind: Type.Optional(MarketKind),
    }),
    output: Type.Object({ content: Type.String() }),
  },
  "market:installClaude": {
    input: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 100 }),
      operationId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      /** skill=装入技能目录（默认）；package=包装为 pi 本地包（以插件安装） */
      as: Type.Optional(
        Type.Union([Type.Literal("skill"), Type.Literal("package")]),
      ),
    }),
    output: Type.Object({
      ok: Type.Boolean(),
      message: Type.String(),
      files: Type.Array(Type.String()),
    }),
  },

  // M4 备份 / 导出 / 工作区
  "backup:create": {
    input: Type.Object({}),
    output: BackupInfo,
  },
  "sys:openExternal": {
    input: Type.Object({ url: Type.String() }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "backup:list": {
    input: Type.Object({}),
    output: Type.Object({ backups: Type.Array(BackupInfo) }),
  },
  "backup:restore": {
    input: Type.Object({ id: Type.String() }),
    output: Type.Object({ ok: Type.Boolean(), message: Type.String() }),
  },
  "diag:export": {
    input: Type.Object({}),
    output: Type.Object({
      ok: Type.Boolean(),
      path: Type.Union([Type.String(), Type.Null()]),
    }),
  },
  "task:getWorkspaceFiles": {
    input: Type.Object({ taskId: Type.String() }),
    output: Type.Object({
      files: Type.Array(WorkspaceFileInfo),
      root: Type.String(),
    }),
  },
  "app:restart": {
    input: Type.Object({}),
    output: Type.Object({ ok: Type.Boolean() }),
  },

  // M5 MCP
  "mcp:diagnostics": {
    input: Type.Object({}),
    output: Type.Object({ items: Type.Array(McpDiagnostic) }),
  },
  "mcp:check": {
    input: Type.Object({ name: Type.String() }),
    output: McpDiagnostic,
  },
  "mcp:list": {
    input: Type.Object({}),
    output: Type.Object({ servers: Type.Array(McpServerInfo) }),
  },
  "mcp:add": {
    input: Type.Object({
      name: Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: "^[A-Za-z0-9_-]+$",
      }),
      command: Type.Optional(Type.String({ minLength: 1 })),
      args: Type.Optional(Type.Array(Type.String())),
      url: Type.Optional(Type.String({ minLength: 8 })),
      env: Type.Optional(Type.Record(Type.String(), Type.String())),
      /** http 型自定义请求头（如 Authorization: Bearer ${TOKEN}，环境变量经 pi 解析） */
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      description: Type.Optional(Type.String({ maxLength: 300 })),
    }),
    output: McpServerInfo,
  },
  "mcp:remove": {
    input: Type.Object({ name: Type.String() }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "mcp:setEnabled": {
    input: Type.Object({ name: Type.String(), enabled: Type.Boolean() }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "mcp:setResourcePolicy": {
    input: Type.Object({name:Type.String(),exclusive:Type.Boolean(),resourceGroup:Type.String({maxLength:64,pattern:"^[A-Za-z0-9_-]*$"})}),
    output: Type.Object({ok:Type.Boolean()}),
  },
  "mcp:setCredential": {
    input: Type.Object({ varName: Type.String(), value: Type.String() }),
    output: Type.Object({
      ok: Type.Boolean(),
      message: Type.Optional(Type.String()),
    }),
  },
  "mcp:clearCredential": {
    input: Type.Object({ varName: Type.String() }),
    output: Type.Object({ ok: Type.Boolean() }),
  },

  // M5 上下文 / 模型 / 提示词
  "task:getRoleContexts": {
    input: Type.Object({ taskId: Type.String() }),
    output: Type.Object({ roles: Type.Array(RoleContextInfo) }),
  },
  "task:getContext": {
    input: Type.Object({ taskId: Type.String() }),
    output: ContextInfo,
  },
  "task:compact": {
    input: Type.Object({
      taskId: Type.String(),
      instructions: Type.Optional(Type.String({ maxLength: 2000 })),
    }),
    output: Type.Object({
      ok: Type.Boolean(),
      message: Type.Optional(Type.String()),
    }),
  },
  "task:setModel": {
    input: Type.Object({
      taskId: Type.String(),
      provider: Type.Optional(Type.String()),
      modelId: Type.Optional(Type.String()),
      auto: Type.Optional(Type.Boolean()),
    }),
    output: Type.Object({
      ok: Type.Boolean(),
      message: Type.Optional(Type.String()),
    }),
  },
  "task:setThinking": {
    input: Type.Object({ taskId: Type.String(), level: Type.String() }),
    output: Type.Object({
      ok: Type.Boolean(),
      message: Type.Optional(Type.String()),
    }),
  },
  "prompt:list": {
    input: Type.Object({}),
    output: Type.Object({ prompts: Type.Array(PromptTemplateInfo) }),
  },

  // M7 分叉 / 推荐 / 导出扩展 / 审批策略
  "task:getTree": {
    input: Type.Object({ taskId: Type.String() }),
    output: Type.Object({
      userMessages: Type.Array(
        Type.Object({
          entryId: Type.String(),
          text: Type.String(),
          timestamp: Type.Optional(Type.Integer()),
        }),
      ),
    }),
  },
  "task:fork": {
    input: Type.Object({ taskId: Type.String(), entryId: Type.String() }),
    output: TaskInfo,
  },
  "market:authInfo": {
    input: Type.Object({ source: Type.String({ minLength: 1 }) }),
    output: MarketAuthInfo,
  },
  "market:authStart": {
    input: Type.Object({ source: Type.String({ minLength: 1 }) }),
    output: MarketAuthInfo,
  },
  "market:recommend": {
    input: Type.Object({
      source: Type.Optional(MarketOrigin),
      kind: Type.Optional(MarketKind),
    }),
    output: Type.Object({
      items: Type.Array(CatalogItem),
      generatedAt: Type.Integer(),
      nextRefreshAt: Type.Integer(),
      note: Type.Optional(Type.String()),
    }),
  },
  "export:transcript": {
    input: Type.Object({
      taskId: Type.String(),
      format: Type.Optional(
        Type.Union([
          Type.Literal("markdown"),
          Type.Literal("json"),
          Type.Literal("html"),
        ]),
      ),
    }),
    output: Type.Object({
      ok: Type.Boolean(),
      path: Type.Union([Type.String(), Type.Null()]),
    }),
  },
  "settings:setApproval": {
    input: Type.Object({
      autoApproveTools: Type.Array(Type.String(), { maxItems: 32 }),
    }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
} as const;

export type CommandName = keyof typeof commandSchemas;
export type CommandInput<N extends CommandName> = Static<
  (typeof commandSchemas)[N]["input"]
>;
export type CommandOutput<N extends CommandName> = Static<
  (typeof commandSchemas)[N]["output"]
>;

export function commandNames(): CommandName[] {
  return Object.keys(commandSchemas) as CommandName[];
}

/** 校验辅助：返回首条错误的可读信息。 */
export function validateOrFirstError(
  schema: TSchema,
  value: unknown,
): { ok: true } | { ok: false; message: string } {
  if (Value.Check(schema, value)) return { ok: true };
  for (const err of Value.Errors(schema, value)) {
    const message =
      (err as Partial<TLocalizedValidationError>).message ?? err.keyword;
    return { ok: false, message: `${err.instancePath || "/"}: ${message}` };
  }
  return { ok: false, message: "校验失败（无错误详情）" };
}

/* ------------------------------------------------------------------ */
/* 事件注册表                                                          */
/* ------------------------------------------------------------------ */

export const eventSchemas = {
  "workbench:changed": Type.Object({ id: Type.String() }),
  // Read-only route audit metadata, before host safety suppression; never private role history.
  "workbench:routingDecision": Type.Object({
    id: Type.String(), requestId: Type.String(), historySuppressed: Type.Boolean(),
    readOnlySuppressed: Type.Boolean(),
    decision: Type.Object({
      action: Type.String(), roleIds: Type.Array(Type.String()),
      assignments: Type.Array(Type.Object({roleId:Type.String(),files:Type.Array(Type.String()),dependsOn:Type.Array(Type.String())})),
    }),
  }),
  "app:notify": Type.Object({
    taskId: Type.Optional(Type.String()),
    level: Type.Union([
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("error"),
    ]),
    message: Type.String(),
  }),
  // M1 任务流
  "task:stream": Type.Object({
    taskId: Type.String(),
    kind: Type.Union([
      Type.Literal("text_delta"),
      Type.Literal("thinking_delta"),
      Type.Literal("assistant_message_end"),
      Type.Literal("tool_execution_start"),
      Type.Literal("tool_execution_update"),
      Type.Literal("tool_execution_end"),
      Type.Literal("queue_update"),
    ]),
    delta: Type.Optional(Type.String()),
    toolCallId: Type.Optional(Type.String()),
    toolName: Type.Optional(Type.String()),
    args: Type.Optional(Type.Any()),
    isError: Type.Optional(Type.Boolean()),
    durationMs: Type.Optional(Type.Integer()),
    resultPreview: Type.Optional(Type.String()),
    outputId: Type.Optional(Type.String()),
    /** M3：多 Agent 场景下的发言成员 */
    roleName: Type.Optional(Type.String()),
    usage: Type.Optional(UsageInfo),
    message: Type.Optional(TranscriptMessage),
    steering: Type.Optional(Type.Array(Type.String())),
    followUp: Type.Optional(Type.Array(Type.String())),
  }),
  "task:progress": RunProgress,
  "git:changed": Type.Object({ taskId: Type.String() }),
  "task:deleted": Type.Object({ taskId: Type.String() }),
  "task:state": Type.Object({
    taskId: Type.String(),
    status: TaskStatus,
    detail: Type.Optional(Type.String()),
    completion: Type.Optional(Type.Union([TaskCompletion, Type.Null()])),
  }),
  "task:agent": Type.Object({ taskId: Type.String(), agent: AgentRun }),
  "task:plan": Type.Object({
    taskId: Type.String(),
    steps: Type.Array(PlanStep),
    state: Type.Optional(Type.Union([PlanState, Type.Null()])),
  }),
  "task:approval": ApprovalRequest,
  // M2
  "model:loginEvent": LoginEventPayload,
  "time-memory:changed": Type.Object({id:Type.String(),roleId:Type.String(),taskId:Type.Optional(Type.String()),message:Type.Optional(Type.String())}),
  "memory:changed": Type.Object({
    memoryId: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    scopeType: Type.Optional(Type.String()),
    scopeId: Type.Optional(Type.String()),
  }),
  // M3 多 Agent
  "task:roleContext": Type.Object({ taskId: Type.String() }),
  "task:phase": Type.Object({
    taskId: Type.String(),
    phase: Type.Union([
      Type.Literal("compaction_start"),
      Type.Literal("compaction_end"),

      Type.Literal("subtask-start"),
      Type.Literal("subtask-review"),
      Type.Literal("subtask-rework"),
    ]),
    round: Type.Optional(Type.Integer()),
    detail: Type.Optional(Type.String()),
  }),

  // ask_user 工具：模型向用户发起结构化提问（选项 + 其他自由输入）
  "task:question": TaskQuestion,
  // M4
  "market:progress": Type.Object({
    message: Type.String(),
  }),
  "backup:restored": Type.Object({ ok: Type.Boolean() }),
} as const;

export type EventName = keyof typeof eventSchemas;
export type EventPayload<N extends EventName> = Static<
  (typeof eventSchemas)[N]
>;

export interface AppEvent<N extends EventName = EventName> {
  type: N;
  ts: number;
  payload: EventPayload<N>;
}

/** 判别联合：switch(event.type) 可正确收窄 payload。 */
export type AnyAppEvent = {
  [N in EventName]: { type: N; ts: number; payload: EventPayload<N> };
}[EventName];

/* ------------------------------------------------------------------ */
/* 调用信封（IPC 线上格式）                                             */
/* ------------------------------------------------------------------ */

export type InvokeErrorCode =
  | "unknown_command"
  | "invalid_input"
  | "invalid_output"
  | "handler_error";

export interface InvokeOk<T> {
  ok: true;
  result: T;
}

export interface InvokeError {
  ok: false;
  error: { code: InvokeErrorCode; message: string };
}

export type InvokeEnvelope<T> = InvokeOk<T> | InvokeError;
