import { ToWorkbenchButton } from "./ConversationBridge.js";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TranscriptMessage } from "@pi-harness/contracts";
import { useStore, type ToolCardState } from "../store.js";
import { invoke } from "../api.js";
import { openTask, refreshTaskList } from "../data.js";
import { formatDuration } from "@pi-harness/shared";
import Icon from "./Icon.js";
import { ReferenceTags } from "./SessionReferences.js";
import { CopyButton, Markdownish } from "./Markdown.js";
import { TurnVisibility, VisibleTurn } from "./TurnVisibility.js";
import ConversationNav from "./ConversationNav.js";
import {
  conversationTurns,
  scrollBehavior,
  turnAnchor,
  type ConversationTurn,
} from "./conversation.js";
export { Markdownish } from "./Markdown.js";

function argsSummary(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  if (name === "bash" && typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path;
  return Object.entries(a)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
    .join(" ");
}
function UserBubble({ m }: { m: TranscriptMessage }): React.ReactElement {
  return (
    <div className="msg user">
      <div className="bubble">
        {m.text?.split("\n").map((line, i) => (
          <p key={i}>{line}</p>
        ))}
        <ReferenceTags references={m.references} />
        {m.attachments?.length ? (
          <div className="att-tags">
            {m.attachments.map((a, i) => (
              <span key={i} className="att-tag">
                <Icon name={a.kind === "image" ? "image" : "file"} size={14} />
                {a.name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="msg-actions">
        {m.delivery === "sending" ? (
          <span className="hint">正在发送</span>
        ) : m.delivery === "failed" ? (
          <>
            <span className="message-send-failed">发送未成功 · 内容已保留</span>
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("pih:compose", {
                    detail: {
                      text: m.text ?? "",
                      attachments: m.attachments,
                      references: m.references,
                    },
                  }),
                )
              }
            >
              重新编辑
            </button>
          </>
        ) : null}
        <CopyButton getText={() => m.text ?? ""} />
      </div>
    </div>
  );
}
function ReplyForkButton({ entryId }: { entryId: string }): React.ReactElement {
  const taskId = useStore((s) => s.currentTaskId);
  const [busy, setBusy] = useState(false);
  const fork = async () => {
    if (!taskId || busy) return;
    setBusy(true);
    try {
      const task = await invoke("task:fork", { taskId, entryId });
      await refreshTaskList();
      if (useStore.getState().currentTaskId === taskId) await openTask(task.id);
    } catch (error) {
      useStore
        .getState()
        .setNotice({
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="msg-action"
      disabled={busy || !taskId}
      onClick={() => void fork()}
      title="保留到这条回复的历史，创建新会话分支"
    >
      <Icon name="branch" size={14} />
      {busy ? "创建中…" : "创建分支"}
    </button>
  );
}

function AssistantBubble({
  m,
  memory,
}: {
  m: TranscriptMessage;
  memory?: Map<string, boolean>;
}): React.ReactElement {
  return (
    <div className={`msg assistant${m.kind === "final" ? " final" : ""}`}>
      {m.roleName ? (
        <div className="member-badge">
          <Icon name="person" size={14} />
          {m.roleName}
          {m.round ? ` · 第${m.round}轮` : ""}
        </div>
      ) : null}
      {m.text ? (
        <>
          <div className="bubble md">
            <Markdownish text={m.text} />
          </div>
          <div className="msg-actions">
            <CopyButton getText={() => m.text ?? ""} />
            {m.entryId && !m.toolCalls?.length ? (
              <>
                <ReplyForkButton entryId={m.entryId} />
                <ToWorkbenchButton entryId={m.entryId} text={m.text} />
              </>
            ) : null}
            {m.usage && (m.usage.input || m.usage.output) ? (
              <span className="usage-line">
                输入 {m.usage.input ?? 0} · 输出 {m.usage.output ?? 0}
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
function FullOutput({ outputId }: { outputId: string }): React.ReactElement {
  const taskId = useStore((s) => s.currentTaskId);
  const [page, setPage] = useState<{
    text: string;
    offset: number;
    nextOffset: number | null;
    totalChars: number;
  } | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const version = useRef(0);
  useEffect(() => {
    version.current++;
    setPage(null);
    setError("");
    setLoading(false);
    return () => {
      version.current++;
    };
  }, [taskId, outputId]);
  const load = async (offset: number) => {
    if (!taskId) return;
    const token = version.current;
    setLoading(true);
    setError("");
    try {
      const next = await invoke("task:readOutput", {
        taskId,
        outputId,
        offset,
        limit: 12000,
      });
      if (token === version.current) setPage(next);
    } catch (e) {
      if (token === version.current) setError(String(e));
    } finally {
      if (token === version.current) setLoading(false);
    }
  };
  return (
    <div className="full-output">
      <button type="button" disabled={loading} onClick={() => void load(0)}>
        {loading ? "读取中…" : "查看完整输出"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {page ? (
        <>
          <p className="hint">
            字符 {page.offset + 1}–{page.offset + page.text.length} /{" "}
            {page.totalChars}
          </p>
          <pre className="tool-result">{page.text}</pre>
          <button
            type="button"
            disabled={loading || page.offset === 0}
            onClick={() => void load(Math.max(0, page.offset - 12000))}
          >
            上一页
          </button>
          <button
            type="button"
            disabled={loading || page.nextOffset === null}
            onClick={() => void load(page.nextOffset!)}
          >
            下一页
          </button>
        </>
      ) : null}
    </div>
  );
}
function ToolCard({
  c,
  memory,
}: {
  memory?: Map<string, boolean>;
  c: Omit<ToolCardState, "status"> & { status: "running" | "done" | "unknown" };
}): React.ReactElement {
  const approval = useStore((s) =>
    s.pendingApprovals.find((a) => a.toolCallId === c.toolCallId),
  );
  const [open, setOpen] = useState(
    () => memory?.get(`tool-${c.toolCallId}`) ?? false,
  );
  return (
    <div
      className={`tool-card${c.isError ? " error" : ""}${c.status === "running" ? " running" : ""}`}
    >
      <button
        type="button"
        className="tool-head"
        onClick={() =>
          setOpen((v) => {
            memory?.set(`tool-${c.toolCallId}`, !v);
            return !v;
          })
        }
        aria-expanded={open}
      >
        <span className="tool-icon">
          <Icon
            name={
              c.toolName === "bash"
                ? "terminal"
                : c.toolName === "read" ||
                    c.toolName === "edit" ||
                    c.toolName === "write"
                  ? "file"
                  : "plugin"
            }
            size={16}
          />
        </span>
        <span className="tool-name">
          {approval?.summary ?? (approval ? "待授权操作" : c.toolName)}
        </span>
        <span className="tool-args">
          {approval ? "" : argsSummary(c.toolName, c.args)}
        </span>
        <span
          className={`tool-status ${c.status === "running" ? "running" : c.status === "unknown" ? "unknown" : c.isError ? "bad" : "ok"}`}
        >
          {approval
            ? "等待授权"
            : c.status === "running"
              ? "执行中…"
              : c.status === "unknown"
                ? "暂无结果"
                : c.isError
                  ? "失败"
                  : `完成${c.durationMs !== undefined ? ` · ${formatDuration(c.durationMs)}` : ""}`}
        </span>
        <Icon name="chevron" size={13} className={open ? "rotated" : ""} />
      </button>
      {open ? (
        <div className="tool-body disclosure-content">
          <p className="tool-detail-label">调用参数</p>
          <pre className="tool-args-full">
            {JSON.stringify(c.args ?? {}, null, 2)}
          </pre>
          {c.resultPreview ? (
            <>
              <p className="tool-detail-label">执行结果</p>
              <pre className="tool-result">{c.resultPreview}</pre>
            </>
          ) : null}
          {c.outputId ? <FullOutput outputId={c.outputId} /> : null}
        </div>
      ) : null}
    </div>
  );
}
function TurnMessages({
  turn,
  live,
  memory,
}: {
  memory?: Map<string, boolean>;
  turn: ConversationTurn;
  live?: React.ReactNode;
}): React.ReactElement {
  const shown = new Set<string>();
  const calls = new Map(
    turn.messages.flatMap((m) =>
      (m.toolCalls ?? []).map((c) => [c.id, c] as const),
    ),
  );
  const results = new Map(
    turn.messages
      .filter((m) => m.role === "toolResult" && m.toolCallId)
      .map((m) => [m.toolCallId!, m]),
  );
  const liveCards = new Map(turn.tools.map((card) => [card.toolCallId, card]));
  const card = (id: string) => {
    if (shown.has(id)) return null;
    shown.add(id);
    const live = liveCards.get(id),
      result = results.get(id),
      call = calls.get(id);
    if (!live && !result && !call) return null;
    return (
      <ToolCard
        key={`tool-${id}`}
        memory={memory}
        c={
          live ?? {
            toolCallId: id,
            toolName: call?.name ?? result?.toolName ?? "工具",
            args: call?.args,
            status: result ? "done" : "unknown",
            isError: result?.isError,
            resultPreview: result?.text,
            outputId: result?.outputId,
          }
        }
      />
    );
  };
  const activity = turn.messages.flatMap((m) => {
    const items: React.ReactNode[] = [];
    if (m.kind === "phase") return items;
    if (m.role === "assistant") {
      if (m.thinking)
        items.push(
          <div key={`thinking-${m.id}`} className="turn-thinking">
            {m.roleName ? (
              <span className="member-badge">{m.roleName}</span>
            ) : null}
            <pre className="think-body">{m.thinking}</pre>
          </div>,
        );
      if (m.toolCalls?.length && m.text)
        items.push(
          <div key={`step-${m.id}`} className="md">
            <Markdownish text={m.text} />
          </div>,
        );
      for (const call of m.toolCalls ?? []) items.push(card(call.id));
    } else if (m.toolCallId) items.push(card(m.toolCallId));
    return items;
  });
  for (const tool of turn.tools) activity.push(card(tool.toolCallId));
  return (
    <>
      <TurnActivity
        turn={turn}
        memory={memory}
        last={!!live}
        hasActivity={activity.some(Boolean)}
      >
        {activity}
      </TurnActivity>
      {turn.messages.map((m) =>
        m.kind === "phase" ? (
          <div key={m.id} className="phase-sep">
            <span>{m.text}</span>
          </div>
        ) : m.role === "assistant" && m.text && !m.toolCalls?.length ? (
          <AssistantBubble key={m.id} m={m} memory={memory} />
        ) : null,
      )}
      {live}
    </>
  );
}
function TurnActivity({
  turn,
  last,
  memory,
  hasActivity,
  children,
}: {
  turn: ConversationTurn;
  last: boolean;
  memory?: Map<string, boolean>;
  hasActivity: boolean;
  children: React.ReactNode;
}): React.ReactElement | null {
  const status = useStore((s) => (last ? s.taskStatus : null)),
    progress = useStore((s) => (last ? s.runProgress : null));
  const approval = useStore((s) => (last ? s.pendingApproval : null));
  const thinking = useStore((s) => (last ? s.streamingThinking : ""));
  const active =
    last &&
    ([
      "running",
      "waiting_approval",
      "waiting_user",
      "waiting_recommend",
    ].includes(status ?? "") ||
      !!approval ||
      (!["done", "error", "cancelled"].includes(status ?? "") &&
        turn.tools.some((tool) => tool.status === "running")));
  const key = `activity-${turn.id}`;
  const [open, setOpen] = useState(() => active || memory?.get(key) === true);
  const wasActive = useRef(active);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!wasActive.current && active) setOpen(true);
    if (wasActive.current && !active) {
      setOpen(false);
      memory?.delete(key);
    }
    wasActive.current = active;
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, key, memory]);
  const matching =
    last &&
    progress &&
    (!turn.user?.timestamp ||
      (progress.startedAt <= turn.user.timestamp + 1000 &&
        progress.updatedAt >= turn.user.timestamp));
  const duration =
    turn.user?.turnDurationMs ??
    (matching
      ? active
        ? Math.max(0, now - progress.startedAt)
        : progress.elapsedMs
      : undefined);
  const outcome =
    turn.user?.turnOutcome ??
    (last && status === "error"
      ? "failed"
      : last && status === "cancelled"
        ? "stopped"
        : "complete");
  const label = active
    ? "分析中"
    : outcome === "failed"
      ? "未完成"
      : outcome === "stopped"
        ? "已停止"
        : "已完成";
  if (!hasActivity && !thinking) return null;
  return (
    <div
      className={`turn-activity${open ? " open" : ""}${active ? " active" : ""}`}
    >
      <button
        type="button"
        className="turn-activity-head"
        aria-expanded={open}
        onClick={() =>
          setOpen((value) => {
            memory?.set(key, !value);
            return !value;
          })
        }
        title={
          duration === undefined
            ? "展开分析过程；旧记录未记录耗时"
            : "展开或收起本轮分析过程"
        }
      >
        <span>
          {label}
          {duration !== undefined
            ? `，用时 ${Math.ceil(duration / 1000)} 秒`
            : ""}
        </span>
        <Icon name="chevron" size={14} className={open ? "rotated" : ""} />
      </button>
      {open ? (
        <div className="turn-activity-body disclosure-content">
          {children}
          {thinking ? (
            <div className="turn-thinking">
              <span className="think-caption">正在思考</span>
              <pre className="think-body">{thinking}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ExecutionStatus(): React.ReactElement | null {
  const compacting = useStore((s) => !!s.contextInfo?.compacting);
  const startedAt = useStore((s) => s.contextInfo?.compactionStartedAt);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!compacting) {
      setElapsed(0);
      return;
    }
    const start = startedAt ?? Date.now();
    const update = () => setElapsed(Math.max(0, Date.now() - start));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [compacting, startedAt]);
  const preparing = useStore((s) => s.preparingMessage);
  const progress = useStore((s) => s.runProgress);
  const status = useStore((s) => s.taskStatus),
    thinking = useStore((s) => s.streamingThinking),
    text = useStore((s) => s.streamingText),
    cards = useStore((s) => s.toolCards);
  const running = cards.filter((c) => c.status === "running");
  if (
    !compacting &&
    !preparing &&
    ![
      "running",
      "waiting_approval",
      "waiting_user",
      "waiting_recommend",
    ].includes(status ?? "")
  )
    return null;
  const waiting = !compacting && !preparing && status !== "running";
  const preparationLabels: Record<string, string> = {
    accepted: "正在准备会话",
    git: "正在检查项目",
    resources: "正在加载技能与插件",
    mcp: "正在连接工具",
    preparing: "正在准备请求",
    request: "等待模型响应",
  };
  const label = compacting
    ? "正在整理上下文"
    : preparing
      ? (preparationLabels[progress?.stage ?? "accepted"] ?? "正在准备会话")
      : status === "waiting_approval"
        ? "等待你的授权"
        : status === "waiting_user"
          ? "等待你的回答"
          : status === "waiting_recommend"
            ? "等待角色选择"
            : running.length
              ? `正在执行 ${running[running.length - 1]!.toolName}`
              : text
                ? "正在生成回复"
                : thinking
                  ? "正在分析任务"
                  : progress?.stage === "request"
                    ? "等待模型响应"
                    : "正在处理任务";
  return (
    <div
      className={`execution-status${waiting ? " waiting" : ""}`}
      role="status"
    >
      <span className={`activity-orb${waiting ? "" : " active"}`}>
        <Icon name={waiting ? "shield" : "spark"} size={16} />
      </span>
      <span>{label}</span>
      {compacting ? (
        <>
          <span className="hint" aria-hidden="true">
            已等待 {formatDuration(elapsed)}
          </span>
          <span className="hint">
            {elapsed >= 30000
              ? "摘要模型仍在处理，可点击停止取消"
              : "正在生成历史摘要，可点击停止取消"}
          </span>
        </>
      ) : null}
      {running.length > 1 ? (
        <span className="hint">{running.length} 个工具运行中</span>
      ) : null}
    </div>
  );
}

function ApprovalCard(): React.ReactElement {
  const approval = useStore((s) => s.pendingApproval)!;
  const [busy, setBusy] = useState(false);
  const decide = async (approved: boolean) => {
    setBusy(true);
    try {
      const result = await invoke("approval:decide", {
        taskId: approval.taskId,
        toolCallId: approval.toolCallId,
        approved,
      });
      if (!result.ok) throw new Error("审批已失效，请重新打开任务");
      if (useStore.getState().currentTaskId === approval.taskId)
        useStore.getState().removePendingApproval(approval.toolCallId);
    } catch (e) {
      useStore.getState().setNotice({
        level: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const input = (approval.input ?? {}) as Record<string, unknown>;
  // 主进程已为 edit 类审批生成 diff（description 字段）；其余显示参数 JSON
  const diffText =
    approval.toolName === "edit" && approval.description
      ? approval.description
      : null;

  return (
    <div className="approval-card">
      <div className="approval-title">
        {approval.summary ?? "请求执行工具操作"}
      </div>
      <ul className="approval-effects">
        {(approval.effects?.length
          ? approval.effects
          : [
              typeof input.path === "string"
                ? input.path
                : "请展开详情核对具体操作。",
            ]
        ).map((effect, index) => (
          <li key={index}>{effect}</li>
        ))}
      </ul>
      <details className="approval-details">
        <summary>查看技术详情</summary>
        <div className="approval-tool">工具：{approval.toolName}</div>
        {diffText !== null ? (
          <pre className="approval-diff">{diffText}</pre>
        ) : (
          <pre className="approval-args">
            {JSON.stringify(approval.input ?? {}, null, 2)}
          </pre>
        )}
      </details>
      <div className="approval-actions">
        <button
          type="button"
          className="approve"
          disabled={busy}
          onClick={() => void decide(true)}
        >
          批准执行
        </button>
        <button
          type="button"
          className="deny"
          disabled={busy}
          onClick={() => void decide(false)}
        >
          拒绝
        </button>
      </div>
      <p className="hint">
        批准后执行上述工具操作。项目使用 Git
        时，可在版本管理中查看差异或撤销未提交修改。
      </p>
    </div>
  );
}

function LiveResponse(): React.ReactElement {
  const text = useStore((s) => s.streamingText);
  return (
    <div className="live-response">
      {text ? (
        <div className="msg assistant streaming-answer">
          <div className="bubble md">
            <Markdownish text={text} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
const TurnBody = memo(function TurnBody({
  turn,
  last,
  memory,
}: {
  turn: ConversationTurn;
  last: boolean;
  memory: Map<string, boolean>;
}): React.ReactElement {
  return (
    <>
      {turn.user ? <UserBubble m={turn.user} /> : null}
      <TurnMessages
        turn={turn}
        memory={memory}
        live={last ? <LiveResponse /> : undefined}
      />
    </>
  );
});

function TranscriptView(): React.ReactElement {
  const transcript = useStore((s) => s.transcript),
    toolCards = useStore((s) => s.toolCards),
    hasStream = useStore((s) => !!(s.streamingText || s.streamingThinking)),
    pendingApproval = useStore((s) => s.pendingApproval),
    taskId = useStore((s) => s.currentTaskId),
    status = useStore((s) => s.taskStatus);
  const scrollRef = useRef<HTMLDivElement>(null),
    contentRef = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const [atBottom, setAtBottom] = useState(true),
    [target, setTarget] = useState<string | null>(null);
  const navigate = useCallback((id: string) => {
    follow.current = false;
    setAtBottom(false);
    setTarget(id);
  }, []);
  const registry = useMemo(() => new TurnVisibility(), [taskId]);
  const previousTurns = useRef<ConversationTurn[]>([]);
  const turns = useMemo(() => {
    const next = conversationTurns(
      transcript,
      toolCards,
      previousTurns.current,
    );
    previousTurns.current = next;
    return next;
  }, [transcript, toolCards]);
  useEffect(() => {
    follow.current = true;
    setAtBottom(true);
    setTarget(null);
    const root = scrollRef.current;
    if (root) root.scrollTop = root.scrollHeight;
  }, [taskId]);
  useEffect(() => {
    const root = scrollRef.current;
    if (root) registry.connect(root);
    return () => registry.disconnect();
  }, [registry]);
  useEffect(() => {
    const root = scrollRef.current,
      content = contentRef.current;
    if (!root || !content) return;
    let frame = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (follow.current) root.scrollTop = root.scrollHeight;
      });
    };
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(settle) : null;
    observer?.observe(content);
    settle();
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [taskId, turns.length, hasStream, pendingApproval]);
  const empty =
    !transcript.length &&
    !toolCards.length &&
    !hasStream &&
    status !== "running";
  return (
    <div className="chat-viewport">
      <div
        className="transcript"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const bottom = el.scrollHeight - el.clientHeight - el.scrollTop < 80;
          follow.current = bottom;
          setAtBottom(bottom);
        }}
      >
        <div
          className={`transcript-content${empty ? " is-empty" : ""}`}
          ref={contentRef}
        >
          {empty ? (
            <div className="chat-welcome">
              <span className="welcome-symbol">
                <Icon name="terminal" size={30} />
              </span>
              <h2>从一个想法开始</h2>
              <p>把任务交给 Agent，让思考、执行与修改都清晰可见。</p>
              <div className="welcome-prompts">
                {[
                  "梳理项目结构并找出可优化的地方",
                  "实现一个功能，并说明修改与验证结果",
                  "整理文档，给出清晰可执行的计划",
                ].map((text, i) => (
                  <button
                    type="button"
                    key={text}
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("pih:compose", { detail: text }),
                      )
                    }
                  >
                    <Icon
                      name={i === 0 ? "search" : i === 1 ? "file" : "list"}
                    />
                    <span>{text}</span>
                    <Icon name="chevron" size={14} />
                  </button>
                ))}
              </div>
              <span className="welcome-shortcuts">
                ⌘K 搜索与命令 · ⌘N 新任务
              </span>
            </div>
          ) : null}
          {turns.map((turn, index) => (
            <VisibleTurn
              key={`${taskId}-${turn.id}`}
              turn={turn}
              registry={registry}
              eager={index >= turns.length - 6}
              targeted={target === turn.id}
            >
              <TurnBody
                turn={turn}
                last={index === turns.length - 1}
                memory={registry.disclosures}
              />
            </VisibleTurn>
          ))}
          {!turns.length ? <LiveResponse /> : null}
          <ExecutionStatus />
          {pendingApproval ? <ApprovalCard /> : null}
        </div>
      </div>
      <ConversationNav
        turns={turns}
        scrollRef={scrollRef}
        onNavigate={navigate}
      />
      {!atBottom ? (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            follow.current = true;
            setAtBottom(true);
            scrollRef.current?.scrollTo({
              top: scrollRef.current.scrollHeight,
              behavior:
                scrollRef.current.scrollHeight - scrollRef.current.scrollTop >
                scrollRef.current.clientHeight * 3
                  ? "auto"
                  : scrollBehavior(),
            });
          }}
        >
          <Icon name="down" size={15} />
          回到最新
        </button>
      ) : null}
    </div>
  );
}

export default memo(TranscriptView);
