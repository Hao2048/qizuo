import type { MemoryInfo, MemoryQuality } from "@pi-harness/contracts";
import { useEffect, useState } from "react";
import { invoke } from "../api.js";
import { useStore } from "../store.js";
export const qualityLabel = (m: MemoryInfo) =>
  m.quality?.source === "builtin" && m.quality.verification === "legacy"
    ? "内置偏好 · 未核对"
    : {
        pending: "待核对",
        confirmed: "用户确认",
        verified: "成果验收通过",
        legacy: "旧版记录 · 未验证",
      }[m.quality?.verification ?? "legacy"];
export function MemoryFields({
  category,
  setCategory,
  appliesTo,
  setAppliesTo,
  projectId,
  setProjectId,
}: {
  category: MemoryQuality["category"];
  setCategory: (v: MemoryQuality["category"]) => void;
  appliesTo: string;
  setAppliesTo: (v: string) => void;
  projectId: string;
  setProjectId: (v: string) => void;
}) {
  const projects = useStore((s) => s.projects);
  return (
    <div className="memory-quality-fields">
      <label className="field">
        <span>记忆类型</span>
        <select
          value={category}
          onChange={(e) =>
            setCategory(e.target.value as MemoryQuality["category"])
          }
        >
          <option value="experience">可复用经验</option>
          <option value="preference">工作偏好</option>
        </select>
      </label>
      <label className="field">
        <span>适用项目</span>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">不限项目 · 仅本角色</option>
          {projectId && !projects.some((p) => p.id === projectId) && (
            <option value={projectId}>原项目（当前不可用）</option>
          )}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field memory-conditions">
        <span>适用条件</span>
        <input
          maxLength={300}
          placeholder="例如：修改 React 页面前，先核对现有组件"
          value={appliesTo}
          onChange={(e) => setAppliesTo(e.target.value)}
        />
      </label>
    </div>
  );
}
export function MemoryReview({
  memory,
  onChanged,
}: {
  memory: MemoryInfo;
  onChanged: () => Promise<void>;
}) {
  const [items, setItems] = useState<MemoryInfo[]>([]),
    [evidence, setEvidence] = useState(""),
    [checked, setChecked] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setItems([]);
    setChecked(false);
    void invoke("memory:conflicts", { memoryId: memory.id })
      .then((r) => {
        if (active) setItems(r.items ?? []);
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [memory.id, memory.version, generation]);
  async function review(decision: "accept" | "replace" | "discard") {
    if (busy || loading || !evidence.trim() || !checked || error) return;
    setBusy(true);
    try {
      await invoke("memory:review", {
        memoryId: memory.id,
        expectedVersion: memory.version,
        decision,
        conflicts: items.map((m) => ({ id: m.id, version: m.version })),
        evidence: evidence.trim(),
      });
      await onChanged();
      useStore.getState().setNotice({
        level: "info",
        message:
          decision === "discard"
            ? "候选未采纳，保留记录供查看"
            : decision === "replace"
              ? "已采用新记忆，旧记录已移到已忘记"
              : "已确认，将从下一轮相关请求使用",
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="memory-review" aria-label="核对记忆候选">
      <h3>核对后再用于后续工作</h3>
      <p className="hint">
        候选不会参与检索。模型提供的依据仅供参考，请对照实际结果；不会改变已经发送的请求。
      </p>
      {loading ? (
        <p role="status">正在核对相关记录…</p>
      ) : items.length > 0 ? (
        <>
          <p>以下记录主题接近，需人工判断是否冲突：</p>
          <div className="memory-conflicts">
            {items.map((m) => (
              <article key={m.id}>
                <strong>
                  {m.title} <small>v{m.version}</small>
                </strong>
                <p>{m.content}</p>
                <small>
                  适用：{m.quality?.appliesTo ?? "相关任务"} · {qualityLabel(m)}
                </small>
              </article>
            ))}
          </div>
          <p className="hint">
            确认替换会将以上旧记录移至“已忘记”，原内容和来源仍保留。若应分别适用，请先编辑候选的适用项目。
          </p>
        </>
      ) : (
        <p className="hint">
          未发现同角色同主题的有效记录。这只是本地匹配结果，不代表已完成语义验证。
        </p>
      )}
      <label className="field">
        <span>核对依据或不采纳原因</span>
        <textarea
          value={evidence}
          maxLength={2000}
          rows={3}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder="实际确认了什么、适用条件是什么，或为什么不采纳"
        />
      </label>
      <label className="memory-review-confirm">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        我已核对内容、来源和适用条件
      </label>
      {error && (
        <p role="alert" className="danger">
          {error}{" "}
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => setGeneration((v) => v + 1)}
          >
            重新核对
          </button>
        </p>
      )}
      <div className="bar-actions">
        <button
          type="button"
          className="ghost"
          disabled={busy || loading || !!error || !evidence.trim() || !checked}
          onClick={() => void review("discard")}
        >
          不采纳
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || loading || !!error || !evidence.trim() || !checked}
          onClick={() => void review(items.length ? "replace" : "accept")}
        >
          {busy ? "保存中…" : items.length ? "确认替换旧记录" : "确认采用"}
        </button>
      </div>
    </section>
  );
}
