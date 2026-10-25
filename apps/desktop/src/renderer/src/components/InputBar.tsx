import { useChatDraft } from "../chat-draft.js";
import { flushDraft, reloadDraft, moveNewChatDraft, patchDraft, draftKey, useDrafts } from "../draft-persistence.js";
import DraftStatus from "./DraftStatus.js";
import Icon from "./Icon.js";
import SessionReferences from "./SessionReferences.js";
import { useEffect, useRef, useState } from "react";
import type {
  Attachment,
  ConversationReference,
  PermissionMode,
  TranscriptMessage,
} from "@pi-harness/contracts";
import { useStore } from "../store.js";
import { invoke } from "../api.js";
import { refreshPrompts, refreshTaskList, refreshStaticData } from "../data.js";

const MAX_TEXT_ATTACHMENT = 200_000; // 字符
const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

/** 四档权限模式（ZCode 同款）：计划 → 变更前确认（默认）→ 自动编辑 → 完全访问，信任逐级放大 */
const PERMISSION_MODES = [
  { id: "plan", icon: "list", name: "计划模式", desc: "编辑前先出计划。" },
  { id: "ask", icon: "shield", name: "变更前确认", desc: "改文件前先问我。" },
  { id: "auto_edit", icon: "bolt", name: "自动编辑", desc: "自动编辑文件。" },
  { id: "bypass", icon: "shield", name: "完全访问", desc: "减少确认次数。" },
] as const;

async function applyPermissionMode(mode: PermissionMode): Promise<void> {
  const settings = useStore.getState().settings;
  try {
    const next = await invoke("settings:set", {
      defaultModel: settings?.defaultModel ?? null,
      autoApproveTools: settings?.autoApproveTools ?? [
        "read",
        "grep",
        "find",
        "ls",
      ],
      autoMemory: settings?.autoMemory ?? false,
      sandboxMode: settings?.sandboxMode ?? "off",
      permissionMode: mode,
    });
    useStore.getState().hydrate({ settings: next });
  } catch (e) {
    useStore.getState().setNotice({
      level: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

function cyclePermissionMode(): void {
  const current = useStore.getState().settings?.permissionMode ?? "ask";
  const idx = PERMISSION_MODES.findIndex((m) => m.id === current);
  const next = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]!;
  void applyPermissionMode(next.id);
}

async function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error(`读取文件失败: ${file.name}`));
    r.readAsDataURL(file);
  });
}

export default function InputBar(): React.ReactElement {
  const composeTarget = useStore((s) => s.currentTaskId);
  const {text,setText,attachments,setAttachments,target:composeDraftTarget}=useChatDraft(composeTarget);
  const referenceEdited=useRef(false);
  const [references, setReferences] = useState<ConversationReference[]>([]);
  useEffect(()=>{let active=true;void invoke("draft:references",composeDraftTarget).then(r=>{if(active&&!referenceEdited.current)setReferences(r?.references??[]);}).catch(()=>{});return()=>{active=false;};},[composeTarget]);
  useEffect(() => {
    const compose = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (
        typeof detail === "string" ||
        (detail && typeof detail.text === "string")
      ) {
        setText(typeof detail === "string" ? detail : detail.text);
        if (typeof detail !== "string") {
          setAttachments(detail.attachments ?? []);
          referenceEdited.current=true;
          setReferences(detail.references ?? []);
          patchDraft(composeDraftTarget,{referenceIds:(detail.references??[]).map((r:ConversationReference)=>r.id)});
        }
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    };
    window.addEventListener("pih:compose", compose);
    return () => window.removeEventListener("pih:compose", compose);
  }, []);

  const pendingCompose = useStore((s) => s.pendingCompose);
  useEffect(() => {
    if (
      pendingCompose &&
      pendingCompose.taskId === useStore.getState().currentTaskId
    ) {
      setText(pendingCompose.text);
      setAttachments(pendingCompose.attachments);
      setReferences([]);
      useStore.setState({ pendingCompose: null });
    }
  }, [pendingCompose, composeTarget]);
  const [busy, setBusy] = useState(false);
  const cancelPending = useRef(false);
  const prompts = useStore((s) => s.prompts);
  const slashOpen = text.startsWith("/") && !text.includes(" ");
  useEffect(() => {
    if (prompts.length === 0) void refreshPrompts().catch(() => {});
  }, [prompts.length]);
  const slashItems = slashOpen
    ? [
        { name: "compact", description: "压缩当前任务上下文" },
        { name: "stop", description: "停止当前任务" },
        ...prompts.map((p) => ({
          name: p.name,
          description:
            p.description ||
            (p.argumentHint ? `参数：${p.argumentHint}` : "提示词模板"),
        })),
      ].filter((i) => i.name.startsWith(text.slice(1)))
    : [];
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const compacting = useStore((s) => !!s.contextInfo?.compacting);
  const status = useStore((s) => s.taskStatus);
  const currentTaskId = useStore((s) => s.currentTaskId);
  useEffect(() => {
    setReferences([]);
  }, [currentTaskId]);
  const draftProjectId = useStore((s) => s.draftProjectId);
  const draftRoleId = useStore((s) => s.draftRoleId);
  const draftModel = useStore((s) => s.draftModel);
  const draftThinking = useStore((s) => s.draftThinking);
  const projects = useStore((s) => s.projects);
  const roles = useStore((s) => s.roles);
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const preparing = useStore((s) => s.preparingMessage);
  const running =
    compacting ||
    preparing ||
    status === "running" ||
    status === "waiting_approval" ||
    status === "waiting_user" ||
    status === "waiting_recommend";

  const project = projects.find((p) => p.id === draftProjectId) ?? null;
  const role =
    roles.find((r) => r.id === draftRoleId) ??
    roles.find((r) => r.isDefault) ??
    null;
  const effectiveModel =
    draftModel ?? role?.preferredModel ?? settings?.defaultModel ?? null;
  const modelLabel = draftModel
    ? `${draftModel.provider}/${draftModel.modelId}`
    : "自动";
  const modelInfo = providers
    .find((p) => p.id === effectiveModel?.provider)
    ?.models.find((m) => m.id === effectiveModel?.modelId);
  const thinkingLevels =
    modelInfo?.thinkingLevels ??
    (modelInfo?.reasoning === false
      ? ["off"]
      : ["off", "minimal", "low", "medium", "high"]);
  const requestedThinking = draftThinking ?? role?.preferredThinking ?? "off";
  const thinkingOrder = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  const effectiveThinking = thinkingLevels.includes(requestedThinking)
    ? requestedThinking
    : (thinkingOrder
        .slice(Math.max(0, thinkingOrder.indexOf(requestedThinking)))
        .find((level) => thinkingLevels.includes(level)) ??
      thinkingLevels.at(-1) ??
      "off");

  useEffect(()=>{
    if(composeTarget!==null)return;
    const e=useDrafts.getState().entries[draftKey(composeDraftTarget)];
    if(!e?.ready)return;
    patchDraft(composeDraftTarget,{projectId:draftProjectId,roleId:draftRoleId,model:draftModel,thinking:draftThinking});
  },[draftProjectId,draftRoleId,draftModel,draftThinking,composeTarget]);

  const pickProject = async () => {
    try {
      const { dir } = await invoke("project:pickFolder", {});
      if (!dir) return;
      const info = await invoke("project:add", { dir });
      await refreshStaticData();
      useStore.getState().setDraftProject(info.id);
    } catch (e) {
      useStore.getState().setNotice({
        level: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const clearProject = () => useStore.getState().setDraftProject(null);

  const onPickFiles = async (files: FileList | null) => {
    if (!files) return;
    const added: Attachment[] = [];
    for (const f of Array.from(files)) {
      try {
        const extension = f.name.split(".").pop()?.toLowerCase() ?? "";
        const imageMime: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          webp: "image/webp",
          gif: "image/gif",
        };
        const mime = f.type || imageMime[extension];
        if (mime?.startsWith("image/")) {
          if (!Object.values(imageMime).includes(mime))
            throw new Error(`暂不支持此图片格式: ${f.name}`);
          if (f.size > MAX_IMAGE_BYTES)
            throw new Error(`图片过大（>4.5MB）: ${f.name}`);
          const url = await readAsDataUrl(f);
          added.push({
            kind: "image",
            name: f.name,
            mimeType: mime,
            data: url.split(",")[1] ?? "",
          });
        } else {
          if (f.size > MAX_TEXT_ATTACHMENT)
            throw new Error(`文本附件过大: ${f.name}`);
          const content = await f.text();
          if (
            content.includes("\0") ||
            ["pdf", "docx", "xlsx", "zip", "exe", "dmg"].includes(extension)
          )
            throw new Error(`请选择文本或图片文件: ${f.name}`);
          added.push({
            kind: "text",
            name: f.name,
            path: (f as File & { path?: string }).path,
            data: content,
          });
        }
      } catch (error) {
        useStore
          .getState()
          .setNotice({
            level: "warn",
            message: error instanceof Error ? error.message : String(error),
          });
      }
    }
    setAttachments((a) => [...a, ...added]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const send = async () => {
    let value = text.trim();
    if (!value || busy || compacting) return;
    setBusy(true);
    cancelPending.current = false;
    const s = useStore.getState();

    // 内置斜杠命令（提示词模板 /xxx 由 pi 原生展开，直接发送）
    if (value === "/compact") {
      setText("");
      setBusy(false);
      if (currentTaskId) {
        const r = await invoke("task:compact", { taskId: currentTaskId }).catch(
          () => null,
        );
        useStore.getState().setNotice({
          level: r?.ok ? "info" : "warn",
          message: r?.ok ? "压缩完成" : "压缩未执行",
        });
      }
      return;
    }
    if (value === "/stop") {
      setText("");
      setBusy(false);
      if (currentTaskId)
        await invoke("task:abort", { taskId: currentTaskId }).catch(() => {});
      return;
    }
    let localId: string | null = null;
    let sentTaskId = currentTaskId;
    const updateLocal = (delivery: "sent" | "failed") => {
      useStore.setState((state) => ({
        transcript: state.transcript.map((m) =>
          m.id === localId ? { ...m, delivery } : m,
        ),
        ...((delivery === "failed" || !state.runProgress) &&
        state.transcript.some((m) => m.id === localId)
          ? { preparingMessage: false }
          : {}),
      }));
    };
    try {
      // 点击后立即上屏，创建任务和初始化都在消息显示之后执行。
      localId = `local-${crypto.randomUUID()}`;
      s.appendTranscript({
        id: localId,
        role: "user",
        text: value,
        references: references.length ? references : undefined,
        attachments: attachments.length ? attachments : undefined,
        timestamp: Date.now(),
        delivery: "sending",
      });
      useStore.setState({ preparingMessage: true, runProgress: null });
      const persisted = await flushDraft(composeDraftTarget);
      let sentRevision = persisted.revision;
      // 文本附件展开进 prompt
      const textAtts = attachments.filter((a) => a.kind === "text");
      const composed =
        textAtts.length > 0
          ? `${value}\n\n${textAtts
              .map(
                (a) =>
                  `--- 附件：${a.name} ---\n${a.data ?? ""}`,
              )
              .join("\n\n")}`
          : value;
      const images = attachments
        .filter((a) => a.kind === "image")
        .map((a) => ({
          data: a.data ?? "",
          mimeType: a.mimeType ?? "image/png",
        }));

      let taskId = currentTaskId;
      if (!taskId) {
        const task = await invoke("task:create", {
          projectId: draftProjectId ?? undefined,
          roleId: draftRoleId ?? role?.id,
          model: draftModel ?? undefined,
          thinkingLevel: draftModel ? (draftThinking ?? undefined) : undefined,
        });
        taskId = task.id;
        const moved = await moveNewChatDraft(taskId, sentRevision);
        sentRevision = moved.revision;
        if (
          useStore.getState().currentTaskId === null &&
          useStore.getState().transcript.some((m) => m.id === localId)
        )
          s.selectTask(taskId);
        void refreshTaskList();
      }

      sentTaskId = taskId;
      if (cancelPending.current) {
        updateLocal("failed");
        if (useStore.getState().currentTaskId === taskId)
          useStore.getState().setTaskStatus("cancelled");
        return;
      }

      const result = await invoke("task:prompt", {
        taskId,
        draftRevision: sentRevision,
        text: composed,
        referenceIds: references.length
          ? references.map((r) => r.id)
          : undefined,
        images: images.length ? images : undefined,
      });
      if (!result.accepted) {
        updateLocal("failed");
        return;
      }
      await reloadDraft({kind:"chat",id:taskId});
      if(useStore.getState().currentTaskId===taskId)setReferences([]);
      updateLocal("sent");
    } catch (e) {
      updateLocal("failed");
      if (useStore.getState().currentTaskId !== sentTaskId) return;
      s.setNotice({
        level: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (busy) cancelPending.current = true;
    if (!currentTaskId) {
      if (busy)
        useStore.setState({
          preparingMessage: false,
          taskStatus: "cancelled",
          transcript: useStore
            .getState()
            .transcript.map((m) =>
              m.delivery === "sending" ? { ...m, delivery: "failed" } : m,
            ),
        });
      return;
    }
    try {
      await invoke("task:abort", { taskId: currentTaskId });
    } catch (e) {
      useStore.getState().setNotice({
        level: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const steer = async () => {
    if (compacting) return;
    const value = text.trim();
    if (!value || !currentTaskId || busy) return;
    setBusy(true);
    try {
      await invoke("task:steer", { taskId: currentTaskId, text: value });
      useStore.getState().appendTranscript({
        id: `local-${Date.now()}`,
        role: "user",
        text: value,
        timestamp: Date.now(),
      });
      setText("");
    } catch (e) {
      useStore.getState().setNotice({
        level: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="input-bar">
      <DraftStatus target={composeDraftTarget} />
      {slashItems.length > 0 ? (
        <div className="slash-list">
          {slashItems.slice(0, 8).map((i) => (
            <button
              type="button"
              key={i.name}
              className="slash-item"
              onClick={() => {
                setText(`/${i.name} `);
                textareaRef.current?.focus();
              }}
            >
              <code>/{i.name}</code>
              <span className="hint">{i.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="att-list">
          {attachments.map((a, i) => (
            <span key={i} className="att-tag">
              <Icon name={a.kind === "image" ? "image" : "file"} size={14} />{" "}
              {a.name}
              <button
                type="button"
                onClick={() =>
                  setAttachments((arr) => arr.filter((_, j) => j !== i))
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        value={busy ? "" : text}
        disabled={busy || preparing}
        placeholder={
          running
            ? "任务运行中…可插话补充指令（/ 命令）"
            : "描述任务…（⏎ 发送 / ⇧⏎ 换行 / / 斜杠命令）"
        }
        rows={Math.min(6, Math.max(1, text.split("\n").length))}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // 输入法组合中的回车是选字上屏，不是发送
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!compacting) void (running ? steer() : send());
          }
          if (e.key === "Tab" && e.shiftKey) {
            e.preventDefault();
            cyclePermissionMode();
          }
        }}
      />

      <div className="input-actions">
        <div className="left">
          {!currentTaskId ? (
            <>
              <RoleChip
                roles={roles}
                current={draftRoleId}
                onPick={(id) => useStore.getState().setDraftRole(id)}
              />
            </>
          ) : null}
          {!currentTaskId ? (
            project ? (
              <span className="chip project" title={project.dir}>
                <Icon name="folder" size={15} /> {project.name}
                <button
                  type="button"
                  onClick={clearProject}
                  title="移除项目绑定"
                >
                  ×
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="chip-btn"
                onClick={() => void pickProject()}
              >
                <Icon name="folder" size={15} /> 选择项目（可选）
              </button>
            )
          ) : null}

          <ModelChip
            label={modelLabel}
            providers={providers}
            onPick={(m) => {
              const apply = () =>
                useStore.setState({
                  draftModel: m,
                  ...(!m ? { draftThinking: null } : {}),
                });
              if (currentTaskId) {
                void invoke(
                  "task:setModel",
                  m
                    ? {
                        taskId: currentTaskId,
                        provider: m.provider,
                        modelId: m.modelId,
                      }
                    : { taskId: currentTaskId, auto: true },
                )
                  .then((r) => {
                    if (useStore.getState().currentTaskId !== currentTaskId)
                      return;
                    if (r.ok) apply();
                    else
                      useStore
                        .getState()
                        .setNotice({
                          level: "warn",
                          message: r.message ?? "模型切换失败",
                        });
                  })
                  .catch((error) =>
                    useStore
                      .getState()
                      .setNotice({ level: "error", message: String(error) }),
                  );
              } else apply();
            }}
            disabled={false}
            current={draftModel}
          />

          <ThinkingChip
            automatic={!draftModel}
            level={effectiveThinking}
            levels={thinkingLevels}
            onPick={(level) => {
              if (currentTaskId) {
                void invoke("task:setThinking", {
                  taskId: currentTaskId,
                  level,
                })
                  .then((r) => {
                    if (useStore.getState().currentTaskId !== currentTaskId)
                      return;
                    if (r.ok) useStore.setState({ draftThinking: level });
                    else
                      useStore
                        .getState()
                        .setNotice({
                          level: "warn",
                          message: r.message ?? "思考强度设置失败",
                        });
                  })
                  .catch((error) =>
                    useStore
                      .getState()
                      .setNotice({ level: "error", message: String(error) }),
                  );
              } else useStore.setState({ draftThinking: level });
            }}
          />
          <PermissionModeChip />
          <SessionReferences
            value={references}
            onChange={value=>{referenceEdited.current=true;setReferences(value);patchDraft(composeDraftTarget,{referenceIds:value.map(r=>r.id)});}}
            disabled={running || busy}
          />

          <button
            type="button"
            className="chip-btn"
            onClick={() => fileInputRef.current?.click()}
            title="导入文本或图片文件"
          >
            <Icon name="file" size={15} /> 文件
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => void onPickFiles(e.target.files)}
          />
        </div>

        <div className="right">
          {running ? (
            <>
              <button
                type="button"
                className="ghost stop-button"
                onClick={() => void stop()}
              >
                <Icon name="stop" size={15} />
                停止
              </button>
              <button
                type="button"
                className="primary"
                disabled={!text.trim() || busy || preparing || compacting}
                onClick={() => void steer()}
              >
                插话
              </button>
            </>
          ) : (
            <button
              type="button"
              className="primary send-button"
              aria-label="发送"
              title="发送 (↵)"
              disabled={!text.trim() || busy}
              onClick={() => void send()}
            >
              <Icon name="arrow" size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PermissionModeChip(): React.ReactElement {
  const settings = useStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const current: PermissionMode = settings?.permissionMode ?? "ask";
  const active =
    PERMISSION_MODES.find((m) => m.id === current) ?? PERMISSION_MODES[0];
  return (
    <div className="model-chip-wrap perm-chip-wrap">
      <button
        type="button"
        className={`chip-btn perm-chip perm-${current}`}
        onClick={() => setOpen(!open)}
        title="权限模式（⇧Tab 循环切换；运行中实时生效）"
      >
        <Icon name={active.icon} size={15} /> {active.name}
      </button>
      {open ? (
        <div className="popover perm-popover">
          {PERMISSION_MODES.map((m) => (
            <button
              type="button"
              key={m.id}
              className={`popover-item with-desc${m.id === current ? " active" : ""}`}
              onClick={() => {
                setOpen(false);
                void applyPermissionMode(m.id);
              }}
            >
              <span className="pd-name">
                <Icon name={m.icon} size={15} /> {m.name}
                {m.id === current ? <span className="badge">当前</span> : null}
              </span>
              <span className="pd-desc">{m.desc}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RoleChip({
  roles,
  current,
  onPick,
  label,
}: {
  roles: { id: string; name: string; isDefault: boolean }[];
  current: string | null;
  onPick: (id: string | null) => void;
  label?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const active = roles.find((r) => r.id === current) ?? null;
  return (
    <div className="model-chip-wrap">
      <button
        type="button"
        className="chip-btn"
        onClick={() => setOpen(!open)}
        title="任务角色（创建后随快照锁定）"
      >
        <Icon name="person" size={15} />{" "}
        {active ? active.name : (label ?? "默认角色")}
      </button>
      {open ? (
        <div className="popover role-popover">
          {roles.length === 0 ? (
            <div className="popover-empty">没有可用角色</div>
          ) : (
            roles.map((r) => (
              <button
                type="button"
                key={r.id}
                className={`popover-item${current === r.id ? " active" : ""}`}
                onClick={() => {
                  onPick(r.id);
                  setOpen(false);
                }}
              >
                {r.name}
                {r.isDefault ? <span className="badge">默认</span> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function ModelChip({
  label,
  providers,
  onPick,
  disabled,
  current,
}: {
  label: string;
  providers: {
    id: string;
    name: string;
    authConfigured: boolean;
    models: { id: string; name: string }[];
  }[];
  onPick: (m: { provider: string; modelId: string } | null) => void;
  disabled: boolean;
  current: { provider: string; modelId: string } | null;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const usable = providers.filter(
    (p) => p.authConfigured && p.models.length > 0,
  );
  return (
    <div className="model-chip-wrap">
      <button
        type="button"
        className="chip-btn"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title="选择任务模型"
      >
        <Icon name="spark" size={15} /> {label}
      </button>
      {open ? (
        <div className="popover">
          <button
            type="button"
            className={`popover-item with-desc${!current ? " active" : ""}`}
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
          >
            <span>自动</span>
            <span className="pd-desc">
              采用各角色卡推荐的模型与思考强度；未推荐模型时使用应用默认模型。
            </span>
          </button>
          {usable.length === 0 ? (
            <div className="popover-empty">
              没有已连接的提供商——请到「模型与设置」配置 API Key
            </div>
          ) : (
            usable.map((p) => (
              <div key={p.id} className="popover-group">
                <div className="popover-title">{p.name}</div>
                {p.models.slice(0, 30).map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={`popover-item${current?.provider === p.id && current?.modelId === m.id ? " active" : ""}`}
                    onClick={() => {
                      onPick({ provider: p.id, modelId: m.id });
                      setOpen(false);
                    }}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

const THINKING_LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};
function ThinkingChip({
  automatic,
  level,
  levels,
  onPick,
}: {
  automatic: boolean;
  level: string;
  levels: string[];
  onPick: (level: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [automatic, levels.join(",")]);
  return (
    <div className="model-chip-wrap">
      <button
        type="button"
        className="chip-btn"
        aria-label="设置思考强度"
        aria-expanded={open}
        disabled={automatic}
        title={
          automatic
            ? "自动采用角色卡推荐的思考强度；选择具体模型后可手动设置。"
            : "设置模型思考强度"
        }
        onClick={() => setOpen(!open)}
      >
        <Icon name="spark" size={15} />
        思考：{automatic ? "自动" : (THINKING_LABELS[level] ?? level)}
      </button>
      {open ? (
        <div className="popover">
          {levels.map((value) => (
            <button
              key={value}
              type="button"
              className={`popover-item${value === level ? " active" : ""}`}
              onClick={() => {
                onPick(value);
                setOpen(false);
              }}
            >
              {THINKING_LABELS[value] ?? value}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
