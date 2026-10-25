import { useEffect, useRef, useState } from "react";
import type { AgentRun } from "@pi-harness/contracts";
import { invoke, onEvent } from "../api.js";
import { useStore } from "../store.js";
import Icon from "./Icon.js";
const labels: Record<AgentRun["status"], string> = {
  queued: "排队中",
  starting: "准备中",
  running: "运行中",
  waiting_approval: "待审批",
  done: "已完成",
  error: "失败",
  cancelled: "已停止",
  interrupted: "已中断",
};
export default function AgentPanel(): React.ReactElement | null {
  const taskId = useStore((s) => s.currentTaskId);
  const [agents, setAgents] = useState<AgentRun[]>([]);
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const epoch = ++generation.current;
    let query = 0,
      timer: ReturnType<typeof setTimeout> | undefined;
    setAgents([]);
    setOpen(false);
    setSelected(null);
    if (!taskId) return;
    const load = async () => {
      const version = ++query;
      try {
        const a = await invoke("task:listAgents", { taskId });
        if (generation.current === epoch && version === query) {
          setAgents(a.agents ?? []);
        }
      } catch {}
    };
    void load();
    const unsubscribe = onEvent((event) => {
      if (
        ["task:agent", "task:state", "task:phase"].includes(event.type) &&
        (event.payload as { taskId?: string }).taskId === taskId
      ) {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 60);
      }
    });
    return () => {
      generation.current++;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [taskId]);
  if (!taskId || !agents.length) return null;
  const live = agents.filter((a) =>
    ["queued", "starting", "running", "waiting_approval"].includes(a.status),
  );
  const agent = agents.find((a) => a.id === selected);
  return (
    <aside
      className={`agent-panel${open ? " open" : ""}`}
      aria-label="协作任务导航"
    >
      <button
        type="button"
        className="agent-toggle"
        aria-label={open ? "收起协作任务" : "展开协作任务"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="person" size={16} />
        <span>协作任务</span>
        <span className="hint">
          {live.length ? `${live.length} 个进行中` : `${agents.length} 次执行`}
        </span>
      </button>
      {open ? (
        <div className="agent-content">
          <div className="agent-list">
            {[...agents].reverse().map((a) => (
              <button
                key={a.id}
                type="button"
                className={`agent-item${selected === a.id ? " selected" : ""}`}
                aria-pressed={selected === a.id}
                onClick={() => setSelected(a.id)}
              >
                <strong>{a.roleName}</strong>
                <span>{a.title}</span>
                <small>{labels[a.status]}</small>
              </button>
            ))}
          </div>
          {agent ? (
            <section className="agent-result" aria-label="成员执行详情">
              <strong>
                {agent.roleName} · {labels[agent.status]}
              </strong>
              <p>{agent.title}</p>
              <p className="hint">
                {agent.tokens.toLocaleString()} tokens · 费用估算 $
                {agent.costUSD.toFixed(4)}
              </p>
              <p className="hint">工作目录：{agent.cwd}</p>
              {agent.error ? <p className="danger">{agent.error}</p> : null}
              <pre>{agent.result || "尚无结果摘要"}</pre>
            </section>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
