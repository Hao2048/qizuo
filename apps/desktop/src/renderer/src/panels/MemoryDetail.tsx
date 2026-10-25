import TimeMemories from "../components/TimeMemories.js";
import MemoryUsage from "../components/MemoryUsage.js";
import {
  MemoryFields,
  MemoryReview,
  qualityLabel,
} from "../components/MemoryQuality.js";
import { selectWorkbench } from "../workbench-data.js";
import { useEffect, useState } from "react";
import type { MemoryInfo, MemoryVersionInfo } from "@pi-harness/contracts";
import { invoke } from "../api.js";
import { useStore } from "../store.js";
import { refreshMemories, refreshRoles, openTask } from "../data.js";
import PageHeader from "../components/PageHeader.js";
import Icon from "../components/Icon.js";
async function reload() {
  const s = useStore.getState();
  await refreshRoles();
  await refreshMemories({
    status: s.memoryStatus,
    scopeType: "role",
    scopeId: s.memoryRoleId ?? undefined,
    query: s.memoryQuery || undefined,
  });
}
export default function MemoryDetail(): React.ReactElement {
  const selected = useStore((s) => s.selectedMemoryId),
    memories = useStore((s) => s.memories),
    scope = useStore((s) => s.memoryScope),
    roleId = useStore((s) => s.memoryRoleId),
    roles = useStore((s) => s.roles);
  const status = useStore((s) => s.memoryStatus);
  const [creating, setCreating] = useState(false);
  const [kind,setKind]=useState<"long"|"time">("long");
  const qualityFilter = useStore((s) => s.memoryVerification);
  useEffect(() => {
    const open = () => {if(kind==="long")setCreating(true);else window.dispatchEvent(new Event("pih:new-time-memory"));};
    window.addEventListener("pih:new-memory", open);
    return () => window.removeEventListener("pih:new-memory", open);
  }, [kind]);
  // Do not show another role's stale response while the scoped request is pending.
  const visible = memories.filter(
    (m) =>
      (status === "all" || m.status === status) &&
      m.scopeType === "role" &&
      !!roleId &&
      m.scopeId === roleId &&
      (qualityFilter === "all" ||
        (qualityFilter === "pending"
          ? m.quality?.verification === "pending"
          : m.quality?.verification !== "pending")),
  );
  const memory = visible.find((m) => m.id === selected) ?? visible[0];
  const owner = roles.find((r) => r.id === roleId);
  return (
    <div className="detail memory-detail">
      <PageHeader
        section="记忆"
        title={scope === "role" && owner ? owner.name + "的记忆" : "长期记忆"}
        actions={kind==="long"?
          <button
            type="button"
            className="primary"
            onClick={() => setCreating(true)}
          >
            新增记忆
          </button>:undefined
        }
      />
      <div className="page-scroll">
        <div className="memory-page">
          <div className="seg memory-kind-tabs" role="group" aria-label="记忆类型"><button className={`seg-btn${kind==="long"?" on":""}`} aria-pressed={kind==="long"} onClick={()=>setKind("long")}>长期记忆</button><button className={`seg-btn${kind==="time"?" on":""}`} aria-pressed={kind==="time"} onClick={()=>setKind("time")}>时间记忆</button></div>
          {kind==="time"?(roleId?<TimeMemories key={roleId} roleId={roleId}/>:<p>请先选择角色。</p>):<>
          <div className="memory-toolbar">
            <div className="seg" role="group" aria-label="记忆状态">
              {(
                [
                  ["active", "有效记忆"],
                  ["forgotten", "已忘记"],
                  ["all", "全部状态"],
                ] as const
              ).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  className={`seg-btn${status === id ? " on" : ""}`}
                  aria-pressed={status === id}
                  onClick={() =>
                    useStore.setState({
                      memoryStatus: id,
                      selectedMemoryId: null,
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="memory-quality-filter">
              验证状态{" "}
              <select
                aria-label="验证状态筛选"
                value={qualityFilter}
                onChange={(e) =>
                  useStore.setState({
                    memoryVerification: e.target.value as
                      | "all"
                      | "ready"
                      | "pending",
                    selectedMemoryId: null,
                  })
                }
              >
                <option value="all">全部记录</option>
                <option value="ready">确认及旧版记录</option>
                <option value="pending">待核对</option>
              </select>
            </label>
            <span className="badge">仅当前角色</span>
            <span className="hint">{visible.length} 条记忆</span>
          </div>
          {roleId && <MemoryUsage key={roleId} roleId={roleId} memoryId={memory?.id} revision={memories} />}
          {visible.length ? (
            <div className="memory-workspace">
              <div className="memory-list" aria-label="记忆列表">
                {visible.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={`memory-list-item${memory?.id === m.id ? " selected" : ""}`}
                    onClick={() => useStore.getState().setSelectedMemory(m.id)}
                  >
                    <strong>{m.title}</strong>
                    <p>{m.summary || m.content.slice(0, 80)}</p>
                    <small>
                      {qualityLabel(m)} · v{m.version}
                    </small>
                  </button>
                ))}
              </div>
              {memory && (
                <MemoryEditor
                  key={`${memory.id}:${memory.version}`}
                  memory={memory}
                />
              )}
            </div>
          ) : (
            <div className="empty-state">
              <Icon name="memory" size={32} />
              <h2>还没有可展示的记忆</h2>
              <p>完成工作后保留经过验证的方法，也可以手动添加明确的偏好。</p>
              <button
                type="button"
                className="ghost"
                onClick={() => setCreating(true)}
              >
                新增一条记忆
              </button>
            </div>
          )}
          </>}
        </div>
      </div>
      {creating && <NewMemory onClose={() => setCreating(false)} />}
    </div>
  );
}
function MemoryEditor({ memory }: { memory: MemoryInfo }) {
  const [title, setTitle] = useState(memory.title),
    [content, setContent] = useState(memory.content),
    [editing, setEditing] = useState(false),
    [history, setHistory] = useState(false),
    [versions, setVersions] = useState<MemoryVersionInfo[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [category, setCategory] = useState(
      memory.quality?.category ?? "experience",
    ),
    [appliesTo, setAppliesTo] = useState(
      memory.quality?.appliesTo ?? "相关任务",
    ),
    [projectId, setProjectId] = useState(memory.quality?.projectId ?? "");
  const metadata = () => ({
    category,
    appliesTo: appliesTo.trim() || "相关任务",
    projectId: projectId || null,
  });
  useEffect(() => {
    let active = true;
    void invoke("memory:history", { memoryId: memory.id })
      .then((r) => {
        if (active) setVersions(r.versions ?? []);
      })
      .catch((e) => {
        if (active) setMessage(String(e));
      });
    return () => {
      active = false;
    };
  }, [memory.id, memory.version]);
  async function action(fn: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await fn();
      await reload();
      useStore.getState().setNotice({ level: "info", message: success });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="memory-editor">
      <div className="memory-meta">
        <span className={`scope-chip ${memory.scopeType}`}>
          {memory.scopeLabel}
        </span>
        <span className="badge">v{memory.version}</span>
        <span
          className={`badge memory-quality ${memory.quality?.verification ?? "legacy"}`}
        >
          {qualityLabel(memory)}
        </span>
      </div>
      <h2>{memory.title}</h2>
      <p className="hint">
        更新于 {new Date(memory.updatedAt).toLocaleString("zh-CN")}
      </p>
      {editing ? (
        <div className="form">
          <label className="field">
            <span>标题</span>
            <input
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            <span>内容</span>
            <textarea
              value={content}
              rows={9}
              maxLength={20000}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <MemoryFields
            {...{
              category,
              setCategory,
              appliesTo,
              setAppliesTo,
              projectId,
              setProjectId,
            }}
          />
          <div className="bar-actions">
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                setTitle(memory.title);
                setContent(memory.content);
                setCategory(memory.quality?.category ?? "experience");
                setAppliesTo(memory.quality?.appliesTo ?? "相关任务");
                setProjectId(memory.quality?.projectId ?? "");
                setEditing(false);
              }}
            >
              取消编辑
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !title.trim() || !content.trim()}
              onClick={() =>
                void action(
                  () =>
                    invoke("memory:revise", {
                      memoryId: memory.id,
                      title: title.trim(),
                      content,
                      reason: "用户在记忆页纠错",
                      expectedVersion: memory.version,
                      ...metadata(),
                    }),
                  "记忆已修正，保留原有版本",
                )
              }
            >
              {busy ? "保存中…" : "保存修正"}
            </button>
          </div>
        </div>
      ) : (
        <div className="memory-prose">{memory.content}</div>
      )}
      {!editing &&
        memory.status === "active" &&
        memory.quality?.verification === "pending" && (
          <MemoryReview memory={memory} onChanged={reload} />
        )}
      <div className="memory-origin">
        <h3>适用范围与来源</h3>
        <p className="hint">
          {memory.quality?.category === "preference"
            ? "工作偏好"
            : "可复用经验"}{" "}
          · {memory.quality?.appliesTo ?? "相关任务"}。
          {memory.quality?.projectId
            ? "仅在指定项目使用。"
            : "仅本角色在相关任务中检索。"}
        </p>
        <p className="hint">
          来源：
          {
            {
              builtin: "应用内置",
              manual: "用户手动记录",
              agent: "对话中的模型候选",
              workbench: "工作台验收",
              legacy: "旧版记录",
            }[memory.quality?.source ?? "legacy"]
          }
        </p>
        {memory.quality?.evidence && (
          <div className="memory-evidence">
            <strong>
              {memory.quality.source === "agent" &&
              memory.quality.verification === "pending"
                ? "模型提供的依据（未验证）"
                : "记录依据"}
            </strong>
            <p>{memory.quality.evidence}</p>
          </div>
        )}
        {memory.quality?.note && <p className="hint">{memory.quality.note}</p>}
        {memory.sourceDeleted ? (
          <p className="hint">原任务已删除</p>
        ) : memory.sourceTaskId ? (
          <button
            type="button"
            className="ghost"
            onClick={() =>
              void action(async () => {
                if (memory.sourceWorkbenchId) {
                  await selectWorkbench(memory.sourceWorkbenchId);
                  useStore.getState().setTool("collaboration");
                } else {
                  await openTask(memory.sourceTaskId!);
                  useStore.getState().setTool("workbench");
                }
              }, "已打开来源会话")
            }
          >
            查看来源任务 <Icon name="chevron" size={14} />
          </button>
        ) : (
          <p className="hint">手动记录或未关联来源任务</p>
        )}
      </div>
      {message && (
        <p className="hint danger" role="alert">
          {message}
        </p>
      )}
      <div className="detail-foot">
        <button
          type="button"
          className="ghost"
          aria-expanded={history}
          onClick={() => setHistory((v) => !v)}
        >
          版本记录
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() =>
            void action(
              () =>
                invoke(
                  memory.status === "active"
                    ? "memory:forget"
                    : "memory:restore",
                  { memoryId: memory.id },
                ),
              memory.status === "active" ? "已忘记这条记忆" : "已恢复记忆",
            )
          }
        >
          {memory.status === "active" ? "忘记" : "撤销忘记"}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          编辑与纠错
        </button>
      </div>
      {history && (
        <section className="history-block">
          <h3>版本历史</h3>
          {[...versions].reverse().map((v) => (
            <div className="history-item" key={v.ver}>
              <div className="history-head">
                v{v.ver} · {new Date(v.createdAt).toLocaleString("zh-CN")}{" "}
                {v.reason}
              </div>
              <p className="memory-content">{v.content}</p>
              {v.quality && (
                <p className="hint">
                  {v.quality.appliesTo} · {v.quality.evidence || "无验证依据"}
                </p>
              )}
              {v.ver !== memory.version && (
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() =>
                    void action(
                      () =>
                        invoke("memory:revise", {
                          memoryId: memory.id,
                          title: v.title,
                          content: v.content,
                          reason: `恢复历史版本 v${v.ver}`,
                          expectedVersion: memory.version,
                          ...(v.quality
                            ? {
                                category: v.quality.category,
                                appliesTo: v.quality.appliesTo,
                                projectId: v.quality.projectId,
                              }
                            : {}),
                        }),
                      "历史内容已恢复为新版本",
                    )
                  }
                >
                  恢复为新版本
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </section>
  );
}
function NewMemory({ onClose }: { onClose: () => void }) {
  const roles = useStore((s) => s.roles),
    initial = useStore.getState();
  const scope = "role" as const;
  const [owner, setOwner] = useState(
      roles.some((r) => r.id === initial.memoryRoleId)
        ? initial.memoryRoleId!
        : roles[0]?.id || "",
    ),
    [title, setTitle] = useState(""),
    [content, setContent] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [category, setCategory] = useState<"experience" | "preference">(
      "experience",
    ),
    [appliesTo, setAppliesTo] = useState(""),
    [projectId, setProjectId] = useState("");
  const validOwner = roles.some((r) => r.id === owner);
  async function save() {
    if (busy || !title.trim() || !content.trim() || !validOwner) return;
    setBusy(true);
    try {
      const m = await invoke("memory:write", {
        scopeType: scope,
        scopeId: owner,
        title: title.trim(),
        content: content.trim(),
        ...(category !== "experience" || appliesTo.trim() || projectId
          ? {
              category,
              appliesTo: appliesTo.trim() || "相关任务",
              projectId: projectId || null,
            }
          : {}),
      });
      useStore.setState({
        memoryScope: scope,
        memoryRoleId: owner,
        memoryQuery: "",
        memoryStatus: "active",
        memoryVerification: "all",
        selectedMemoryId: m.id,
      });
      try {
        await reload();
      } catch (e) {
        useStore.getState().setNotice({
          level: "error",
          message: "记忆已保存，但列表刷新失败。请重新打开记忆页。",
        });
      }
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-mask">
      <div
        className="modal small"
        role="dialog"
        aria-modal="true"
        aria-label="新增记忆"
      >
        <div className="dialog-heading">
          <h2>新增记忆</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭新增记忆"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <p className="hint">选择明确归属，保存可复用的方法与偏好。</p>
        <div className="form">
          <label className="field">
            <span>归属角色</span>
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">请选择角色</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>标题</span>
            <input
              autoFocus
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            <span>内容</span>
            <textarea
              rows={6}
              value={content}
              maxLength={20000}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <MemoryFields
            {...{
              category,
              setCategory,
              appliesTo,
              setAppliesTo,
              projectId,
              setProjectId,
            }}
          />
        </div>
        {error && (
          <p className="hint danger" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !title.trim() || !content.trim() || !validOwner}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存记忆"}
          </button>
        </div>
      </div>
    </div>
  );
}
