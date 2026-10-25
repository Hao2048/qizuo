import { forgetDraft } from "./draft-persistence.js";
import { refreshWorkbenches } from "./workbench-data.js";
/**
 * 事件分发：主进程推送 → store 更新。
 * 渲染层唯一的任务事件入口（App 挂载时订阅）。
 */
import type { AnyAppEvent } from "@pi-harness/contracts";
import { useStore } from "./store.js";
import { refreshContext, refreshMemories, refreshTaskList } from "./data.js";

export function dispatchAppEvent(event: AnyAppEvent): void {
  const s = useStore.getState();
  // 任务作用域事件：只进当前任务。currentTaskId 为 null（新任务视图）时一律拦截，
  // 避免后台任务的流式/审批/计划串进当前界面。
  const taskScoped = (taskId?: string): boolean =>
    s.currentTaskId !== null && taskId === s.currentTaskId;
  switch (event.type) {
    case "workbench:changed": {
      void refreshWorkbenches().catch(() => {});
      break;
    }
    case "task:progress": {
      if (!taskScoped(event.payload.taskId)) return;
      const stage = event.payload.stage;
      useStore.setState({
        runProgress: event.payload,
        preparingMessage: [
          "accepted",
          "git",
          "resources",
          "mcp",
          "preparing",
        ].includes(stage),
      });
      break;
    }
    case "task:deleted": {
      forgetDraft({kind:"chat",id:event.payload.taskId});
      if (s.pendingCompose?.taskId === event.payload.taskId)
        useStore.setState({ pendingCompose: null });
      const id = event.payload.taskId;
      if (s.currentTaskId === id) {
        s.resetConversation();
        s.selectTask(null);
      }
      useStore.setState((current) => ({
        tasks: current.tasks.filter((t) => t.id !== id),
      }));
      break;
    }

    case "task:stream": {
      const p = event.payload;
      if (!taskScoped(p.taskId)) return;
      switch (p.kind) {
        case "text_delta":
          s.appendStreamText(p.delta ?? "");
          break;
        case "thinking_delta":
          s.appendStreamThinking(p.delta ?? "");
          break;
        case "assistant_message_end":
          if (p.message) s.appendTranscript(p.message);
          useStore.setState({ streamingText: "", streamingThinking: "" });
          void refreshContext(p.taskId);
          break;
        case "tool_execution_start":
          s.appendToolCard({
            turnId: [...s.transcript].reverse().find((m) => m.role === "user")
              ?.id,
            toolCallId: p.toolCallId ?? "",
            toolName: p.toolName ?? "?",
            args: p.args,
            status: "running",
          });
          break;
        case "tool_execution_end":
          s.updateToolCard(p.toolCallId ?? "", {
            status: "done",
            isError: p.isError,
            durationMs: p.durationMs,
            resultPreview: p.resultPreview,
            outputId: p.outputId,
          });
          break;
        default:
          break;
      }
      break;
    }
    case "task:state": {
      const p = event.payload;
      if (!taskScoped(p.taskId)) {
        void refreshTaskList();
        return;
      }
      if (
        p.status === "running" ||
        p.status === "done" ||
        p.status === "error" ||
        p.status === "cancelled"
      ) {
        useStore.setState({ question: null });
      }
      if (
        p.status === "done" ||
        p.status === "error" ||
        p.status === "cancelled"
      ) {
        // 结束态：清审批卡，刷新列表
        if (s.pendingApproval) s.setPendingApproval(null);
        void refreshTaskList();
      }
      s.setTaskStatus(p.status, p.detail);
      if (p.status === "done" || p.status === "error" || p.status === "cancelled" || p.status === "running")
        useStore.setState({ completion: p.status === "done" ? p.completion ?? null : null });
      break;
    }
    case "task:approval": {
      if (!taskScoped(event.payload.taskId)) return;
      s.addPendingApproval(event.payload);
      break;
    }
    case "task:question": {
      if (!taskScoped(event.payload.taskId)) return;
      s.setQuestion(event.payload);
      break;
    }
    case "task:plan": {
      if (!taskScoped(event.payload.taskId)) return;
      s.setPlan(event.payload.steps, event.payload.state);
      break;
    }
    case "app:notify":
      if (event.payload.taskId && !taskScoped(event.payload.taskId)) return;
      s.setNotice({
        level: event.payload.level,
        message: event.payload.message,
      });
      break;
    case "time-memory:changed": {
      if(event.payload.message)s.setNotice({level:"info",message:event.payload.message});
      if(event.payload.taskId)void refreshTaskList().catch(()=>{});
      break;
    }
    case "memory:changed":
      if (
        event.payload.taskId &&
        taskScoped(event.payload.taskId) &&
        event.payload.memoryId &&
        event.payload.scopeId &&
        event.payload.message
      ) {
        s.setNotice({
          level: "info",
          message: event.payload.message,
          memoryRef: {
            id: event.payload.memoryId,
            roleId: event.payload.scopeId,
          },
        });
      }
      // 记忆变化：当前在记忆页时刷新（轻量：直接刷新缓存）
      if (s.page === "memory") {
        void refreshMemories({
          scopeType: "role",
          scopeId:
            s.memoryScope === "role"
              ? (s.memoryRoleId ?? undefined)
              : undefined,
          query: s.memoryQuery || undefined,
          status: s.memoryStatus,
        }).catch(() => {});
      }
      break;
    case "model:loginEvent":
      s.setLoginEvent(event.payload);
      break;
    case "task:phase": {
      const p = event.payload;
      if (!taskScoped(p.taskId)) return;
      if (p.phase === "compaction_start") {
        s.setContextInfo({
          ...s.contextInfo,
          compacting: true,
          compactionStartedAt: Date.now(),
        });
        void refreshContext(p.taskId);
      }
      if (p.phase === "compaction_end") {
        s.setContextInfo({
          ...s.contextInfo,
          compacting: false,
          compactionStartedAt: null,
        });
        void refreshContext(p.taskId);
      }
      s.appendTranscript({
        id: `phase-${Date.now()}-${p.phase}`,
        role: "assistant",
        text: p.detail ?? p.phase,
        kind: "phase",
        timestamp: Date.now(),
      });
      break;
    }
  }
}
