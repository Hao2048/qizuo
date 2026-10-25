import MemoryNoticeLink from "../components/MemoryNoticeLink.js";
import CompletionNotice from "../components/CompletionNotice.js";
import {TaskRoleControls} from "../components/RoleChangeDialog.js";
import { useStore } from "../store.js";
import TranscriptView from "../components/TranscriptView.js";
import InputBar from "../components/InputBar.js";
import AgentPanel from "../components/AgentPanel.js";
import PlanBar from "../components/PlanBar.js";
import RoleContextBar from "../components/RoleContextBar.js";
import GitPanel from "./GitPanel.js";
import { WorkspacePanel } from "./MarketDetailHelpers.js";

/** 工作台右列：聊天窗口。 */
export default function ChatPanel(): React.ReactElement {
  const taskId=useStore(s=>s.currentTaskId);
  const recovery = useStore((s) => s.recovery);
  const notice = useStore((s) => s.notice);
  const taskStatus = useStore((s) => s.taskStatus);
  const title=useStore(s=>s.tasks.find(t=>t.id===s.currentTaskId)?.title ?? "新对话");
  const preparing = useStore((s) => s.preparingMessage);
  const completion = useStore((s) => s.completion);

  return (
    <div className="detail chat">
      <header className="chat-bar">
        <div className="chat-heading">
          <h1 title={title}>{title}</h1>
        <span className={`status-pill ${taskStatus ?? "idle"}`}>
          {recovery && taskStatus === "cancelled" ? "运行中断" : preparing ? "准备中" : taskStatus === "running"
            ? "运行中"
            : taskStatus === "waiting_approval"
              ? "待审批"
              : taskStatus === "waiting_user"
                ? "待回答"
                : taskStatus === "waiting_recommend"
                  ? "待选择"
                  : taskStatus === "done"
                    ? completion?.outcome === "needs_attention" ? "结束 · 需核对" : completion ? "回复结束" : "已完成"
                    : taskStatus === "error"
                      ? "出错"
                      : taskStatus === "cancelled"
                        ? "已停止"
                        : "新任务"}
        </span>
        </div>
        <div className="chat-tools">
          <TaskRoleControls/>
          <GitPanel />
          <WorkspacePanel />
        </div>
        {notice ? (
          <span className={`notice ${notice.level}`}>
            {notice.message}<MemoryNoticeLink/>
            <button
              type="button"
              onClick={() => useStore.getState().setNotice(null)}
            >
              ×
            </button>
          </span>
        ) : null}
      </header>

      {recovery ? <div className="recovery-banner" role="status">上次运行中断，已保留已有记录。继续前需要核对未确认的操作结果，历史命令不会自动重跑。</div> : null}
      <CompletionNotice />
      <PlanBar />
      <div className="chat-workspace"><AgentPanel /><TranscriptView /></div>
      <InputBar key={`input:${taskId??"new"}`} />
      <RoleContextBar />
    </div>
  );
}
