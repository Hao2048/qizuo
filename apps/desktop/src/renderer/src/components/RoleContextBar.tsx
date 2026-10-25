import { useEffect, useState } from "react";
import type { RoleContextInfo } from "@pi-harness/contracts";
import { invoke, onEvent } from "../api.js";
import { useStore } from "../store.js";

/** Read-only identity and the latest request context of each independent role session. */
export default function RoleContextBar(): React.ReactElement {
  const taskId = useStore((s) => s.currentTaskId);
  const roles = useStore((s) => s.roles);
  const roleId = useStore((s) => s.draftRoleId);
  const [result, setResult] = useState<{
    taskId: string;
    roles: RoleContextInfo[];
  } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!taskId) return;
    let disposed = false,
      revision = 0,
      timer: ReturnType<typeof setTimeout> | undefined;
    setFailed(null);
    const load = async () => {
      const request = ++revision;
      try {
        const data = await invoke("task:getRoleContexts", { taskId });
        if (!disposed && request === revision) {
          setResult({ taskId, roles: data.roles ?? [] });
          setFailed(null);
        }
      } catch {
        if (!disposed && request === revision) setFailed(taskId);
      }
    };
    void load();
    const unsubscribe = onEvent((event) => {
      if (
        (event.type !== "task:roleContext" && event.type !== "task:state") ||
        event.payload.taskId !== taskId
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 80);
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [taskId]);
  const id = roleId ?? roles.find((role) => role.isDefault)?.id ?? null;
  const draft: RoleContextInfo[] = [
    {
      roleId: id,
      roleName: roles.find((role) => role.id === id)?.name ?? "任务助手",
      kind: "single",
      context: { percent: null },
    },
  ];
  const current = taskId
    ? result?.taskId === taskId
      ? result.roles
      : []
    : draft;
  return (
    <div className="role-context-bar" aria-label="当前角色与上下文">
      {current.map((role, index) => {
        const percent =
          failed === taskId && !!taskId ? null : role.context.percent;
        const known = typeof percent === "number" && Number.isFinite(percent);
        const cache =
          failed === taskId && !!taskId ? null : role.context.cacheHitPercent;
        const cacheKnown = typeof cache === "number" && Number.isFinite(cache);
        const compacting = role.context.compacting;
        const label = compacting ? "压缩中" : known ? `${percent}%` : "—";
        const description = compacting
          ? "正在压缩上下文"
          : known
            ? `${role.context.currentTokens?.toLocaleString()} / ${role.context.contextWindow?.toLocaleString()} token · ${role.context.note ?? "最近请求估算"}`
            : failed === taskId && !!taskId
              ? "上下文暂时不可用"
              : "等待该角色发送请求后更新上下文占比";
        return (
          <div
            className="role-context-card"
            key={role.roleId ?? index}
            title={description}
          >
            <span className="role-context-avatar" aria-hidden="true">
              {role.roleName.slice(0, 1)}
            </span>
            <span className="role-context-name">{role.roleName}</span>

            <span
              className={`role-context-ring${known && percent >= 85 ? " near-limit" : ""}`}
              role="progressbar"
              aria-label={`${role.roleName}上下文使用占比`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                known && !compacting ? Math.min(100, percent) : undefined
              }
              aria-valuetext={label}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle className="ring-track" cx="12" cy="12" r="9" />
                <circle
                  className="ring-value"
                  cx="12"
                  cy="12"
                  r="9"
                  pathLength="100"
                  strokeDasharray={`${known && !compacting ? Math.min(100, Math.max(0, percent)) : 0} 100`}
                />
              </svg>
            </span>
            <span className="role-context-value">{label}</span>
            <span
              className="role-cache-hit"
              aria-label={`${role.roleName}缓存命中率`}
              title="该角色最近一次请求的模型回执；未返回缓存用量时显示 —"
            >
              缓存命中 {cacheKnown ? `${cache}%` : "—"}
            </span>
          </div>
        );
      })}
      {taskId && current.length === 0 ? (
        <span className="role-context-pending">
          {failed === taskId ? "角色上下文暂时不可用" : "正在读取角色…"}
        </span>
      ) : null}
    </div>
  );
}
