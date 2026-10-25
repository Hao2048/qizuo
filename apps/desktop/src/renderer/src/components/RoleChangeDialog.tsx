import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RoleChangePreview } from "@pi-harness/contracts";
import { invoke } from "../api.js";
import { useStore } from "../store.js";
import { refreshTaskList, openTask } from "../data.js";
import { refreshWorkbenches } from "../workbench-data.js";
import Icon from "./Icon.js";
export default function RoleChangeDialog({
  id,
  roleId,
  roleName,
  mode,
  unavailable,
  excluded = [],
  onClose,
}: {
  id: string;
  roleId: string;
  roleName: string;
  mode: "task" | "workbench";
  unavailable?: boolean;
  excluded?: string[];
  onClose: () => void;
}) {
  const roles = useStore((s) => s.roles).filter(
    (r) =>
      r.status === "active" &&
      (mode === "task" || !r.isDefault) &&
      (!excluded.includes(r.id) || r.id === roleId),
  );
  const [target, setTarget] = useState(unavailable ? "" : roleId),
    [preview, setPreview] = useState<RoleChangePreview | null>(null),
    [summary, setSummary] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const version = useRef(0),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const token = ++version.current;
    setPreview(null);
    setConfirmed(false);
    setError("");
    setLoading(false);
    if (!target) return;
    setLoading(true);
    const request =
      mode === "workbench"
        ? invoke("workbench:roleChangePreview", {
            id,
            roleId,
            targetRoleId: target,
          })
        : invoke("task:roleChangePreview", {
            taskId: id,
            targetRoleId: target,
          });
    void request
      .then((r) => {
        if (version.current === token) setPreview(r);
      })
      .catch((e) => {
        if (version.current === token) setError(String(e));
      })
      .finally(() => {
        if (version.current === token) setLoading(false);
      });
    return () => {
      version.current++;
    };
  }, [id, roleId, target, mode, retry]);
  async function apply() {
    if (!preview || busy) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "workbench") {
        await invoke("workbench:applyRoleChange", {
          id,
          roleId,
          targetRoleId: target,
          token: preview.token,
          summary: summary.trim(),
          confirmed: true,
        });
        await refreshWorkbenches();
      } else {
        const task = await invoke("task:applyRoleChange", {
          taskId: id,
          targetRoleId: target,
          token: preview.token,
          summary: summary.trim(),
          confirmed: true,
        });
        await refreshTaskList();
        await openTask(task.id);
      }
      onClose();
    } catch (e) {
      setError(String(e));
      setConfirmed(false);
    } finally {
      setBusy(false);
    }
  }
  return createPortal(
    <div className="modal-mask">
      <section
        className="modal role-change-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="角色配置与职责交接"
      >
        <header>
          <h2>角色配置与职责交接</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭角色变更"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <p className="hint">
          当前角色：{roleName}
          {unavailable ? "（已归档或不可用）" : ""}
          。变更只影响此任务，历史记录仍会保留。
        </p>
        <label>
          使用角色
          <select
            aria-label="接续角色"
            value={target}
            disabled={busy}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">选择可用角色…</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.id === roleId ? " · 同步当前角色配置" : ""}
              </option>
            ))}
          </select>
        </label>
        {loading && <p role="status">正在核对角色配置与成果…</p>}
        {preview && (
          <>
            <h3>
              {preview.kind === "sync"
                ? "配置变更预览"
                : `${preview.fromName} → ${preview.toName}`}
            </h3>
            <div className="role-change-diff">
              {preview.changes.length ? (
                preview.changes.map((c) => (
                  <details key={c.label}>
                    <summary>{c.label}</summary>
                    <div className="role-change-values">
                      <div>
                        <small>原配置</small>
                        <pre>{c.before || "未设置"}</pre>
                      </div>
                      <div>
                        <small>新配置</small>
                        <pre>{c.after || "未设置"}</pre>
                      </div>
                    </div>
                  </details>
                ))
              ) : (
                <p className="hint">配置没有变化。</p>
              )}
            </div>
            <p>
              <strong>职责：</strong>
              {preview.responsibility}
            </p>
            {!!preview.ownedPaths.length && (
              <p>
                <strong>文件范围：</strong>
                {preview.ownedPaths.join("、")}
              </p>
            )}
            {!!preview.files.length && (
              <details>
                <summary>保留 {preview.files.length} 项文件变化</summary>
                <ul className="role-change-files">
                  {preview.files.map((f) => (
                    <li key={f.path}>
                      {f.path} ·{" "}
                      {f.kind === "added"
                        ? "新增"
                        : f.kind === "deleted"
                          ? "删除"
                          : "修改"}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {!!preview.contracts.length && (
              <p className="hint">
                相关共同约定：{preview.contracts.join("、")}
                。更换角色后需按新版本重新验证。
              </p>
            )}
            <p className="hint">
              {preview.kind === "sync"
                ? mode === "task"
                  ? "新配置从下次请求生效；会话中的手动模型选择仍优先。"
                  : "新配置从下次请求生效，不会自动开始执行。"
                : "不复制原角色的私有会话、思考或记忆。"}
              {mode === "workbench"
                ? preview.kind === "handover"
                  ? "更换后的角色保持暂停；文件成果会在恢复执行时复制到独立目录，命令、网络和插件权限需重新设置。"
                  : "命令、网络和插件权限需重新设置。"
                : preview.kind === "handover"
                  ? "将建立一个接续会话，只携带你下面确认的交接说明和项目位置；不自动执行。"
                  : ""}
            </p>
            {preview.blockedReason && (
              <p className="wb-error" role="alert">
                {preview.blockedReason}
              </p>
            )}
            <label>
              {preview.kind === "sync" ? "变更说明" : "确认交接给新角色的说明"}
              <textarea
                aria-label="角色变更说明"
                value={summary}
                maxLength={4000}
                disabled={busy}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="说明职责、已完成的成果和接下来需要处理的事项…"
              />
            </label>
            <label className="role-change-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy || !!preview.blockedReason}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              我已核对角色配置、职责和成果范围
            </label>
          </>
        )}
        {error && (
          <div role="alert" className="wb-error">
            {error}
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => setRetry((n) => n + 1)}
            >
              重新预览
            </button>
          </div>
        )}
        <footer>
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
            disabled={
              busy ||
              loading ||
              !preview ||
              !!preview.blockedReason ||
              !confirmed ||
              !summary.trim() ||
              (preview.kind === "sync" && !preview.changed)
            }
            onClick={() => void apply()}
          >
            {busy
              ? "正在处理…"
              : preview?.kind === "handover"
                ? "确认职责交接"
                : "确认同步配置"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
export function TaskRoleControls() {
  const id = useStore((s) => s.currentTaskId),
    tasks = useStore((s) => s.tasks),
    roles = useStore((s) => s.roles);
  const task = tasks.find((t) => t.id === id);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [id]);
  if (!id || !task?.roleId) return null;
  const unavailable =
    roles.length > 0 &&
    !roles.some((r) => r.id === task.roleId && r.status === "active");
  return (
    <>
      {task.roleSuccessorId && (
        <button
          type="button"
          className="ghost"
          onClick={() =>
            void openTask(task.roleSuccessorId!).catch((e) =>
              useStore
                .getState()
                .setNotice({ level: "error", message: String(e) }),
            )
          }
        >
          打开接续会话
        </button>
      )}
      {unavailable && <span className="role-unavailable">角色不可用</span>}
      <button type="button" className="ghost" onClick={() => setOpen(true)}>
        角色配置
      </button>
      {open && (
        <RoleChangeDialog
          id={id}
          roleId={task.roleId}
          roleName={task.roleName ?? "原角色"}
          mode="task"
          unavailable={unavailable}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
