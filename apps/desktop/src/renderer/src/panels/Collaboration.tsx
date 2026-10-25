import NotificationReceipt from "../components/NotificationReceipt.js";
import WorkbenchProgress from "../components/WorkbenchProgress.js";
import CompletionEvidence from "../components/CompletionEvidence.js";
import { roleProgress, latestWorkbenchRequest, currentRound, permissionBlockedRoles } from "../workbench-progress.js";
import { WorkbenchUsage } from "../components/WorkbenchUsage.js";
import DraftStatus from "../components/DraftStatus.js";
import { flushDraft, reloadDraft, retainDraft } from "../draft-persistence.js";
import { restoreWorkbenchDraft } from "../workbench-data.js";
import { SingleRoleDialog } from "../components/ConversationBridge.js";
import RoleChangeDialog from "../components/RoleChangeDialog.js";
import {
  WorkbenchFilePicker,
  WorkbenchMessageFiles,
} from "../components/WorkbenchAttachments.js";
import { createPortal } from "react-dom";
import { WorkbenchReview, WorkbenchRepair } from "./WorkbenchReview.js";
import {
  WorkbenchPermissions,
  WorkbenchVerification,
} from "./WorkbenchExecution.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ApprovalRequest,
  RoleContextInfo,
  TaskInfo,
  CompletionReport,
} from "@pi-harness/contracts";
import { invoke, onEvent } from "../api.js";
import { useStore } from "../store.js";
import { refreshStaticData } from "../data.js";
import {
  useCollaboration,
  refreshWorkbenches,
  searchWorkbenches,
  pageWorkbenches,
  selectWorkbench,
  PHASES,
  STATUS,
  EMPTY_WORKBENCH_VIEW,
  updateWorkbenchView,
  rememberWorkbenchScroll,
  workbenchScroll,
  clearWorkbenchView,
} from "../workbench-data.js";
import { Markdownish as Markdown } from "../components/Markdown.js";
import Icon from "../components/Icon.js";
import "../workbench.css";
function ContextReceipt({
  name,
  percent,
  cache,
  source = "routing",
}: {
  name: string;
  percent?: number | null;
  cache?: number | null;
  source?: "routing" | "planning" | "execution";
}) {
  return (
    <small className="wb-receipt">
      <span
        className="role-context-ring"
        role="progressbar"
        aria-label={`${name}上下文使用占比`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent == null ? undefined : Math.min(100, percent)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle className="ring-track" cx="12" cy="12" r="9" />
          <circle
            className="ring-value"
            cx="12"
            cy="12"
            r="9"
            pathLength="100"
            strokeDasharray={`${Math.min(100, Math.max(0, percent ?? 0))} 100`}
          />
        </svg>
      </span>
      {percent == null ? "—" : percent + "%"}
      <span aria-label={`${name}缓存命中率`} title={`最近一次${source === "execution" ? "角色执行" : source === "planning" ? "角色规划" : "需求判断"}请求的模型回执；缓存读取 token ÷ 输入 token（含缓存），不计输出；未返回缓存数据时显示 —。`}>缓存 {cache == null ? "—" : cache + "%"}</span>
    </small>
  );
}
export function CollaborationContext() {
  const {
    items,
    selected,
    pageIds,
    query,
    loading,
    listError,
    nextCursor,
    previous,
  } = useCollaboration();
  const projects = useStore((s) => s.projects);
  const current = items.find((w) => w.id === selected);
  const [search, setSearch] = useState(query),
    [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState(""),
    [projectId, setProject] = useState(""),
    [error, setError] = useState(""),
    [creating, setCreating] = useState(false);
  useEffect(() => {
    void Promise.all([refreshStaticData(), refreshWorkbenches()]).catch((e) =>
      setError(String(e)),
    );
  }, []);
  useEffect(() => {
    const open = () => setShowCreate(true);
    window.addEventListener("pih:new-workbench", open);
    return () => window.removeEventListener("pih:new-workbench", open);
  }, []);
  useEffect(() => {
    if (search.trim() === query) return;
    const timer = setTimeout(
      () => void searchWorkbenches(search).catch(() => {}),
      220,
    );
    return () => clearTimeout(timer);
  }, [search, query]);
  const visibleItems = (pageIds ?? items.map((w) => w.id)).flatMap((id) => {
    const w = items.find((w) => w.id === id);
    return w ? [w] : [];
  });
  async function create() {
    if (!title.trim() || creating) return;
    setCreating(true);
    setError("");
    try {
      const w = await invoke("workbench:create", {
        title: title.trim(),
        projectId: projectId || undefined,
      });
      setSearch("");
      await searchWorkbenches("");
      await selectWorkbench(w.id);
      setTitle("");
      setShowCreate(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }
  return (
    <div className="ctx wb-context">
      <div className="ctx-head wb-context-head">
        <h2 className="ctx-title">工作台</h2>
        <button
          className="icon-button"
          aria-label="新建协作任务"
          title="新建协作任务"
          onClick={() => setShowCreate(true)}
        >
          <Icon name="plus" size={20} />
        </button>
      </div>
      <label className="wb-search">
        <Icon name="search" size={16} />
        <input
          aria-label="搜索协作任务"
          maxLength={200}
          placeholder="搜索任务…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {showCreate &&
        createPortal(
          <div className="modal-mask">
            <div
              className="modal small"
              role="dialog"
              aria-modal="true"
              aria-label="新建协作任务"
            >
              <div className="wb-dialog-title">
                <h2>新建协作任务</h2>
                <button
                  className="icon-button"
                  aria-label="关闭新建任务"
                  onClick={() => setShowCreate(false)}
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
              <div className="wb-new">
                <label>
                  新任务
                  <input
                    autoFocus
                    placeholder="给任务起个名字"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void create();
                    }}
                    maxLength={200}
                  />
                </label>
                <label>
                  工作目录
                  <select
                    value={projectId}
                    onChange={(e) => setProject(e.target.value)}
                  >
                    <option value="">个人工作区</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="primary"
                  disabled={!title.trim() || creating}
                  onClick={() => void create()}
                >
                  <Icon name="plus" size={15} />
                  创建任务
                </button>
                {error && (
                  <p role="alert" className="wb-error">
                    {error}
                  </p>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
      <div className="ctx-scroll wb-task-list">
        <p className="wb-list-label">
          {query ? "搜索结果" : previous.length ? "历史任务" : "最近任务"}
        </p>
        <div aria-busy={loading}>
          {visibleItems.map((w) => (
            <button
              key={w.id}
              className={`ctx-item wb-task ${selected === w.id ? "active" : ""}`}
              onClick={() =>
                void selectWorkbench(w.id).catch((e) => setError(String(e)))
              }
            >
              <span className="wb-task-title">
                <i
                  className={`wb-dot ${["running", "planning", "routing", "verifying"].includes(w.phase) ? "working" : ""}`}
                />
                <span className="clamp">{w.title}</span>
              </span>
              <small>{PHASES[w.phase] ?? w.phase}</small>
            </button>
          ))}
        </div>
        {loading && (
          <p role="status" className="hint wb-list-empty">
            正在读取任务…
          </p>
        )}
        {listError && (
          <div role="alert" className="wb-error">
            <p>任务列表加载失败，请重试。</p>
            <button
              className="ghost"
              onClick={() => void refreshWorkbenches().catch(() => {})}
            >
              重新加载任务
            </button>
          </div>
        )}
        {!loading &&
          !listError &&
          !visibleItems.length &&
          (query ? (
            <p className="hint wb-list-empty">没有匹配的任务</p>
          ) : (
            <button
              className="ghost wb-first-task"
              onClick={() => setShowCreate(true)}
            >
              创建协作任务
            </button>
          ))}
      </div>
      <div className="wb-pagination" aria-label="协作任务分页">
        <button
          className="ghost"
          disabled={loading || !previous.length}
          onClick={() => void pageWorkbenches("previous").catch(() => {})}
        >
          上一页
        </button>
        <button
          className="ghost"
          disabled={loading || !nextCursor}
          onClick={() => void pageWorkbenches("next").catch(() => {})}
        >
          下一页
        </button>
        {!!previous.length && (
          <button
            className="ghost"
            disabled={loading}
            onClick={() => void searchWorkbenches(query).catch(() => {})}
          >
            返回最新
          </button>
        )}
      </div>
      {current && <WorkbenchParticipants key={current.id} w={current} />}
      <div className="wb-context-footer">
        <div className="wb-assistant-identity">
          <span className="wb-avatar coordinator">TA</span>
          <div>
            <strong>任务助手</strong>
            <small>需求理解与角色协调</small>
          </div>
          <span title="系统角色" aria-label="系统角色">
            <Icon name="lock" size={14} />
          </span>
        </div>
        <div className="wb-project">
          <Icon name="folder" size={18} />
          <span className="clamp">
            {projects.find((p) => p.id === current?.projectId)?.name ??
              "个人工作区"}
          </span>
        </div>
      </div>
    </div>
  );
}
function avatarText(name: string) {
  return /前端/.test(name)
    ? "FE"
    : /后端/.test(name)
      ? "BE"
      : /测试/.test(name)
        ? "TE"
        : name.replace(/\s/g, "").slice(0, 2);
}
function avatarTone(index: number) {
  return ["lavender", "mint", "slate", "peach"][index % 4];
}
export function WorkbenchParticipants({
  w,
}: {
  w: import("@pi-harness/contracts").Workbench;
}) {
  const [pending, setPending] = useState<string | null>(null),
    [error, setError] = useState("");
  const [changing, setChanging] = useState<string | null>(null);
  return (
    <section className="wb-sidebar-members" aria-label="参与角色">
      <h3>
        参与角色 <small>{w.participants.length}</small>
      </h3>
      {changing && (
        <RoleChangeDialog
          id={w.id}
          roleId={changing}
          roleName={
            w.participants.find((p) => p.roleId === changing)?.name ?? "原角色"
          }
          mode="workbench"
          unavailable={
            w.participants.find((p) => p.roleId === changing)?.unavailable
          }
          excluded={w.participants
            .filter((p) => p.roleId !== changing)
            .map((p) => p.roleId)}
          onClose={() => setChanging(null)}
        />
      )}
      {!w.participants.length && (
        <p className="hint">描述任务后，由任务助手推荐角色。</p>
      )}
      {w.participants.map((p, index) => {
        const usage = w.usage?.find((u) => u.roleId === p.roleId);
        const progress=roleProgress(w,p);
        const assignment=currentRound(w)?.roles.find(r=>r.roleId===p.roleId)?.summary;
        return (
          <div className="wb-member" key={p.roleId}>
            <span className={`wb-avatar ${avatarTone(index)}`}>
              {avatarText(p.name)}
            </span>
            <div className="wb-member-info">
              <strong>{p.name}</strong>
              <small
                className="wb-member-responsibility"
                title={assignment??p.responsibility}
              >
                {assignment??(p.responsibility || "等待分工")}
              </small>
              <small className="wb-member-status" data-tone={progress.tone}>
                {progress.label}
              </small>
              <small className="wb-member-reason" title={progress.detail}>{progress.detail}</small>
              {p.deliveryCheck && (
                <small className={p.deliveryCheck.status === "failed" ? "hint danger" : "hint"}
                  title={p.deliveryCheck.status === "failed" ? p.deliveryCheck.issues.join("；") : "仅核对交付文件及声明的结构条件，业务效果仍需联调"}>
                  {p.deliveryCheck.status === "failed" ? "交付检查未通过：" + p.deliveryCheck.issues.join("；") : "交付物结构检查通过"}
                </small>
              )}
              {p.pluginResources?.filter(resource=>resource.status==="using").map(resource=>(
                <small key={resource.resource} className="hint" role="status">
                  {resource.status==="waiting" ? `等待插件资源 ${resource.resource} · 队列第 ${resource.position} 位` : `独占使用 ${resource.resource}`}
                </small>
              ))}
              {p.unavailable && (
                <small className="role-unavailable">
                  角色不可用，请选择替代角色
                </small>
              )}
              {!p.unavailable && p.configurationChanged && (
                <small className="hint">角色卡已更新，仍沿用原配置</small>
              )}
              <button
                type="button"
                className="wb-role-change"
                onClick={() => setChanging(p.roleId)}
              >
                配置与交接
              </button>
              <ContextReceipt
                name={p.name}
                percent={usage?.percent}
                cache={usage?.cacheHitPercent}
                source={p.taskId ? "execution" : "planning"}
              />
            </div>
            <button
              className="wb-role-switch"
              aria-label={p.enabled ? "暂停" : "恢复"}
              title={`${p.enabled ? "暂停" : "恢复"}${p.name}`}
              aria-pressed={!p.enabled}
              disabled={!!pending || w.phase === "verifying" || p.unavailable}
              onClick={() => {
                setPending(p.roleId);
                setError("");
                void invoke("workbench:setEnabled", {
                  id: w.id,
                  roleId: p.roleId,
                  enabled: !p.enabled,
                })
                  .then(() => refreshWorkbenches())
                  .catch((e) => setError(String(e)))
                  .finally(() => setPending(null));
              }}
              data-enabled={p.enabled}
            >
              <span />
            </button>
          </div>
        );
      })}
      {error && (
        <p role="alert" className="wb-error">
          {error}
        </p>
      )}
    </section>
  );
}
export function CollaborationPanel() {
  const selected = useCollaboration((s) => s.selected);
  return <CollaborationTask key={selected ?? "empty"} />;
}
function CollaborationTask() {
  const [singleRole, setSingleRole] = useState<string | null>(null);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const permissionPrompt = useRef("");
  const permissionResume = useRef<Record<string,string>>({});
  const permissionClose = useRef<HTMLButtonElement>(null);
  const { items, selected } = useCollaboration();
  const w = items.find((w) => w.id === selected);
  const roles = useStore((s) => s.roles).filter(
    (r) => !r.isDefault && r.status === "active",
  );
  const view = useCollaboration((s) =>
    selected
      ? (s.views[selected] ?? EMPTY_WORKBENCH_VIEW)
      : EMPTY_WORKBENCH_VIEW,
  );
  const { tab, text, recipient, evidence, attachments = [] } = view;
  useEffect(()=>{if(!selected)return;const release=retainDraft({kind:"workbench",id:selected});let active=true;void restoreWorkbenchDraft(selected).catch(e=>{if(active)setError(String(e));});return()=>{active=false;release();};},[selected]);
  const setTab = (tab: string) => updateWorkbenchView(selected, { tab });
  const setText = (text: string) => updateWorkbenchView(selected, { text });
  const setRecipient = (recipient: string) =>
    updateWorkbenchView(selected, { recipient });
  const setEvidence = (evidence: string) =>
    updateWorkbenchView(selected, { evidence });
  const [uploading, setUploading] = useState(false);
  const sendAttempt = useRef<{ signature: string; id: string } | null>(null);
  const [checked, setChecked] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  const [workers, setWorkers] = useState<
    Array<{
      task: TaskInfo;
      pendingApprovals?: ApprovalRequest[];
      question?: {
        questionId: string;
        question: string;
        options: {
          label: string;
        }[];
      } | null;
    }>
  >([]);
  const [contexts, setContexts] = useState<RoleContextInfo[]>([]),
    [answers, setAnswers] = useState<Record<string, string>>({});
  const [memoryIds, setMemoryIds] = useState<string[]>([]);
  const [completionReport,setCompletionReport]=useState<CompletionReport|null>(null);
  const [streams, setStreams] = useState<Record<string, string>>({});
  const scroll = useRef<HTMLDivElement>(null),
    sticky = useRef(true),
    workerVersion = useRef(0);
  const running =
    !!w &&
    ["routing", "planning", "running", "pausing", "verifying"].includes(
      w.phase,
    );
  const blockedRoles = w ? permissionBlockedRoles(w) : [];
  const autoBlockedRoles = w?.participants.filter(p=>roleProgress(w,p).label === "等待授权") ?? [];
  const permissionKey = autoBlockedRoles.length ? JSON.stringify([w?.id, latestWorkbenchRequest(w!), autoBlockedRoles.map(p=>p.roleId).sort()]) : "";
  useEffect(() => {
    if (!permissionKey) { permissionPrompt.current = ""; return; }
    if (!running && permissionPrompt.current !== permissionKey) {
      permissionPrompt.current = permissionKey;
      setPermissionsOpen(true);
    }
  }, [permissionKey, running]);
  useEffect(() => {
    if (!permissionsOpen) return;
    const previous = document.activeElement;
    permissionClose.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [permissionsOpen]);
  useEffect(() => {
    if (w?.phase === "awaiting_roles") setChecked(w.recommendations);
  }, [w?.recommendations, w?.phase]);
  useLayoutEffect(() => {
    if (!scroll.current || !selected) return;
    const top = workbenchScroll(selected, tab);
    scroll.current.scrollTop =
      top ?? (tab === "conversation" ? scroll.current.scrollHeight : 0);
    sticky.current =
      tab === "conversation" &&
      (top == null ||
        scroll.current.scrollHeight -
          scroll.current.scrollTop -
          scroll.current.clientHeight <
          90);
  }, [selected, tab]);
  useEffect(() => {
    if (tab === "conversation" && sticky.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [w?.messages.length, tab]);
  useEffect(() => {
    const version = ++workerVersion.current;
    if (!w) {
      setWorkers([]);
      return;
    }
    const ids = w.participants.flatMap((p) => (p.taskId ? [p.taskId] : []));
    async function load() {
      try {
        const [records, usage] = await Promise.all([
          Promise.all(ids.map((taskId) => invoke("task:get", { taskId }))),
          Promise.all(
            ids.map((taskId) => invoke("task:getRoleContexts", { taskId })),
          ),
        ]);
        if (workerVersion.current === version) {
          setWorkers(
            records.map(({ task, pendingApprovals, question }) => ({
              task,
              pendingApprovals,
              question,
            })),
          );
          setContexts(usage.flatMap((u) => u.roles));
        }
      } catch (e) {
        if (workerVersion.current === version) setError(String(e));
      }
    }
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onEvent((e) => {
      if ("taskId" in e.payload && ids.includes(String(e.payload.taskId))) {
        if (e.type === "task:stream" && e.payload.kind === "text_delta") {
          const taskId = e.payload.taskId,
            delta = e.payload.delta ?? "";
          setStreams((s) => ({
            ...s,
            [taskId]: ((s[taskId] ?? "") + delta).slice(-16000),
          }));
          return;
        }
        if (e.type === "task:stream") return;
        if (!timer)
          timer = setTimeout(() => {
            timer = undefined;
            void load();
          }, 180);
      }
    });
    return () => {
      workerVersion.current++;
      unsubscribe();
      clearTimeout(timer);
    };
  }, [w?.id, w?.revision]);
  async function action(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refreshWorkbenches();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!w)
    return (
      <div className="wb-empty">
        <Icon name="team" size={32} />
        <h1>让角色一起完成工作</h1>
        <p>
          先创建任务，再描述目标。任务助手会推荐合适的角色，等待你确认后开始规划。
        </p>
      </div>
    );
  const coordinatorUsage = w.usage?.find(
    (u) => !w.participants.some((p) => p.roleId === u.roleId),
  );
  const roleName = (id: string) =>
    id === "system"
      ? "系统"
      : (roles.find((r) => r.id === id)?.name ??
        w.participants.find((p) => p.roleId === id)?.name ??
        w.roleHistory?.find((p) => p.roleId === id)?.name ??
        id);
  const send = () =>
    action(async () => {
      if (
        recipient &&
        !w.participants.some((p) => p.roleId === recipient && p.enabled)
      )
        throw new Error("草稿接收角色已暂停或不再参与，请重新选择接收方");
      const signature = JSON.stringify([
        text,
        recipient,
        attachments.map((a) => a.id),
      ]);
      if (sendAttempt.current?.signature !== signature)
        sendAttempt.current = { signature, id: crypto.randomUUID() };
      const persisted = await flushDraft({kind:"workbench",id:w.id});
      await invoke("workbench:send", {
        id: w.id,
        draftRevision: persisted.revision,
        text: text.trim() || "请参考附件处理任务。",
        requestId: sendAttempt.current!.id,
        ...(attachments.length
          ? { attachmentIds: attachments.map((a) => a.id) }
          : {}),
        roleId: recipient || undefined,
      });
      sendAttempt.current = null;
      await reloadDraft({kind:"workbench",id:w.id});
      const current = useCollaboration.getState().views[w.id];
      if (current)
        updateWorkbenchView(w.id, {
          ...(current.text === text && current.recipient === recipient
            ? { text: "" }
            : {}),
          attachments: (current.attachments ?? []).filter(
            (a) => !attachments.some((sent) => sent.id === a.id),
          ),
        });
    });
  const chooseRoles = () =>
    action(() => invoke("workbench:confirm", { id: w.id, roleIds: checked }));
  const resumeRole = (roleId?: string) => action(async () => {
    const key=JSON.stringify(roleId??null);
    const requestId = permissionResume.current[key] ??= crypto.randomUUID();
    await invoke("workbench:resume", { id: w.id, ...(roleId?{roleId}:{}), requestId });
    delete permissionResume.current[key];
    setPermissionsOpen(false);
    setTab("conversation");
  });
  const resumeControls = blockedRoles.map(p => {
    const access=w.access?.find(a=>a.roleId===p.roleId);
    const configured=!!access?.commands || !!access?.servers.length;
    return <button key={p.roleId} type="button" className="primary"
      disabled={busy || running || !configured}
      title={configured ? "核对已有结果后继续本角色尚未完成的工作" : "请先为此角色配置所需执行权限"}
      onClick={()=>void resumeRole(p.roleId)}>继续{p.name}执行</button>;
  });
  return (
    <div className="wb-surface">
      {singleRole && (
        <SingleRoleDialog
          w={w}
          roleId={singleRole}
          text={
            text ||
            [...w.messages]
              .reverse()
              .find((m) => m.sender === "你" && m.kind === "request")?.text ||
            ""
          }
          files={attachments}
          onClose={() => setSingleRole(null)}
        />
      )}
      <header className="wb-head">
        <div className="wb-heading">
          <div className="wb-title-row">
            <h1 title={w.title}>{w.title}</h1>
            <p aria-live="polite">
              <span className={running ? "wb-dot working" : "wb-dot"} />
              {PHASES[w.phase] ?? w.phase}
            </p>
          </div>
        </div>
        <div className="wb-head-actions">
          {!running&&["stopped","error"].includes(w.phase)&&w.participants.some(p=>p.enabled&&(["blocked","cancelled","interrupted","error"].includes(p.status)||p.deliveryCheck?.status==="failed"))&&
            <button type="button" className="primary" disabled={busy} onClick={()=>void resumeRole()}>继续执行</button>}
          <button type="button" className="ghost" onClick={() => setPermissionsOpen(true)}>角色权限</button>
          <button
            type="button"
            className="primary wb-view-results"
            onClick={() => setTab("results")}
          >
            查看成果 <span aria-hidden="true">↗</span>
          </button>
          {running && (
            <button
              className="ghost"
              disabled={busy}
              onClick={() =>
                void action(() => invoke("workbench:stop", { id: w.id }))
              }
            >
              停止执行
            </button>
          )}
          <button
            className="icon-button"
            title="删除协作任务"
            aria-label="删除协作任务"
            onClick={() => setConfirmDelete(true)}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      </header>
      <nav className="wb-tabs" aria-label="工作视图">
        {[
          ["conversation", "协作对话"],
          ["results", "成果"],
          ["contracts", "共同约定"],
          ["records", "执行记录"],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            className={tab === id ? "selected" : ""}
            onClick={() => setTab(id!)}
          >
            {label}
          </button>
        ))}
      </nav>
      <WorkbenchProgress key={`${w.id}:${latestWorkbenchRequest(w)??"none"}`} w={w} onTab={setTab}/>
      {!permissionsOpen && !running && blockedRoles.length>0 && <div className="wb-permission-resume" role="status">
        <span>此轮因权限不足而停止。配置权限后，可继续对应角色尚未完成的工作。</span>
        <button type="button" className="ghost" onClick={()=>setPermissionsOpen(true)}>配置权限</button>
        {resumeControls}
      </div>}
      {error && (
        <div role="alert" className="wb-error wb-inline-error">
          {error}
          <button className="ghost sm" onClick={() => setError("")}>
            关闭
          </button>
        </div>
      )}
      <div
        ref={scroll}
        className="wb-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (selected) rememberWorkbenchScroll(selected, tab, el.scrollTop);
          sticky.current =
            tab === "conversation" &&
            el.scrollHeight - el.scrollTop - el.clientHeight < 90;
        }}
      >
        {tab === "conversation" && (
          <div className="wb-thread">
            {!w.messages.length && (
              <div className="wb-welcome">
                <h2>这次想一起完成什么？</h2>
                <p>
                  描述目标、交付物和限制，也可以先选择熟悉的角色。角色各自在隔离副本工作；命令和远程插件可在执行记录中按角色授权。
                </p>
              </div>
            )}
            {w.messages.map((m) => {
              const index = w.participants.findIndex(
                (p) => p.roleId === m.sender,
              );
              if (m.kind === "planning" || m.kind === "execution")
                return (
                  <details className="wb-execution-line" key={m.id}>
                    <summary>
                      <Icon name="folder" size={14} />
                      <span>
                        {m.senderName ?? roleName(m.sender)} ·{" "}
                        {m.kind === "planning" ? "工作规划" : "执行记录"}
                      </span>
                      <Icon name="chevron" size={13} />
                    </summary>
                    <Markdown text={m.text} />
                  </details>
                );
              return (
                <article
                  key={m.id}
                  className={`wb-message ${m.sender === "你" ? "from-user" : ""} ${m.kind}`}
                >
                  <span
                    className={`wb-avatar ${m.sender === "你" ? "user" : index < 0 && !w.roleHistory?.some((p) => p.roleId === m.sender) ? "coordinator" : avatarTone(Math.max(0, index))}`}
                  >
                    {m.sender === "你"
                      ? "我"
                      : index < 0 &&
                          !w.roleHistory?.some((p) => p.roleId === m.sender)
                        ? "TA"
                        : avatarText(m.senderName ?? roleName(m.sender))}
                  </span>
                  <div className="wb-message-content">
                    <header>
                      <strong>{m.senderName ?? roleName(m.sender)}</strong>
                      <span>
                        {m.recipients.length
                          ? `发送给 ${m.recipients.map(roleName).join("、")}`
                          : ""}
                      </span>
                      <time>
                        {new Date(m.at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </header>
                    <NotificationReceipt message={m} recipient={w.participants.find(p=>p.roleId===m.recipients[0])} phase={w.phase} isCurrent={m.requestId===latestWorkbenchRequest(w)}/>
                    <div className="wb-message-body">
                      <Markdown
                        text={
                          m.kind === "dispatch"
                            ? m.text
                                .split("\n")
                                .filter(
                                  (line) =>
                                    !m.recipients.some((id) =>
                                      line.startsWith(roleName(id) + "："),
                                    ),
                                )
                                .join("\n")
                            : m.text
                        }
                      />
                    </div>
                    {!!m.attachments?.length && (
                      <WorkbenchMessageFiles
                        id={w.id}
                        files={m.attachments}
                        roleName={roleName}
                      />
                    )}
                    {m.kind === "dispatch" && (
                      <div className="wb-dispatch-card">
                        <strong>已派发 {m.recipients.length} 项任务</strong>
                        {m.recipients.map((roleId) => {
                          const member = w.participants.find(
                              (p) => p.roleId === roleId,
                            ),
                            at = w.participants.findIndex(
                              (p) => p.roleId === roleId,
                            );
                          const receipt = w.messages.find(
                            (item) =>
                              item.requestId === m.requestId &&
                              item.sender === roleId &&
                              item.kind === "execution",
                          );
                          const progress=member&&latestWorkbenchRequest(w)===m.requestId?roleProgress(w,member):undefined;
                          const assignment=progress?currentRound(w)?.roles.find(r=>r.roleId===roleId)?.summary:undefined;
                          return (
                            <div className="wb-dispatch-row" key={roleId}>
                              <span
                                className={`wb-avatar ${avatarTone(Math.max(at, 0))}`}
                              >
                                {avatarText(roleName(roleId))}
                              </span>
                              <b>{roleName(roleId)}</b>
                              <span className="wb-dispatch-detail" title={progress?.detail}>
                                {assignment??receipt?.text
                                  .split("\n")[0]
                                  ?.replace(/^已接手：/, "") ?? progress?.detail ?? "等待接手"}
                              </span>
                              <small>
                                {progress?.label??(w.messages.some(
                                        (item) =>
                                          item.requestId === m.requestId &&
                                          item.sender === roleId &&
                                          item.kind === "result",
                                      )
                                    ? "该轮执行已结束"
                                    : receipt
                                      ? "该轮已接手"
                                      : "该轮未接手")}
                              </small>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
            {w.participants
              .filter(
                (p) =>
                  p.taskId &&
                  ["running", "waiting_approval", "waiting_user"].includes(
                    p.status,
                  ) &&
                  streams[p.taskId],
              )
              .map((p) => (
                <article
                  className="wb-message wb-live"
                  key={`live-${p.taskId}`}
                >
                  <span
                    className={`wb-avatar ${avatarTone(w.participants.findIndex((r) => r.roleId === p.roleId))}`}
                  >
                    {avatarText(p.name)}
                  </span>
                  <div className="wb-message-content">
                    <header>
                      <strong>{p.name}</strong>
                      <span>正在回复</span>
                    </header>
                    <div className="wb-message-body">
                      <Markdown text={streams[p.taskId!]!} />
                    </div>
                  </div>
                </article>
              ))}
            {running && (
              <p className="wb-wait" role="status">
                {PHASES[w.phase]}…
              </p>
            )}
          </div>
        )}
        {tab === "results" && (
          <div className="wb-document">
            <CompletionEvidence key={w.id} scope="workbench" id={w.id} version={w.revision} onReport={setCompletionReport}/>
            <h2>角色成果</h2>
            <p className="hint">
              每个角色在自己的工作副本中修改文件。应用前检查职责和版本冲突，应用后仍需实际联调验收。
            </p>
            {w.participants.map((p) => (
              <section key={p.roleId}>
                <h3>
                  {p.name}
                  <small>{!p.enabled && p.status !== "paused" ? "已暂停 · " : ""}{STATUS[p.status] ?? p.status}</small>
                </h3>
                <details className="wb-result-responsibility"><summary>查看本轮职责</summary><p>{p.responsibility}</p></details>
                {p.taskId && (
                  <details>
                    <summary>查看本角色的执行与成果</summary>
                    {workers.find((r) => r.task.id === p.taskId)?.task
                      .status && (
                      <p>
                        状态：
                        {
                          STATUS[
                            workers.find((r) => r.task.id === p.taskId)!.task
                              .status
                          ]
                        }
                      </p>
                    )}
                    {w.messages
                      .filter(
                        (m) => m.sender === p.roleId && m.kind === "result",
                      )
                      .slice(-1)
                      .map((m) => (
                        <Markdown key={m.id} text={m.text} />
                      ))}
                  </details>
                )}
                <WorkbenchReview
                  key={`${w.id}:${p.roleId}:${p.taskId}`}
                  w={w}
                  p={p}
                  disabled={busy || running}
                  action={action}
                />
              </section>
            ))}
            {["ready_verify", "verifying"].includes(w.phase) && (
              <WorkbenchVerification
                key={w.id}
                w={w}
                disabled={busy || running}
                action={action}
              />
            )}
            <WorkbenchRepair
              key={w.id + ":" + w.verification?.at}
              w={w}
              disabled={busy || running}
              action={action}
            />
            {(w.memories ?? []).some((m) => m.memoryId) && (
              <section className="wb-saved-memories">
                <h3>已保存的角色记忆</h3>
                <p className="hint">
                  内容、来源及当前核对状态可在记忆页查看。相近记录不会被自动覆盖。
                </p>
                {(w.memories ?? [])
                  .filter((m) => m.memoryId)
                  .map((m) => (
                    <button
                      type="button"
                      className="ghost"
                      key={m.id}
                      onClick={() => {
                        useStore.setState({
                          memoryScope: "role",
                          memoryRoleId: m.roleId,
                          memoryStatus: "active",
                          memoryVerification: "all",
                          memoryQuery: "",
                          selectedMemoryId: m.memoryId!,
                        });
                        useStore.getState().setTool("memory");
                      }}
                    >
                      {roleName(m.roleId)} · {m.title}{" "}
                      <Icon name="chevron" size={14} />
                    </button>
                  ))}
              </section>
            )}
            {w.phase === "ready_verify" && (
              <section>
                <h3>联调与验收</h3>
                <label>
                  实际验收结果
                  <textarea
                    aria-label="实际验收结果"
                    placeholder="例如：已打开页面验证登录与数据展示，前后端接口通信正常。"
                    maxLength={4000}
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                  />
                </label>
                {(w.memories ?? [])
                  .filter(
                    (m) =>
                      m.status === "pending" &&
                      w.participants.some(
                        (p) =>
                          p.taskId === m.sourceTaskId && p.status === "applied",
                      ),
                  )
                  .map((m) => (
                    <label className="wb-memory-candidate" key={m.id}>
                      <input
                        type="checkbox"
                        checked={memoryIds.includes(m.id)}
                        onChange={(e) =>
                          setMemoryIds(
                            e.target.checked
                              ? [...memoryIds, m.id]
                              : memoryIds.filter((id) => id !== m.id),
                          )
                        }
                      />
                      <span>
                        保存到{roleName(m.roleId)}的记忆：
                        <strong>{m.title}</strong>
                        <p>{m.content}</p>
                        <small>
                          适用：{m.appliesTo || "相关任务"}
                          {m.projectOnly ? " · 仅本项目" : " · 仅本角色"}
                          。候选内容需对照实际成果核对。
                        </small>
                        {m.evidence && (
                          <p className="hint">模型提供的依据：{m.evidence}</p>
                        )}
                      </span>
                    </label>
                  ))}
                <p className="hint">
                  若选中经验与已有记忆主题接近，将保留为待核对候选，不会覆盖原记录。可在记忆页核对。
                </p>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !evidence.trim() ||
                    (!!w.verification && w.verification.status !== "passed")
                  }
                  onClick={() =>
                    void action(async () => {
                      const receipt = completionReport?.id === w.id ? completionReport : await invoke("completion:get",{scope:"workbench",id:w.id});
                      return invoke("workbench:finish", {
                        id: w.id,
                        completionToken: receipt.token,
                        evidence: evidence.trim(),
                        memoryIds,
                      });
                    })
                  }
                >
                  确认验收并保存选中的经验
                </button>
              </section>
            )}
          </div>
        )}
        {tab === "contracts" && (
          <div className="wb-document">
            <h2>共同约定</h2>
            {!w.contracts.length && (
              <p className="hint">
                角色共同规划后，接口、数据结构及交接约定会显示在这里。
              </p>
            )}
            {w.contracts.map((c) => (
              <section key={c.id}>
                <h3>
                  {c.title}
                  <small>v{c.version}</small>
                </h3>
                <Markdown text={c.content} />
                <p className="hint">参与：{c.roles.map(roleName).join("、")}</p>
              </section>
            ))}
          </div>
        )}
        {tab === "records" && (
          <div className="wb-document">
            <h2>执行记录</h2>
            <WorkbenchUsage id={w.id} revision={w.revision} />
            <WorkbenchPermissions
              w={w}
              disabled={busy || running}
              approvalDisabled={busy}
              action={action}
            />
            {w.messages
              .filter((m) =>
                [
                  "dispatch",
                  "planning",
                  "execution",
                  "handoff",
                  "notice",
                  "error",
                  "decision",
                ].includes(m.kind),
              )
              .map((m) => (
                <section key={m.id}>
                  <h3>
                    {m.senderName ?? roleName(m.sender)}
                    <small>{new Date(m.at).toLocaleString()}</small>
                  </h3>
                  <NotificationReceipt message={m} recipient={w.participants.find(p=>p.roleId===m.recipients[0])} phase={w.phase} isCurrent={m.requestId===latestWorkbenchRequest(w)}/>
                  <Markdown text={m.text} />
                </section>
              ))}
          </div>
        )}
      </div>
      {workers.map((record) => (
        <div key={record.task.id} className="wb-interactions">
          {record.pendingApprovals?.map((a) => (
            <div key={a.toolCallId} className="wb-approval">
              <strong>{roleName(record.task.roleId ?? "角色")} 需要批准</strong>
              <p>{a.summary ?? a.toolName}</p>
              <p className="hint">{a.description}</p>
              {a.effects?.map((effect, i) => (
                <p className="hint" key={i}>
                  {effect}
                </p>
              ))}
              <details>
                <summary>查看操作详情</summary>
                <pre>{JSON.stringify(a.input, null, 2)}</pre>
              </details>
              <button
                className="ghost"
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    invoke("approval:decide", {
                      taskId: record.task.id,
                      toolCallId: a.toolCallId,
                      approved: false,
                    }),
                  )
                }
              >
                拒绝
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    invoke("approval:decide", {
                      taskId: record.task.id,
                      toolCallId: a.toolCallId,
                      approved: true,
                    }),
                  )
                }
              >
                批准
              </button>
            </div>
          ))}
          {record.question && (
            <div className="wb-approval">
              <strong>
                {roleName(record.task.roleId ?? "角色")}：
                {record.question.question}
              </strong>
              <div>
                {record.question.options.map((o) => (
                  <button
                    key={o.label}
                    className="ghost"
                    disabled={busy}
                    onClick={() =>
                      void action(() =>
                        invoke("task:answerQuestion", {
                          taskId: record.task.id,
                          questionId: record.question!.questionId,
                          answer: o.label,
                        }),
                      )
                    }
                  >
                    {o.label}
                  </button>
                ))}
                <input
                  aria-label="补充回答"
                  value={answers[record.task.id] ?? ""}
                  onChange={(e) =>
                    setAnswers({ ...answers, [record.task.id]: e.target.value })
                  }
                />
                <button
                  className="ghost"
                  disabled={busy || !answers[record.task.id]?.trim()}
                  onClick={() =>
                    void action(() =>
                      invoke("task:answerQuestion", {
                        taskId: record.task.id,
                        questionId: record.question!.questionId,
                        answer: answers[record.task.id]!.trim(),
                      }),
                    )
                  }
                >
                  回答
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      {(w.phase === "awaiting_roles" ||
        (w.phase === "draft" && !w.participants.length)) && (
        <div className="wb-role-picker">
          <strong>
            {w.phase === "awaiting_roles"
              ? "确认参与角色"
              : "也可以手动选择角色"}
          </strong>
          <div>
            {roles.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  checked={checked.includes(r.id)}
                  onChange={(e) =>
                    setChecked(
                      e.target.checked
                        ? [...checked, r.id]
                        : checked.filter((id) => id !== r.id),
                    )
                  }
                />
                {r.name}
                {w.recommendations.includes(r.id) && <small>推荐</small>}
              </label>
            ))}
          </div>
          {!roles.length && <p className="hint">先在角色卡中创建专业角色。</p>}
          {
            <button
              className="primary"
              disabled={
                busy || running || checked.length < 1 || checked.length > 8
              }
              onClick={() =>
                checked.length === 1
                  ? setSingleRole(checked[0]!)
                  : void chooseRoles()
              }
            >
              {checked.length === 1
                ? "使用单角色对话"
                : w.phase === "draft"
                  ? "选择这些角色"
                  : "确认角色并规划"}
            </button>
          }
        </div>
      )}
      <form
        className="wb-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (
            (text.trim() || attachments.length) &&
            !running &&
            !busy &&
            !uploading
          )
            void send();
        }}
      >
        <DraftStatus target={{kind:"workbench",id:w.id}} />
        <label className="wb-recipient">
          发送给
          <select
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          >
            <option value="">任务助手 · 判断并安排相关角色</option>
            {recipient &&
              !w.participants.some(
                (p) => p.roleId === recipient && p.enabled,
              ) && (
                <option value={recipient} disabled>
                  原接收角色已暂停或不再参与，请重新选择
                </option>
              )}
            {w.participants
              .filter((p) => p.enabled)
              .map((p) => (
                <option key={p.roleId} value={p.roleId}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <textarea
          aria-label="任务要求或修改意见"
          placeholder="描述任务或修改意见，发送后会记录在协作对话中…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={16000}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (
                (text.trim() || attachments.length) &&
                !running &&
                !busy &&
                !uploading
              )
                void send();
            }
          }}
        />
        <WorkbenchFilePicker
          id={w.id}
          disabled={busy || running}
          onBusy={setUploading}
          onError={setError}
        />
        <footer>
          <div className="wb-composer-options">
            <span title="每个角色使用角色卡中推荐的模型">
              <Icon name="person" size={16} />
              模型随角色
            </span>
            <span title="思考强度使用角色卡推荐设置">思考：随角色</span>
          </div>
          <span className="wb-composer-help">
            {recipient
              ? "仅安排所选角色；涉及协作时会提示"
              : "任务助手先判断影响范围，再安排相关角色"}
          </span>
          <button
            className="primary wb-send"
            aria-label="发送"
            title="发送 (Enter)"
            disabled={
              (!text.trim() && !attachments.length) ||
              running ||
              busy ||
              uploading
            }
          >
            <span className="wb-send-label">发送</span>
            <Icon name="arrow" size={16} />
          </button>
        </footer>
      </form>
      <p className="wb-composer-note">
        消息与分配记录保留在当前任务中
        {coordinatorUsage && (
          <>
            {" "}
            · 任务助手{" "}
            <ContextReceipt
              name="任务助手"
              percent={coordinatorUsage.percent}
              cache={coordinatorUsage.cacheHitPercent}
            />
          </>
        )}
      </p>
      {permissionsOpen && createPortal(
        <div className="modal-mask">
          <div className="modal wb-permission-dialog" role="dialog" aria-modal="true" aria-label="角色执行权限"
            onKeyDown={e => {
              if (e.key === "Escape") { e.stopPropagation(); setPermissionsOpen(false); }
              if (e.key !== "Tab") return;
              const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)"))
                .filter(el => !el.closest("fieldset:disabled"));
              const first=controls[0], last=controls.at(-1);
              if (e.shiftKey && document.activeElement===first) { e.preventDefault(); last?.focus(); }
              else if (!e.shiftKey && document.activeElement===last) { e.preventDefault(); first?.focus(); }
            }}>
            <div className="dialog-heading">
              <h2>角色执行权限</h2>
              <button type="button" ref={permissionClose} className="ghost" aria-label="关闭权限窗口" onClick={()=>setPermissionsOpen(false)}>关闭</button>
            </div>
            {blockedRoles.length > 0 && <p role="status">{blockedRoles.map(p=>p.name).join("、")}因权限不足而停止。勾选所需权限后会立即保存；再点击下方“继续执行”恢复对应角色。仅保存权限不会启动任务。</p>}
            {running && <p className="hint">执行期间可切换审批模式；命令、联网与插件的可用范围需停止本轮后修改。</p>}
            <WorkbenchPermissions w={w} disabled={busy || running} approvalDisabled={busy} action={action}/>
            {error && <p role="alert" className="wb-error">{error}</p>}
            {blockedRoles.length>0 && <div className="modal-actions">{resumeControls}</div>}
          </div>
        </div>, document.body
      )}
      {w.phase === "waiting_decision" && (
        <div className="modal-mask">
          <div
            className="modal wb-decision"
            role="dialog"
            aria-modal="true"
            aria-label="选择协作方案"
          >
            <h2>共同约定需要你确认</h2>
            <p className="hint">
              执行已暂停。选择方案后不会自动重跑，请继续描述配套修改。
            </p>
            {error && (
              <p role="alert" className="wb-error">
                {error}
              </p>
            )}
            {w.contracts
              .filter((c) =>
                w.proposals.some(
                  (p) => p.contractId === c.id && p.status === "pending",
                ),
              )
              .map((c) => (
                <section key={c.id}>
                  <h3>现有约定：{c.title}</h3>
                  <Markdown text={c.content} />
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() =>
                      void action(() =>
                        invoke("workbench:keepContract", {
                          id: w.id,
                          contractId: c.id,
                          revision: w.revision,
                        }),
                      )
                    }
                  >
                    保留现有约定
                  </button>
                </section>
              ))}
            {w.proposals
              .filter((p) => p.status === "pending")
              .map((p) => (
                <section key={p.id}>
                  <h3>
                    {roleName(p.roleId)} ·{" "}
                    {w.contracts.find((c) => c.id === p.contractId)?.title}
                  </h3>
                  <p>{p.reason}</p>
                  <Markdown text={p.content} />
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void action(() =>
                        invoke("workbench:choose", {
                          id: w.id,
                          proposalId: p.id,
                          revision: w.revision,
                        }),
                      )
                    }
                  >
                    采用此方案
                  </button>
                </section>
              ))}
          </div>
        </div>
      )}
      {confirmDelete && (
        <div className="modal-mask">
          <div
            className="modal small"
            role="dialog"
            aria-modal="true"
            aria-label="删除任务"
          >
            <h2>删除这项协作任务？</h2>
            <p>
              会先停止角色执行，然后删除对应会话和隔离副本。已经应用到项目的文件会保留。
            </p>
            <button className="ghost" onClick={() => setConfirmDelete(false)}>
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await invoke("workbench:delete", { id: w.id });
                  clearWorkbenchView(w.id);
                })
              }
            >
              删除任务
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
