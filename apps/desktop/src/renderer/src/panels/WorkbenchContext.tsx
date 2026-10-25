import Icon from "../components/Icon.js";
import { useEffect, useState } from "react";
import { invoke } from "../api.js";
import { useStore } from "../store.js";
import { openTask, refreshStaticData, refreshTaskList } from "../data.js";

/** 项目分组内直接展示所属会话，个人会话另列。 */
export default function WorkbenchContext(): React.ReactElement {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const drilled = useStore((s) => s.drilledProjectId);
  const currentTaskId = useStore((s) => s.currentTaskId);

  useEffect(() => {
    void refreshStaticData().catch(() => {});
  }, []);

  const drilledProject = projects.find((p) => p.id === drilled) ?? null;
  const visibleTasks = (
    drilledProject ? tasks.filter((t) => t.projectId?.id === drilled) : tasks
  ).filter((t) => t.title.toLowerCase().includes(query.trim().toLowerCase()));
  const personal = visibleTasks.filter((t) => !t.projectId);
  const search = query.trim().toLowerCase();

  return (
    <div className="ctx">
      <div className="ctx-head">
        {drilledProject ? (
          <>
            <button
              type="button"
              className="ctx-back"
              onClick={() => useStore.getState().setDrilledProject(null)}
            >
              ‹ 项目
            </button>
            <h2 className="ctx-title clamp" title={drilledProject.name}>
              {drilledProject.name}
            </h2>
          </>
        ) : (
          <>
            <h2 className="ctx-title">对话</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="新建对话"
              title="新建对话 (⌘N)"
              onClick={() => {
                useStore.getState().selectTask(null);
                useStore.getState().resetConversation();
              }}
            >
              <Icon name="plus" size={20} />
            </button>
          </>
        )}
      </div>

      <div className="ctx-filter">
        <label className="sidebar-search">
          <Icon name="search" size={15} />
          <input
            aria-label="搜索会话"
            placeholder="搜索会话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="ctx-scroll">
        {(drilledProject ? [drilledProject] : projects).map((project) => {
          const children = tasks.filter(
            (task) => task.projectId?.id === project.id,
          );
          const matchesProject = project.name.toLowerCase().includes(search);
          const matching = matchesProject
            ? children
            : children.filter((task) =>
                task.title.toLowerCase().includes(search),
              );
          if (search && !matchesProject && !matching.length) return null;
          const expanded = !!search || !collapsed.has(project.id);
          return (
            <section
              className="ctx-project"
              key={project.id}
              aria-label={`${project.name}项目会话`}
            >
              <button
                type="button"
                className="ctx-item ctx-project-heading"
                aria-expanded={expanded}
                aria-controls={`project-tasks-${project.id}`}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(project.id)) next.delete(project.id);
                    else next.add(project.id);
                    return next;
                  })
                }
              >
                <span className="ctx-ico">
                  <Icon name="folder" size={16} />
                </span>
                <span className="clamp">{project.name}</span>
              </button>
              {expanded ? (
                <div
                  className="ctx-project-tasks"
                  id={`project-tasks-${project.id}`}
                >
                  {matching.length ? (
                    matching.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        active={currentTaskId === task.id}
                      />
                    ))
                  ) : (
                    <div className="ctx-empty">暂无对话</div>
                  )}
                </div>
              ) : null}
            </section>
          );
        })}
        {!drilledProject ? (
          <>
            <div className="ctx-section">草稿与个人对话</div>
            {personal.length === 0 ? (
              <div className="ctx-empty">暂无对话</div>
            ) : (
              personal.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  active={currentTaskId === task.id}
                />
              ))
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  active,
}: {
  task: {
    id: string;
    title: string;
    status: string;
    mode: string;
    roleName?: string | null;
    roleId?: string | null;
  };
  active: boolean;
}): React.ReactElement {
  const roles = useStore((s) => s.roles);
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const running = [
    "running",
    "waiting_approval",
    "waiting_user",
    "waiting_recommend",
  ].includes(task.status);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("task:delete", { taskId: task.id });
      const store = useStore.getState();
      if (store.currentTaskId === task.id) {
        store.resetConversation();
        store.selectTask(null);
      }
      useStore.setState((current) => ({
        tasks: current.tasks.filter((t) => t.id !== task.id),
      }));
      await refreshTaskList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="task-row-wrap">
      <button
        type="button"
        className={`ctx-item task${active ? " active" : ""}`}
        onClick={() => {
          void openTask(task.id);
          useStore.getState().setTool("workbench");
        }}
      >
        <span className={`task-dot ${task.status}`} />
        <span className="ctx-item-copy">
          <strong className="clamp">{task.title}</strong>
          <small className="clamp">
            {task.roleName ??
              roles.find((r) => r.id === task.roleId)?.name ??
              "任务助手"}
          </small>
        </span>
      </button>
      <button
        type="button"
        className="task-delete ghost sm"
        aria-label={`删除会话 ${task.title}`}
        title={running ? "请先停止会话，再删除" : "删除会话"}
        disabled={busy || running}
        onClick={() => setConfirm((v) => !v)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
        </svg>
      </button>
      {confirm && (
        <div
          className="task-delete-confirm"
          role="group"
          aria-label={`确认删除 ${task.title}`}
        >
          <p>删除此会话及本机会话数据？项目文件、Git 提交和分支会保留。</p>
          <button
            type="button"
            className="ghost sm"
            disabled={busy}
            onClick={() => setConfirm(false)}
          >
            取消
          </button>
          <button
            type="button"
            className="danger sm"
            disabled={busy || running}
            onClick={() => void remove()}
          >
            {busy ? "删除中…" : "确认删除会话"}
          </button>
          {error && (
            <p role="alert" className="hint bad">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
