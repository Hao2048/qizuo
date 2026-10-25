import { useEffect, useRef, useState } from "react";
import type { WorkbenchAttachment } from "@pi-harness/contracts";
import { createPortal } from "react-dom";
import { invoke } from "../api.js";
import { useCollaboration, updateWorkbenchView } from "../workbench-data.js";
import Icon from "./Icon.js";
export function WorkbenchFilePicker({
  id,
  disabled,
  onBusy,
  onError,
}: {
  id: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null),
    reader = useRef<FileReader | null>(null),
    cancelled = useRef(false);
  const files = useCollaboration((s) => s.views[id]?.attachments ?? EMPTY);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      reader.current?.abort();
    };
  }, []);
  async function pick(selected: FileList | null) {
    if (!selected || reading) return;
    setReading(true);
    onBusy(true);
    updateWorkbenchView(id, {
      attachments: [
        ...(useCollaboration.getState().views[id]?.attachments ?? []),
      ],
    });
    try {
      for (const file of Array.from(selected)) {
        if (cancelled.current) break;
        const current = useCollaboration.getState().views[id];
        if (!current) break;
        if ((current.attachments?.length ?? 0) >= 6)
          throw Error("每次最多添加 6 个附件");
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
        const mime =
          file.type ||
          (
            {
              png: "image/png",
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              gif: "image/gif",
              webp: "image/webp",
            } as Record<string, string>
          )[ext] ||
          "text/plain";
        const kind = mime.startsWith("image/") ? "image" : "text";
        if (
          !file.size ||
          file.size > (kind === "image" ? 4.5 * 1024 * 1024 : 64 * 1024)
        )
          throw Error(
            `${file.name}：图片限 4.5 MB，文本限 64 KB，不能添加空文件`,
          );
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          reader.current = r;
          r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
          r.onerror = () => reject(Error("读取文件失败：" + file.name));
          r.onabort = () => reject(Error("已取消读取"));
          r.readAsDataURL(file);
        });
        if (cancelled.current) break;
        const attached = await invoke("workbench:attach", {
          id,
          name: file.name,
          kind,
          mimeType: mime,
          data,
        });
        const draft = useCollaboration.getState().views[id];
        if (cancelled.current || !draft) {
          await invoke("workbench:discardAttachment", {
            id,
            attachmentId: attached.id,
          }).catch(() => {});
          break;
        }
        updateWorkbenchView(id, {
          attachments: [...(draft.attachments ?? []), attached],
        });
      }
    } catch (e) {
      if (!cancelled.current)
        onError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!cancelled.current) {
        setReading(false);
        onBusy(false);
        if (input.current) input.current.value = "";
      }
    }
  }
  async function remove(file: WorkbenchAttachment) {
    try {
      await invoke("workbench:discardAttachment", {
        id,
        attachmentId: file.id,
      });
      const draft = useCollaboration.getState().views[id];
      if (draft)
        updateWorkbenchView(id, {
          attachments: (draft.attachments ?? []).filter(
            (f) => f.id !== file.id,
          ),
        });
    } catch (e) {
      onError(String(e));
    }
  }
  return (
    <div className="wb-attachment-draft">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="选择工作台附件"
        onChange={(e) => void pick(e.target.files)}
      />
      <button
        type="button"
        className="ghost wb-file-button"
        disabled={disabled || reading}
        onClick={() => input.current?.click()}
      >
        <Icon name="file" size={15} />
        {reading ? "正在读取…" : "文件"}
      </button>
      {files.map((file) => (
        <span className="wb-attachment-chip" key={file.id}>
          <Icon name="file" size={14} />
          <span title={file.name}>{file.name}</span>
          <small>{Math.ceil(file.bytes / 1024)} KB</small>
          <button
            type="button"
            className="icon-button"
            aria-label={"移除附件 " + file.name}
            disabled={disabled || reading}
            onClick={() => void remove(file)}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
      {!!files.length && (
        <small className="wb-attachment-hint">
          发送后仅分配给需要的接收角色
        </small>
      )}
    </div>
  );
}
const EMPTY: WorkbenchAttachment[] = [];
export function WorkbenchMessageFiles({
  id,
  files,
  roleName,
}: {
  id: string;
  files: WorkbenchAttachment[];
  roleName: (id: string) => string;
}) {
  const [opened, setOpened] = useState<{
      attachment: WorkbenchAttachment;
      data: string;
    } | null>(null),
    [loading, setLoading] = useState<string | null>(null),
    [error, setError] = useState("");
  const version = useRef(0),
    close = useRef<HTMLButtonElement>(null);
  useEffect(
    () => () => {
      version.current++;
    },
    [id],
  );
  useEffect(() => {
    if (!opened) return;
    close.current?.focus();
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpened(null);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [opened]);
  async function read(file: WorkbenchAttachment) {
    const token = ++version.current;
    setLoading(file.id);
    setError("");
    try {
      const r = await invoke("workbench:readAttachment", {
        id,
        attachmentId: file.id,
      });
      if (version.current === token) setOpened(r);
    } catch (e) {
      if (version.current === token) setError(String(e));
    } finally {
      if (version.current === token) setLoading(null);
    }
  }
  function reuse(file: WorkbenchAttachment) {
    const draft = useCollaboration.getState().views[id];
    const attached = draft?.attachments ?? [];
    if (attached.some((a) => a.id === file.id)) return;
    if (attached.length >= 6) {
      setError("每次最多添加 6 个附件");
      return;
    }
    updateWorkbenchView(id, { attachments: [...attached, file] });
  }
  const content =
    opened?.attachment.kind === "text"
      ? new TextDecoder().decode(
          Uint8Array.from(atob(opened.data), (c) => c.charCodeAt(0)),
        )
      : "";
  return (
    <div className="wb-message-files">
      {files.map((file) => (
        <div className="wb-message-file" key={file.id}>
          <button
            type="button"
            className="ghost"
            disabled={loading === file.id}
            onClick={() => void read(file)}
          >
            <Icon name="file" size={14} />
            {loading === file.id ? "正在读取…" : file.name}
          </button>
          <small>
            {file.roleIds?.length
              ? "接收：" + file.roleIds.map(roleName).join("、")
              : "待分配给相关角色"}
          </small>
          <button
            type="button"
            className="ghost"
            aria-label={"再次附加 " + file.name}
            onClick={() => reuse(file)}
          >
            再次附加
          </button>
        </div>
      ))}
      {error && (
        <p role="alert" className="wb-error">
          {error}
        </p>
      )}
      {opened &&
        createPortal(
          <div className="modal-mask">
            <section
              className="modal wb-attachment-preview"
              role="dialog"
              aria-modal="true"
              aria-label={"查看附件 " + opened.attachment.name}
            >
              <header>
                <h2>{opened.attachment.name}</h2>
                <button
                  ref={close}
                  type="button"
                  className="icon-button"
                  aria-label="关闭附件预览"
                  onClick={() => setOpened(null)}
                >
                  <Icon name="close" />
                </button>
              </header>
              {opened.attachment.kind === "image" ? (
                <img
                  alt={opened.attachment.name}
                  src={
                    "data:" +
                    opened.attachment.mimeType +
                    ";base64," +
                    opened.data
                  }
                />
              ) : (
                <pre>{content}</pre>
              )}
            </section>
          </div>,
          document.body,
        )}
    </div>
  );
}
