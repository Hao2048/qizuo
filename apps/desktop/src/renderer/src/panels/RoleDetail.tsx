import {createPortal} from "react-dom";
import PageHeader from "../components/PageHeader.js";
import RoleAvatar from "../components/RoleAvatar.js";
import { useEffect, useState } from "react";
import type { RoleInfo,CommandOutput } from "@pi-harness/contracts";
import { invoke } from "../api.js";
import { useStore } from "../store.js";
import { refreshBindable, refreshRoles } from "../data.js";

const ROLE_TABS = [
  { id: "basic", label: "基本信息" },
  { id: "resources", label: "技能与插件" },
  { id: "model", label: "模型与思考" },
];
const THINKING_LABELS: Record<string, string> = {
  跟随默认: "自动（跟随应用默认）",
  off: "关闭",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
};
const THINKING_LEVELS = [
  "跟随默认",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** 角色卡右列：编辑器（内联，不再弹窗）。 */
export default function RoleDetail(): React.ReactElement {
  const selected = useStore((s) => s.selectedRoleId);
  const roles = useStore((s) => s.roles);
  const bindable = useStore((s) => s.bindable);
  const role =
    selected === "new" ? null : (roles.find((r) => r.id === selected) ?? null);

  useEffect(() => {
    if (bindable.length === 0) void refreshBindable().catch(() => {});
  }, [bindable.length]);

  if (!selected) {
    return (
      <div className="detail center">
        <div className="empty-state">
          <span className="empty-badge">角色卡</span>
          <h2>选择或新建角色</h2>
          <p>左列选择角色查看能力与工作方式；「＋」新建角色。</p>
        </div>
      </div>
    );
  }

  return <RoleEditor key={selected} role={role} bindable={bindable} />;
}

function RoleEditor({
  role,
  bindable,
}: {
  role: RoleInfo | null;
  bindable: Array<{ name: string; kind: "skill" | "package" }>;
}): React.ReactElement {
  const [impact,setImpact]=useState<CommandOutput<'role:impact'>|null>(null);
  const providers = useStore((s) => s.providers);
  const [name, setName] = useState(role?.name ?? "");
  const [intro, setIntro] = useState(role?.intro ?? "");
  const [systemPrompt, setSystemPrompt] = useState(role?.systemPrompt ?? "");
  const [modelProvider, setModelProvider] = useState(
    role?.preferredModel?.provider ?? "",
  );
  const [modelId, setModelId] = useState(role?.preferredModel?.modelId ?? "");
  const [thinking, setThinking] = useState(role?.preferredThinking ?? "");
  const [boundSkills, setBoundSkills] = useState<string[]>(
    role?.boundSkills ?? [],
  );
  const [boundPlugins, setBoundPlugins] = useState<string[]>(
    role?.boundPlugins ?? [],
  );
  const [tab, setTab] = useState("basic");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);

  const usable = providers.filter(
    (p) => p.authConfigured && p.models.length > 0,
  );
  const modelOptions = usable.find((p) => p.id === modelProvider)?.models ?? [];

  const save = async () => {
    if (!name.trim()) {
      setError("名称必填");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        intro,
        systemPrompt,
        boundSkills,
        boundPlugins,
        preferredModel:
          modelProvider && modelId
            ? { provider: modelProvider, modelId }
            : null,
        preferredThinking:
          thinking && thinking !== "跟随默认" ? thinking : null,
      };
      if (role) {
        const updated = await invoke("role:update", {
          roleId: role.id,
          ...payload,
        });
        await refreshRoles();
        useStore
          .getState()
          .setNotice({ level: "info", message: `已保存角色：${updated.name}。已有任务仍使用原配置，可在任务中预览后同步。` });
      } else {
        const created = await invoke("role:create", payload);
        await refreshRoles();
        useStore.getState().setSelectedRole(created.id);
        useStore
          .getState()
          .setNotice({ level: "info", message: `已创建角色：${created.name}` });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const previewArchive=async()=>{if(!role||busy)return;setBusy(true);setError(null);try{setImpact(await invoke('role:impact',{roleId:role.id}));}catch(e){setError(String(e));}finally{setBusy(false);}};
  const archive = async (archived: boolean) => {
    if (!role || role.isDefault || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("role:archive", { roleId: role.id, archived });
      if (archived) useStore.getState().setSelectedRole(null);
      await refreshRoles(true);
      useStore.getState().setNotice({
        level: "info",
        message: archived ? "角色已归档" : "角色已恢复",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="detail role-detail">
      {impact&&role&&createPortal(<div className="modal-mask"><section className="modal role-change-dialog" role="dialog" aria-modal="true" aria-label="确认归档角色"><h2>归档 {role.name}</h2><p>影响 {impact.total} 项对话或工作台任务。相关执行会停止，历史与文件成果保留；恢复角色不会自动恢复任务。</p><ul>{impact.tasks.map(t=><li key={t.id}>对话 · {t.title}</li>)}{impact.workbenches.map(w=><li key={w.id}>工作台 · {w.title}</li>)}</ul><p className="hint">列表最多展示每类 100 项。之后由你选择替代角色并确认职责交接，不会自动替换。</p>{error&&<p role="alert">{error}</p>}<footer><button className="ghost" disabled={busy} onClick={()=>setImpact(null)}>取消</button><button className="primary" disabled={busy} onClick={()=>void archive(true)}>确认归档并停止相关任务</button></footer></section></div>,document.body)}
      <PageHeader
        section="角色卡"
        title={role ? role.name : "新建角色"}
        tabs={ROLE_TABS}
        value={tab}
        onTab={setTab}
        actions={
          <>
            {role && (
              <>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => setCloning(true)}
                >
                  克隆角色
                </button>
                {!role.isDefault && (
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => void (role.status==='active'?previewArchive():archive(false))}
                  >
                    {role.status === "active" ? "归档" : "恢复"}
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "保存中…" : "保存"}
            </button>
          </>
        }
      />
      <div className="page-scroll">
        <div className="role-editor-body">
          <div className="role-hero">
            <RoleAvatar name={name || "新角色"} isDefault={role?.isDefault} />
            <div>
              <h2>{name || "新角色"}</h2>
              <p className="hint">{intro || "定义专业能力与工作方式"}</p>
            </div>
            {role?.isDefault && (
              <span className="badge">系统角色 · 可克隆</span>
            )}
          </div>
          <div className="form">
            <section className="role-tab-content" hidden={tab !== "basic"}>
              <label className="field">
                <span>角色名称</span>
                <input
                  readOnly={!!role?.isDefault}
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="如：代码评审员"
                />
              </label>
              <label className="field">
                <span>简介</span>
                <textarea
                  readOnly={!!role?.isDefault}
                  value={intro}
                  maxLength={2000}
                  rows={2}
                  onChange={(e) => setIntro(e.target.value)}
                  placeholder="做什么、具备什么能力"
                />
              </label>
              <label className="field">
                <span>角色提示词</span>
                <textarea
                  readOnly={!!role?.isDefault}
                  value={systemPrompt}
                  maxLength={24000}
                  rows={8}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="留空则使用框架默认提示词"
                />
              </label>
            </section>
            <section className="role-tab-content" hidden={tab !== "resources"}>
              <h2>绑定能力</h2>
              <p className="hint">只为当前角色选择工作时需要的技能与插件。</p>
              <div className="field-row">
                <BindSelect
                  label="绑定 Skill"
                  items={bindable
                    .filter((b) => b.kind === "skill")
                    .map((b) => b.name)}
                  selected={boundSkills}
                  onChange={setBoundSkills}
                />
                <BindSelect
                  label="绑定插件"
                  items={bindable
                    .filter((b) => b.kind === "package")
                    .map((b) => b.name)}
                  selected={boundPlugins}
                  onChange={setBoundPlugins}
                />
              </div>
              <p className="hint">
                绑定的资源在任务中优先使用；「私有」资源仅绑定它的角色可用。
              </p>
            </section>
            <section className="role-tab-content" hidden={tab !== "model"}>
              <h2>角色推荐配置</h2>
              <p className="hint">
                对话选择自动时，跟随这个角色的推荐模型与思考强度。
              </p>
              <div className="field-row">
                <label className="field">
                  <span>偏好模型</span>
                  <select
                    value={modelProvider}
                    onChange={(e) => {
                      setModelProvider(e.target.value);
                      setModelId("");
                    }}
                  >
                    <option value="">跟随应用默认</option>
                    {usable.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>模型</span>
                  <select
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    disabled={!modelProvider}
                  >
                    <option value="">（先选提供商）</option>
                    {modelOptions.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>思考模式</span>
                  <select
                    value={thinking}
                    onChange={(e) => setThinking(e.target.value)}
                  >
                    {THINKING_LEVELS.map((t) => (
                      <option key={t} value={t}>
                        {THINKING_LABELS[t] ?? t}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>
            {role ? (
              <div className="role-memory-link">
                <div>
                  <h3>角色记忆</h3>
                  <p className="hint">在独立记忆窗口查看、纠错和管理来源。</p>
                </div>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    useStore.setState({
                      memoryScope: "role",
                      memoryRoleId: role.id,
                      selectedMemoryId: null,
                    });
                    useStore.getState().setTool("memory");
                  }}
                >
                  查看角色记忆 →
                </button>
              </div>
            ) : null}
            {error ? <p className="hint danger">{error}</p> : null}
          </div>

          <footer className="detail-foot">
            <button
              type="button"
              className="ghost"
              onClick={() => useStore.getState().setSelectedRole(null)}
            >
              关闭
            </button>
          </footer>
        </div>
      </div>
      {cloning && role ? (
        <CloneDialog role={role} onClose={() => setCloning(false)} />
      ) : null}
    </div>
  );
}

function BindSelect({
  label,
  items,
  selected,
  onChange,
}: {
  label: string;
  items: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="bind-select">
      <button
        type="button"
        className="bind-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="bind-label">{label}</span>
        <span className="bind-value">
          {selected.length > 0 ? selected.join("、") : "未绑定（点击选择）"}
        </span>
        <span className="bind-arrow">{open ? "▲" : "▼"}</span>
      </button>
      {open ? (
        <div className="bind-list">
          {items.length === 0 ? (
            <div className="popover-empty">
              先在市场安装{label === "绑定 Skill" ? "技能" : "包"}
            </div>
          ) : (
            items.map((name) => (
              <label key={name} className="bind-item">
                <input
                  type="checkbox"
                  checked={selected.includes(name)}
                  onChange={() =>
                    onChange(
                      selected.includes(name)
                        ? selected.filter((s) => s !== name)
                        : [...selected, name],
                    )
                  }
                />
                <span>{name}</span>
              </label>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function CloneDialog({
  role,
  onClose,
}: {
  role: RoleInfo;
  onClose: () => void;
}): React.ReactElement {
  const [withMemory, setWithMemory] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div
      className="modal-mask"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal small anim-pop"
        role="dialog"
        aria-modal="true"
        aria-label="克隆角色"
      >
        <h2>克隆角色 · {role.name}</h2>
        <p className="hint">克隆后新角色身份独立，后续编辑与记忆互不影响。</p>
        <div className="clone-options">
          <label className={`clone-option${withMemory ? "" : " selected"}`}>
            <input
              type="radio"
              checked={!withMemory}
              onChange={() => setWithMemory(false)}
            />
            <div>
              <strong>仅复制配置</strong>
              <p>提示词、偏好模型等；不带记忆</p>
            </div>
          </label>
          <label className={`clone-option${withMemory ? " selected" : ""}`}>
            <input
              type="radio"
              checked={withMemory}
              onChange={() => setWithMemory(true)}
            />
            <div>
              <strong>配置和记忆快照</strong>
              <p>复制当前 {role.memoryCount} 条记忆为私有副本</p>
            </div>
          </label>
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
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const created = await invoke("role:clone", {
                  roleId: role.id,
                  withMemory,
                });
                await refreshRoles();
                useStore.getState().setSelectedRole(created.id);
                onClose();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "克隆中…" : "克隆"}
          </button>
        </div>
      </div>
    </div>
  );
}
