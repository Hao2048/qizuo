/**
 * 数据加载辅助：与主进程交互的薄层（命令调用 + store 水合）。
 */
import { invoke } from "./api.js";
import { useStore } from "./store.js";

export async function refreshStaticData(): Promise<void> {
  const [providersEnv, settingsEnv, projectsEnv, tasksEnv, rolesEnv] =
    await Promise.all([
      invoke("model:list", {}),
      invoke("settings:get", {}),
      invoke("project:list", {}),
      invoke("task:list", {}),
      invoke("role:list", {}),
    ]);
  useStore.getState().hydrate({
    providers: providersEnv.providers,
    settings: settingsEnv,
    projects: projectsEnv.projects,
    tasks: tasksEnv.tasks,
    roles: rolesEnv.roles,
  });
}

export async function refreshTaskList(): Promise<void> {
  const env = await invoke("task:list", {});
  useStore.getState().hydrate({ tasks: env.tasks });
}

export async function refreshRoles(includeArchived = false): Promise<void> {
  const env = await invoke("role:list", { includeArchived });
  useStore.getState().hydrate({ roles: env.roles });
}

let memoryListVersion = 0;
export async function refreshMemories(
  filters: {
    scopeType?: "role";
    scopeId?: string;
    verification?: "all" | "pending" | "ready";
    query?: string;
    status?: "active" | "forgotten" | "all";
  } = {},
): Promise<void> {
  const version = ++memoryListVersion;
  const env = await invoke("memory:list", {
    verification:
      filters.verification ?? useStore.getState().memoryVerification,
    scopeType: filters.scopeType,
    scopeId: filters.scopeId,
    query: filters.query,
    status: filters.status ?? "active",
    limit: 100,
  });
  if (version !== memoryListVersion) return;
  useStore.getState().hydrate({ memories: env.items, memoryTotal: env.total });
}

let taskOpenVersion = 0;
export async function openTask(taskId: string): Promise<void> {
  const version = ++taskOpenVersion;
  const s = useStore.getState();
  s.resetConversation();
  s.selectTask(taskId);
  const result = await invoke("task:get", { taskId });
  const current = useStore.getState();
  if (version !== taskOpenVersion || current.currentTaskId !== taskId) return;
  const { task } = result;
  // IPC snapshots can predate events received while opening the conversation.
  // Merge only this task's live messages, using persisted entry identity first.
  const transcript = [...result.transcript];
  const entries = new Map(transcript.flatMap((m,i) => [[`id:${m.id}`,i] as const, ...(m.entryId ? [[`entry:${m.role}:${m.entryId}`,i] as const] : [])]));
  for (const live of current.transcript) {
    const index = (live.entryId ? entries.get(`entry:${live.role}:${live.entryId}`) : undefined) ?? entries.get(`id:${live.id}`);
    if (index === undefined) {
      const next = transcript.push(live) - 1;
      entries.set(`id:${live.id}`, next);
      if (live.entryId) entries.set(`entry:${live.role}:${live.entryId}`, next);
    } else transcript[index] = {...transcript[index]!, ...live, id:transcript[index]!.id};
  }
  const status = current.taskStatus ?? task.status;
  const pendingApprovals = ["done", "error", "cancelled"].includes(status)
    ? []
    : [
        ...new Map(
          [...((current.taskStatus === null || current.taskStatus === "waiting_approval") ? result.pendingApprovals ?? [] : []), ...current.pendingApprovals].map(
            (a) => [a.toolCallId, a],
          ),
        ).values(),
      ];
  useStore.setState({
    transcript,
    recovery: status === "done" ? null : (task.recovery ?? null),
    runProgress: current.runProgress ?? result.progress ?? null,
    preparingMessage:
      ["accepted", "git", "resources", "mcp", "preparing"].includes(
        (current.runProgress ?? result.progress)?.stage ?? "",
      ) && !["done", "error", "cancelled"].includes(status),
    taskStatus: status,
    completion: ["done"].includes(status ?? "") ? current.completion ?? task.completion ?? null : null,
    pendingApprovals,
    pendingApproval: pendingApprovals[0] ?? null,
    question:
      status === "waiting_user"
        ? (current.question ?? result.question ?? null)
        : null,
    plan: current.plan ?? task.plan ?? null,
    planState: current.planState ?? task.planState ?? null,
    draftRoleId: task.roleId ?? null,
    draftModel:
      task.modelOverride !== undefined
        ? task.modelOverride
        : (task.model ?? null),
    draftThinking: task.thinkingOverride ?? null,
    draftProjectId: task.projectId?.id ?? null,
  });
}

let contextRequestVersion = 0;
export async function refreshContext(taskId: string | null): Promise<void> {
  const requestVersion = ++contextRequestVersion;
  const version = taskOpenVersion;
  if (!taskId) {
    useStore.getState().setContextInfo(null);
    return;
  }
  try {
    const c = await invoke("task:getContext", { taskId });
    if (
      useStore.getState().currentTaskId !== taskId ||
      version !== taskOpenVersion ||
      requestVersion !== contextRequestVersion
    )
      return;
    useStore.getState().setContextInfo(c);
  } catch {
    if (
      useStore.getState().currentTaskId !== taskId ||
      version !== taskOpenVersion ||
      requestVersion !== contextRequestVersion
    )
      return;
    useStore.getState().setContextInfo(null);
  }
}

export async function refreshPrompts(): Promise<void> {
  try {
    const { prompts } = await invoke("prompt:list", {});
    useStore
      .getState()
      .setPrompts(
        prompts.map((x) => ({ ...x, argumentHint: x.argumentHint ?? null })),
      );
  } catch {
    useStore.getState().setPrompts([]);
  }
}

export async function refreshBindable(): Promise<void> {
  try {
    const { items } = await invoke("resource:listBindable", {});
    useStore.getState().setBindable(items);
  } catch {
    useStore.getState().setBindable([]);
  }
}
