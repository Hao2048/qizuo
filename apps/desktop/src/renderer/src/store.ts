import { create } from "zustand";
import type {
  Attachment,
  ApprovalRequest,
  AppSettings,
  MemoryInfo,
  ProjectInfo,
  ProviderInfo,
  RoleInfo,
  TaskInfo,
  TaskStatus,
  TranscriptMessage,
  LoginEventPayload,
  RunProgress,
  ContextInfo,
} from "@pi-harness/contracts";

export type PageId =
  | "workbench"
  | "collaboration"
  | "roles"
  | "memory"
  | "market"
  | "settings";
export type ToolId = PageId;
export type MarketTab = "plugins" | "skills" | "installed";
export type MarketSource = "all" | "pi" | "claude";
export type SettingsSection =
  | "model"
  | "connections"
  | "mcp"
  | "approval"
  | "prefs"
  | "backup"
  | "about";

export interface ToolCardState {
  turnId?: string;
  toolCallId: string;
  toolName: string;
  args?: unknown;
  status: "running" | "done";
  isError?: boolean;
  durationMs?: number;
  resultPreview?: string;
  outputId?: string;
}

interface WorkbenchState {
  tool: PageId;
  memoryScope: "" | "user" | "role" | "project";
  memoryQuery: string;
  memoryStatus: "active" | "forgotten" | "all";
  memoryVerification: "all" | "pending" | "ready";
  memoryRoleId: string | null;
  /* 数据 */
  projects: ProjectInfo[];
  tasks: TaskInfo[];
  providers: ProviderInfo[];
  settings: AppSettings | null;
  roles: RoleInfo[];
  memories: MemoryInfo[];
  memoryTotal: number;
  /* 当前任务 */
  currentTaskId: string | null;
  selectedRoleId: string | null;
  selectedMemoryId: string | null;
  drilledProjectId: string | null;
  marketTab: MarketTab;
  /** 插件页/技能页各自的目录源（两页均可切换 Pi 社区与 Claude 官方） */
  pluginsSource: MarketSource;
  skillsSource: MarketSource;
  settingsSection: SettingsSection;
  draftProjectId: string | null;
  draftRoleId: string | null;
  draftThinking: string | null;
  draftModel: { provider: string; modelId: string } | null;
  transcript: TranscriptMessage[];
  toolCards: ToolCardState[];
  streamingText: string;
  streamingThinking: string;
  taskStatus: TaskStatus | null;
  recovery: TaskInfo["recovery"];
  runProgress: RunProgress | null;
  preparingMessage: boolean;
  pendingCompose: {
    taskId: string;
    text: string;
    attachments: Attachment[];
  } | null;
  pendingApproval: ApprovalRequest | null;
  pendingApprovals: ApprovalRequest[];
  /** ask_user 工具弹出的结构化提问（null=无） */
  question: {
    taskId: string;
    questionId: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
  } | null;
  /** 当前任务计划（update_plan 工具维护；null=无计划） */
  planState: TaskInfo["planState"];
  completion: TaskInfo["completion"];
  plan: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
  }> | null;
  notice: {
    level: "info" | "warn" | "error";
    message: string;
    memoryRef?: { id: string; roleId: string };
  } | null;
  /* 登录流 */
  loginEvent: LoginEventPayload | null;
  /* M5 */
  contextInfo: ContextInfo | null;
  prompts: Array<{
    name: string;
    description: string;
    argumentHint: string | null;
  }>;
  /* M7 */
  forkCandidates: Array<{ entryId: string; text: string }> | null;
  /* M8 */
  bindable: Array<{ name: string; kind: "skill" | "package" }>;
  /* 动作 */
  setPage: (page: PageId) => void;
  page: PageId;
  setTool: (tool: PageId) => void;
  setMemoryScope: (s: "" | "user" | "role" | "project") => void;
  setMemoryQuery: (q: string) => void;
  setNotice: (n: WorkbenchState["notice"]) => void;
  hydrate: (
    data: Partial<
      Pick<
        WorkbenchState,
        | "projects"
        | "tasks"
        | "providers"
        | "settings"
        | "roles"
        | "memories"
        | "memoryTotal"
      >
    >,
  ) => void;
  selectTask: (taskId: string | null) => void;
  setSelectedRole: (id: string | null) => void;
  setSelectedMemory: (id: string | null) => void;
  setDrilledProject: (id: string | null) => void;
  setMarketTab: (t: MarketTab) => void;
  setPluginsSource: (s: MarketSource) => void;
  setSkillsSource: (s: MarketSource) => void;
  setSettingsSection: (s: SettingsSection) => void;
  setDraftProject: (projectId: string | null) => void;
  setDraftRole: (roleId: string | null) => void;
  setDraftModel: (m: { provider: string; modelId: string } | null) => void;
  resetConversation: () => void;
  appendTranscript: (m: TranscriptMessage) => void;
  setTranscript: (messages: TranscriptMessage[]) => void;
  appendToolCard: (c: ToolCardState) => void;
  updateToolCard: (toolCallId: string, patch: Partial<ToolCardState>) => void;
  appendStreamText: (delta: string) => void;
  appendStreamThinking: (delta: string) => void;
  setTaskStatus: (status: TaskStatus | null, detail?: string) => void;
  setPendingApproval: (a: ApprovalRequest | null) => void;
  addPendingApproval: (a: ApprovalRequest) => void;
  removePendingApproval: (id: string) => void;
  setPlan: (p: WorkbenchState["plan"], state?: TaskInfo["planState"]) => void;
  setQuestion: (q: WorkbenchState["question"]) => void;
  setLoginEvent: (e: LoginEventPayload | null) => void;
  setContextInfo: (c: WorkbenchState["contextInfo"]) => void;
  setPrompts: (p: WorkbenchState["prompts"]) => void;
  setForkCandidates: (f: WorkbenchState["forkCandidates"]) => void;
  setBindable: (b: WorkbenchState["bindable"]) => void;
}

export const useStore = create<WorkbenchState>((set) => ({
  page: "workbench",
  tool: "workbench",
  memoryScope: "role",
  memoryQuery: "",
  memoryStatus: "active",
  memoryVerification: "all",
  memoryRoleId: null,
  setTool: (page) => set({ page, tool: page }),
  setMemoryScope: (memoryScope) => set({ memoryScope, selectedMemoryId: null }),
  setMemoryQuery: (memoryQuery) => set({ memoryQuery }),
  projects: [],
  tasks: [],
  providers: [],
  settings: null,
  roles: [],
  memories: [],
  memoryTotal: 0,
  currentTaskId: null,
  selectedRoleId: null,
  selectedMemoryId: null,
  drilledProjectId: null,
  marketTab: "plugins",
  pluginsSource: "all",
  skillsSource: "all",
  settingsSection: "model",
  draftProjectId: null,
  draftRoleId: null,
  draftThinking: null,
  draftModel: null,
  transcript: [],
  toolCards: [],
  streamingText: "",
  streamingThinking: "",
  taskStatus: null,
  recovery: null,
  runProgress: null,
  preparingMessage: false,
  pendingCompose: null,
  pendingApproval: null,
  pendingApprovals: [],
  plan: null,
  planState: null,
  completion: null,
  question: null,
  notice: null,
  loginEvent: null,
  contextInfo: null,
  prompts: [],
  forkCandidates: null,
  bindable: [],

  setPage: (page) => set({ page, tool: page }),
  setNotice: (notice) => set({ notice }),
  hydrate: (data) => set(data),
  selectTask: (currentTaskId) => set({ currentTaskId }),
  setSelectedRole: (selectedRoleId) => set({ selectedRoleId }),
  setSelectedMemory: (selectedMemoryId) => set({ selectedMemoryId }),
  setDrilledProject: (drilledProjectId) => set({ drilledProjectId }),
  setMarketTab: (marketTab) => set({ marketTab }),
  setPluginsSource: (pluginsSource) => set({ pluginsSource }),
  setSkillsSource: (skillsSource) => set({ skillsSource }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  setDraftProject: (draftProjectId) => set({ draftProjectId }),
  setDraftRole: (draftRoleId) => set({ draftRoleId }),
  setDraftModel: (draftModel) => set({ draftModel }),
  resetConversation: () =>
    set({
      transcript: [],
      toolCards: [],
      streamingText: "",
      streamingThinking: "",
      taskStatus: null,
      recovery: null,
      runProgress: null,
      preparingMessage: false,
      pendingApproval: null,
      pendingApprovals: [],
      plan: null,
      planState: null,
      completion: null,
      question: null,
      contextInfo: null,
      forkCandidates: null,
    }),
  appendTranscript: (m) => set((s) => ({ transcript: [...s.transcript, m] })),
  setTranscript: (transcript) => set({ transcript }),
  appendToolCard: (c) => set((s) => ({ toolCards: [...s.toolCards, c] })),
  updateToolCard: (toolCallId, patch) =>
    set((s) => ({
      toolCards: s.toolCards.map((c) =>
        c.toolCallId === toolCallId ? { ...c, ...patch } : c,
      ),
    })),
  appendStreamText: (delta) =>
    set((s) => ({ streamingText: s.streamingText + delta })),
  appendStreamThinking: (delta) =>
    set((s) => ({ streamingThinking: s.streamingThinking + delta })),
  setTaskStatus: (taskStatus, detail) =>
    set((s) => ({
      taskStatus,
      recovery: taskStatus === "done" ? null : s.recovery,
      notice:
        taskStatus === "error" && detail
          ? { level: "error", message: detail }
          : taskStatus === "running" && s.notice?.level === "error"
            ? null
            : s.notice,
    })),
  setPendingApproval: (pendingApproval) =>
    set({
      pendingApproval,
      pendingApprovals: pendingApproval ? [pendingApproval] : [],
    }),
  addPendingApproval: (a) =>
    set((s) => {
      const pendingApprovals = [
        ...s.pendingApprovals.filter((p) => p.toolCallId !== a.toolCallId),
        a,
      ];
      return { pendingApprovals, pendingApproval: pendingApprovals[0] ?? null };
    }),
  removePendingApproval: (id) =>
    set((s) => {
      const pendingApprovals = s.pendingApprovals.filter(
        (p) => p.toolCallId !== id,
      );
      return { pendingApprovals, pendingApproval: pendingApprovals[0] ?? null };
    }),
  setPlan: (plan, planState) => set({ plan, planState: planState ?? null }),
  setQuestion: (question) => set({ question }),
  setLoginEvent: (loginEvent) => set({ loginEvent }),
  setContextInfo: (contextInfo) => set({ contextInfo }),
  setPrompts: (prompts) => set({ prompts }),
  setForkCandidates: (forkCandidates) => set({ forkCandidates }),
  setBindable: (bindable) => set({ bindable }),
}));
