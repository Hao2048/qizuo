import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { invoke } from "../api.js";
import Icon from "./Icon.js";

/** Running plans show one step; the complete list is available on demand. */
export default function PlanBar(): React.ReactElement | null {
  const state=useStore(s=>s.planState);
  const [approving,setApproving]=useState(false);
  const plan = useStore((s) => s.plan);
  const taskStatus = useStore((s) => s.taskStatus);
  const stopped = ["draft", "cancelled", "paused", "error", "done"].includes(taskStatus ?? "");
  const taskId = useStore((s) => s.currentTaskId);
  const [expanded, setExpanded] = useState(false);
  const done = plan?.filter((s) => s.status === "completed").length ?? 0;
  const complete = !!plan?.length && done === plan.length;
  useEffect(() => {
    setExpanded(false);
    setApproving(false);
  }, [taskId, complete, stopped]);
  if (!plan?.length || complete || taskStatus === "done" && !(state?.requiresApproval && ["draft","paused"].includes(state.status))) return null;
  const currentIndex = plan.findIndex((s) => s.status === "in_progress");
  const nextIndex =
    currentIndex >= 0
      ? currentIndex
      : plan.findIndex((s) => s.status === "pending");
  const current = plan[nextIndex];
  const visible = expanded
    ? plan.map((step, index) => ({ step, index }))
    : complete || stopped || !current
      ? []
      : [{ step: current, index: nextIndex }];
  return (
    <div className="plan-bar" aria-label="任务计划">
      <button
        type="button"
        className="plan-head"
        aria-expanded={expanded}
        aria-label={expanded ? "收起完整计划" : "查看完整计划"}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="plan-title">
      {state?.requiresApproval && state.status === "draft" ? "计划待确认" : state?.requiresApproval && state.status === "paused" ? "计划已暂停" : complete ? "计划已完成" : taskStatus === "error" ? "计划执行失败" : stopped ? "计划未完成" : "任务计划"}
        </span>
        <span className="plan-progress">
          {done}/{plan.length}
        </span>
        <span className="plan-progress-bar">
          <span
            style={{ width: `${Math.round((done / plan.length) * 100)}%` }}
          />
        </span>
        <Icon name={expanded ? "down" : "chevron"} size={13} />
      </button>
          {visible.length ? (
        <ol
          className={`plan-steps${expanded ? " expanded" : ""}`}
          aria-live={expanded ? "off" : "polite"}
        >
          {visible.map(({ step, index }) => (
            <li key={index} className={`plan-step ${stopped && step.status === "in_progress" ? "pending" : step.status}`}>
              <span className="plan-step-icon">
                <Icon
                  name={
                    step.status === "completed"
                      ? "check"
                      : step.status === "in_progress" && !stopped
                        ? "bolt"
                        : "clock"
                  }
                  size={13}
                />
              </span>
              <span className="plan-step-index">{index + 1}.</span>
              <span className="clamp" title={step.content}>
                {step.content}
              </span>
              {!expanded && step.status === "pending" ? (
                <span className="hint">待执行</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {state?.requiresApproval && ["draft","paused"].includes(state.status) && stopped && expanded ? (
        <div className="plan-approval">
          <span className="hint">确认以上计划后执行。修改步骤需重新确认。</span>
          <button type="button" className="btn primary" disabled={approving} onClick={async()=>{
            if(!taskId)return;
            setApproving(true);
            try { await invoke("task:approvePlan",{taskId,revision:state.revision}); }
            catch(error){useStore.getState().setNotice({level:"error",message:error instanceof Error ? error.message : String(error)});}
            finally{setApproving(false);}
          }}>{approving ? "正在开始…" : state.status === "paused" ? "恢复执行计划" : "批准并执行"}</button>
        </div>
      ) : null}
    </div>
  );
}
