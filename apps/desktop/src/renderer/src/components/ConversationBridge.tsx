import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type {
  Attachment,
  Workbench,
  WorkbenchAttachment,
} from "@pi-harness/contracts";
import { useStore } from "../store.js";
import { invoke } from "../api.js";
import { openTask, refreshTaskList } from "../data.js";
import { selectWorkbench, updateWorkbenchView } from "../workbench-data.js";
import Icon from "./Icon.js";
export function ToWorkbenchButton({
  entryId,
  text,
}: {
  entryId: string;
  text: string;
}) {
  const taskId = useStore((s) => s.currentTaskId),
    roles = useStore((s) => s.roles),
    source = useStore((s) => s.tasks.find((t) => t.id === s.currentTaskId));
  const [open, setOpen] = useState(false),
    [title, setTitle] = useState(""),
    [summary, setSummary] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const requestId = useRef(crypto.randomUUID()),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function create() {
    if (!taskId || busy || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      const w = await invoke("workbench:fromConversation", {
        taskId,
        entryId,
        requestId: requestId.current,
        title: title.trim(),
        summary: summary.trim(),
        roleIds: selected,
        confirmed: true,
      });
      if (!active.current || useStore.getState().currentTaskId !== taskId)
        return;
      await selectWorkbench(w.id);
      if (!active.current) return;
      useStore.getState().setTool("collaboration");
      setOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="msg-action"
        disabled={!taskId}
        onClick={() => {
          setTitle(((source?.title ?? "对话成果") + " · 工作台").slice(0, 200));
          setSummary(text.slice(0, 4000));
          setSelected(
            roles.some(
              (r) =>
                r.id === source?.roleId &&
                !r.isDefault &&
                r.status === "active",
            )
              ? [source!.roleId!]
              : [],
          );
          setConfirmed(false);
          setError("");
          requestId.current = crypto.randomUUID();
          setOpen(true);
        }}
      >
        <Icon name="grid" size={14} />
        转入工作台
      </button>
      {open &&
        createPortal(
          <div className="modal-mask">
            <section
              className="modal bridge-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="从对话创建工作台"
              onKeyDown={(e) => {
                if (e.key === "Escape" && !busy) setOpen(false);
              }}
            >
              <div className="dialog-heading">
                <h2>从成果继续协作</h2>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="关闭转入工作台"
                  disabled={busy}
                  onClick={() => setOpen(false)}
                >
                  <Icon name="close" />
                </button>
              </div>
              <p className="hint">
                只带入你确认的摘要、所选角色和当前项目位置。初始摘要最多取所选回复的前4000字，可自行修改。原始历史、思考、附件及执行权限不会复制。创建后等待你提出要求。
              </p>
              <label className="field">
                <span>工作台名称</span>
                <input
                  disabled={busy}
                  value={title}
                  maxLength={200}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <label className="field">
                <span>交接摘要</span>
                <textarea
                  disabled={busy}
                  value={summary}
                  maxLength={4000}
                  rows={7}
                  onChange={(e) => {
                    setSummary(e.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <fieldset className="bridge-roles">
                <legend>参与角色（最多8位，可稍后推荐）</legend>
                {roles
                  .filter((r) => !r.isDefault && r.status === "active")
                  .map((r) => (
                    <label key={r.id}>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={selected.includes(r.id)}
                        onChange={(e) => {
                          setSelected(
                            e.target.checked
                              ? [...selected, r.id]
                              : selected.filter((id) => id !== r.id),
                          );
                          setConfirmed(false);
                        }}
                      />
                      {r.name}
                    </label>
                  ))}
              </fieldset>
              <label className="memory-review-confirm">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已核对交接摘要和参与角色
              </label>
              {error && (
                <p role="alert" className="danger">
                  {error}
                </p>
              )}
              <div className="bar-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => setOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={
                    busy ||
                    !confirmed ||
                    !title.trim() ||
                    !summary.trim() ||
                    selected.length > 8
                  }
                  onClick={() => void create()}
                >
                  {busy ? "创建中…" : "创建工作台草稿"}
                </button>
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
export function SingleRoleDialog({
  w,
  roleId,
  text,
  files,
  onClose,
}: {
  w: Workbench;
  roleId: string;
  text: string;
  files: WorkbenchAttachment[];
  onClose: () => void;
}) {
  const [summary, setSummary] = useState(text),
    [selected, setSelected] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const created = useRef<string | null>(null),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const role = useStore((s) => s.roles.find((r) => r.id === roleId));
  async function create() {
    if (busy || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      const attachments: Attachment[] = await Promise.all(
        selected.map(async (attachmentId) => {
          const r = await invoke("workbench:readAttachment", {
            id: w.id,
            attachmentId,
          });
          return {
            kind: r.attachment.kind,
            name: r.attachment.name,
            mimeType: r.attachment.mimeType,
            data:
              r.attachment.kind === "text"
                ? new TextDecoder("utf-8", { fatal: true }).decode(
                    Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)),
                  )
                : r.data,
          };
        }),
      );
      if (!active.current) return;
      if (!created.current)
        created.current = (
          await invoke("task:create", {
            roleId,
            projectId: w.projectId ?? undefined,
            title: (w.title + " · 对话").slice(0, 200),
          })
        ).id;
      if (!active.current) return;
      await openTask(created.current);
      await refreshTaskList();
      if (!active.current) return;
      useStore.setState({
        pendingCompose: { taskId: created.current, text: summary, attachments },
      });
      useStore.getState().setTool("workbench");
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return createPortal(
    <div className="modal-mask">
      <section
        className="modal bridge-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="使用单角色对话"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
        }}
      >
        <div className="dialog-heading">
          <h2>与{role?.name ?? "所选角色"}继续对话</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭单角色入口"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <p className="hint">
          新对话使用当前角色卡配置。将下方要求放入输入框，确认发送后才执行。原工作台的消息、草稿和附件保留，不复制其他角色的历史或权限。
        </p>
        <label className="field">
          <span>带入的要求</span>
          <textarea
            rows={6}
            maxLength={16000}
            disabled={busy}
            value={summary}
            onChange={(e) => {
              setSummary(e.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        {!!files.length && (
          <fieldset className="bridge-roles">
            <legend>同时带入的附件（由你选择）</legend>
            {files.map((f) => (
              <label key={f.id}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selected.includes(f.id)}
                  onChange={(e) => {
                    setSelected(
                      e.target.checked
                        ? [...selected, f.id]
                        : selected.filter((id) => id !== f.id),
                    );
                    setConfirmed(false);
                  }}
                />
                {f.name}
              </label>
            ))}
          </fieldset>
        )}
        <label className="memory-review-confirm">
          <input
            type="checkbox"
            disabled={busy}
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          我已核对要求、角色和附件范围
        </label>
        {error && (
          <p role="alert" className="danger">
            {error}
          </p>
        )}
        <div className="bar-actions">
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
              !confirmed ||
              !role ||
              role.status !== "active" ||
              selected.length > 6
            }
            onClick={() => void create()}
          >
            {busy ? "准备中…" : "打开单角色对话"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
