import { loadDraft, patchDraft, forgetDraft, draftKey, useDrafts } from "./draft-persistence.js";
import { create } from "zustand";
import type { Workbench, WorkbenchAttachment } from "@pi-harness/contracts";
import { invoke } from "./api.js";
export type WorkbenchView = {
  attachments?: WorkbenchAttachment[];
  text: string;
  recipient: string;
  tab: string;
  evidence: string;
  verificationCommands: string;
  verificationNetwork: boolean;
};
export const EMPTY_WORKBENCH_VIEW: WorkbenchView = {
  attachments: [],
  text: "",
  recipient: "",
  tab: "conversation",
  evidence: "",
  verificationCommands: "",
  verificationNetwork: false,
};
const positions = new Map<string, Record<string, number>>();
export function rememberWorkbenchScroll(id: string, tab: string, top: number) {
  const previous = positions.get(id);
  positions.delete(id);
  positions.set(id, { ...previous, [tab]: top });
  if (positions.size > 100) positions.delete(positions.keys().next().value!);
}
export function workbenchScroll(id: string, tab: string) {
  return positions.get(id)?.[tab];
}
export function updateWorkbenchView(
  id: string | null,
  patch: Partial<WorkbenchView>,
) {
  if (id) {
    const { attachments, text, recipient, evidence, verificationCommands } = patch;
    patchDraft({kind:"workbench",id},{
      ...(text!==undefined?{text}:{}), ...(recipient!==undefined?{recipient}:{}),
      ...(evidence!==undefined?{evidence}:{}), ...(verificationCommands!==undefined?{verificationCommands}:{}),
      ...(attachments!==undefined?{attachmentIds:attachments.map(a=>a.id)}:{}),
    });
    useCollaboration.setState((s) => {
      const views = Object.fromEntries([
        ...Object.entries(s.views).filter(([key]) => key !== id),
        [id, { ...EMPTY_WORKBENCH_VIEW, ...s.views[id], ...patch }],
      ]) as Record<string, WorkbenchView>;
      for (const key of Object.keys(views)) {
        if (Object.keys(views).length <= 100) break;
        const v = views[key]!;
        // Unsent user input must not be discarded just because they browse history.
        if (
          key !== id &&
          key !== s.selected &&
          !v.attachments?.length &&
          !v.text &&
          !v.evidence &&
          !v.verificationCommands
        )
          delete views[key];
      }
      return { views };
    });
  }
}
export function clearWorkbenchView(id: string) {
  forgetDraft({kind:"workbench",id});
  positions.delete(id);
  useCollaboration.setState((s) => {
    const views = { ...s.views };
    delete views[id];
    return {
      views,
      items: s.items.filter((item) => item.id !== id),
      selected: s.selected === id ? null : s.selected,
    };
  });
}
export const useCollaboration = create<{
  views: Record<string, WorkbenchView>;
  items: Workbench[];
  selected: string | null;
  pageIds: string[] | null;
  query: string;
  cursor: string | null;
  nextCursor: string | null;
  previous: Array<string | null>;
  loading: boolean;
  listError: string | null;
}>(() => ({
  items: [],
  selected: null,
  views: {},
  pageIds: null,
  query: "",
  cursor: null,
  nextCursor: null,
  previous: [],
  loading: false,
  listError: null,
}));
let request = 0;
export async function refreshWorkbenches() {
  const version = ++request;
  const start = useCollaboration.getState();
  useCollaboration.setState({ loading: true, listError: null });
  try {
    const { items, nextCursor } = await invoke("workbench:list", {
      limit: 50,
      query: start.query || undefined,
      cursor: start.cursor || undefined,
    });
    if (version !== request) return;
    const selected = start.selected ?? items[0]?.id ?? null;
    const detail = selected
      ? await invoke("workbench:get", { id: selected })
      : null;
    if (version !== request) return;
    useCollaboration.setState((s) => {
      const activeId = s.selected === start.selected ? selected : s.selected;
      const existing = s.items.find((w) => w.id === activeId);
      const active =
        detail?.id === activeId &&
        (!existing || detail.revision >= existing.revision)
          ? detail
          : existing;
      return {
        items: [
          ...items.filter((w) => w.id !== active?.id),
          ...(active ? [active] : []),
        ],
        pageIds: items.map((w) => w.id),
        selected: activeId,
        nextCursor: nextCursor ?? null,
        loading: false,
      };
    });
  } catch (e) {
    if (version === request)
      useCollaboration.setState({ loading: false, listError: String(e) });
    throw e;
  }
}
export async function searchWorkbenches(query: string) {
  useCollaboration.setState({
    query: query.trim(),
    cursor: null,
    previous: [],
    nextCursor: null,
  });
  await refreshWorkbenches();
}
export async function pageWorkbenches(direction: "next" | "previous") {
  const s = useCollaboration.getState();
  if (s.loading) return;
  if (direction === "next") {
    if (!s.nextCursor) return;
    useCollaboration.setState({
      cursor: s.nextCursor,
      previous: [...s.previous, s.cursor].slice(-200),
    });
  } else {
    if (!s.previous.length) return;
    useCollaboration.setState({
      cursor: s.previous.at(-1) ?? null,
      previous: s.previous.slice(0, -1),
    });
  }
  const version = request + 1;
  try {
    await refreshWorkbenches();
  } catch (e) {
    if (request === version)
      useCollaboration.setState({
        cursor: s.cursor,
        previous: s.previous,
        nextCursor: s.nextCursor,
      });
    throw e;
  }
}
export async function selectWorkbench(id: string) {
  const previous = useCollaboration.getState().selected;
  useCollaboration.setState({ selected: id });
  let detail: Workbench;
  try {
    detail = await invoke("workbench:get", { id });
  } catch (e) {
    if (useCollaboration.getState().selected === id)
      useCollaboration.setState({ selected: previous });
    throw e;
  }
  if (useCollaboration.getState().selected !== id) return;
  useCollaboration.setState((s) => {
    const current = s.items.find((w) => w.id === id);
    if (current && current.revision > detail.revision) return {};
    const visible = new Set(s.pageIds ?? s.items.map((w) => w.id));
    return {
      items: [
        ...s.items
          .filter((w) => w.id !== id && visible.has(w.id))
          .map((w) => {
            const { verification, ...summary } = w;
            return {
              ...summary,
              messages: [],
              contracts: [],
              proposals: [],
              memories: [],
            };
          }),
        detail,
      ],
    };
  });
}

export async function restoreWorkbenchDraft(id:string) {
  await loadDraft({kind:"workbench",id});
  const files=await invoke("workbench:draftFiles",{id});
  const entry=useDrafts.getState().entries[draftKey({kind:"workbench",id})];
  if(!entry)return;
  const d=entry.data;
  useCollaboration.setState(s=>({views:{...s.views,[id]:{
    ...EMPTY_WORKBENCH_VIEW,...s.views[id],text:d.text,recipient:d.recipient,evidence:d.evidence,verificationCommands:d.verificationCommands,
    attachments:d.attachmentIds.map(key=>s.views[id]?.attachments?.find(a=>a.id===key)??files?.attachments?.find(a=>a.id===key)).filter((a):a is WorkbenchAttachment=>!!a),
  }}}));
}

export function currentWorkbench() {
  const s = useCollaboration.getState();
  return s.items.find((w) => w.id === s.selected);
}
export const PHASES: Record<string, string> = {
  draft: "尚未开始",
  routing: "正在理解要求",
  awaiting_roles: "等待选择角色",
  clarify: "等待补充要求",
  planning: "正在共同规划",
  running: "角色正在工作",
  waiting_decision: "等待选择协作方案",
  awaiting_review: "待审阅成果",
  verifying: "正在联调验收",
  ready_verify: "待联调验收",
  stopped: "已停止",
  error: "需要处理问题",
  done: "已验收",
};
export const STATUS: Record<string, string> = {
  idle: "待命",
  running: "工作中",
  waiting_approval: "等待批准",
  waiting_user: "等待回答",
  done: "已完成执行",
  awaiting_review: "待审阅",
  applied: "已应用",
  paused: "已暂停",
  pausing: "正在暂停",
  cancelled: "已停止",
  error: "执行失败",
  blocked: "等待处理",
  needs_update: "需配套更新",
  interrupted: "执行中断",
};
