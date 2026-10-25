import {
  useCollaboration,
  EMPTY_WORKBENCH_VIEW,
  updateWorkbenchView,
} from "../workbench-data.js";
import { useEffect, useState } from "react";
import type { Workbench, McpServerInfo } from "@pi-harness/contracts";
import { invoke } from "../api.js";
type Action = (fn: () => Promise<unknown>) => Promise<void>;
export function WorkbenchPermissions({
  w,
  disabled,
  approvalDisabled,
  action,
}: {
  w: Workbench;
  disabled: boolean;
  approvalDisabled?: boolean;
  action: Action;
}) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  useEffect(() => {
    let alive = true;
    void invoke("mcp:list", {})
      .then((r) => {
        if (alive)
          setServers(
            r.servers.filter(
              (s) =>
                s.enabled && s.kind === "http" && s.url?.startsWith("https://"),
            ),
          );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return (
    <section className="wb-access">
      <h3>角色执行权限</h3>
      <p className="hint">
        审批模式按本任务中的角色分别保存，只控制已授权命令与远程插件是否询问；文件职责边界与沙箱始终保留。当前待审批请求仍需处理一次。
      </p>
      {w.participants.map((p) => {
        const access = w.access?.find((a) => a.roleId === p.roleId) ?? {
          roleId: p.roleId,
          commands: false,
          network: false,
          servers: [],
          approvalMode: undefined,
        };
        const save = (patch: Partial<typeof access>) =>
          void action(() =>
            invoke("workbench:setAccess", { id: w.id, roleId:p.roleId, commands:access.commands, network:access.network, servers:access.servers, ...patch }),
          );
        return (
          <fieldset key={p.roleId}>
            <legend>{p.name}</legend>
            <label>
              操作审批
              <select aria-label={`${p.name}审批模式`} value={access.approvalMode ?? "ask"}
                disabled={approvalDisabled ?? disabled}
                onChange={e=>void action(()=>invoke("workbench:setApprovalMode",{id:w.id,roleId:p.roleId,approvalMode:e.target.value as "ask"|"auto"|"allow"}))}>
                <option value="ask">每次询问</option>
                <option value="auto">自动询问</option>
                <option value="allow">完全允许</option>
              </select>
            </label>
            <p className="hint">{access.approvalMode === "allow" ? "已授权的命令和插件直接执行；不会扩大联网、文件或插件权限。" : access.approvalMode === "auto" ? "明确只读的低风险命令自动允许；修改、删除、脚本及风险不明的插件仍询问。" : "命令和远程插件每次执行前询问。"}</p>
            <label>
              <input
                type="checkbox"
                checked={access.commands}
                disabled={disabled}
                onChange={(e) =>
                  save({
                    commands: e.target.checked,
                    network: e.target.checked ? access.network : false,
                  })
                }
              />
              允许在职责范围内运行命令
            </label>
            <label>
              <input
                type="checkbox"
                checked={access.network}
                disabled={disabled || !access.commands}
                onChange={(e) => save({ network: e.target.checked })}
              />
              允许命令联网（可向外部发送角色副本内容）
            </label>
            {servers.map((s) => (
              <label key={s.name}>
                <input
                  type="checkbox"
                  checked={access.servers.includes(s.name)}
                  disabled={disabled}
                  onChange={(e) =>
                    save({
                      servers: e.target.checked
                        ? [...access.servers, s.name]
                        : access.servers.filter((n) => n !== s.name),
                    })
                  }
                />
                允许使用 {s.name}
              </label>
            ))}
            {!servers.length && (
              <p className="hint">
                暂无已启用的 HTTPS 远程插件，可在技能与插件中安装和认证。
              </p>
            )}
          </fieldset>
        );
      })}
    </section>
  );
}
export function WorkbenchVerification({
  w,
  disabled,
  action,
}: {
  w: Workbench;
  disabled: boolean;
  action: Action;
}) {
  const view = useCollaboration((s) => s.views[w.id] ?? EMPTY_WORKBENCH_VIEW);
  const commands = view.verificationCommands,
    network = view.verificationNetwork;
  const setCommands = (verificationCommands: string) =>
    updateWorkbenchView(w.id, { verificationCommands });
  const setNetwork = (verificationNetwork: boolean) =>
    updateWorkbenchView(w.id, { verificationNetwork });
  const allApplied =
    w.participants.some((p) => p.taskId) &&
    w.participants.every((p) => !p.taskId || p.status === "applied");
  return (
    <section className="wb-verification">
      <h3>自动联调</h3>
      <p className="hint">
        在项目独立副本中依次运行已确认的命令（允许本机回环接口联调），失败立即停止。安装依赖、测试和构建可能执行项目脚本，请核对步骤。通过后仍需确认业务效果。
      </p>
      <button
        className="ghost"
        disabled={disabled || !allApplied}
        onClick={() =>
          void action(async () => {
            const plan = await invoke("workbench:verificationPlan", {
              id: w.id,
            });
            setCommands(plan.commands.join("\n"));
            setNetwork(plan.network);
            if (!plan.commands.length)
              throw new Error("未发现可识别的检查脚本，请手动填写验收命令。");
          })
        }
      >
        识别项目检查步骤
      </button>
      <label>
        验收命令（每行一步）
        <textarea
          aria-label="验收命令"
          value={commands}
          onChange={(e) => setCommands(e.target.value)}
          disabled={disabled}
          placeholder={
            "例如：npm ci --ignore-scripts\nnpm run test\nnpm run build"
          }
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={network}
          onChange={(e) => setNetwork(e.target.checked)}
          disabled={disabled}
        />
        允许此次联调联网
      </label>
      <button
        className="primary"
        disabled={disabled || !allApplied || !commands.trim()}
        onClick={() =>
          void action(() =>
            invoke("workbench:verify", {
              id: w.id,
              commands: commands
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
              network,
            }),
          )
        }
      >
        批准步骤并开始联调
      </button>
      {w.verification && (
        <div role="status">
          {w.verification.currentCommand && (
            <p>
              正在执行：<code>{w.verification.currentCommand}</code>
            </p>
          )}
          <p>
            {(
              {
                running: "正在联调，可随时停止",
                passed: "自动检查通过，等待业务验收",
                failed: "自动检查失败，请查看日志",
                cancelled: "联调已取消",
                interrupted: "上次联调中断，请重新检查",
                stale: "成果已更新，请重新联调",
              } as Record<string, string>
            )[w.verification.status] ?? w.verification.status}
          </p>
          {w.verification.steps.map((s, i) => (
            <details key={i}>
              <summary>
                步骤 {i + 1} ·{" "}
                {s.cancelled ? "取消或超时" : s.code === 0 ? "通过" : "失败"} ·{" "}
                {(s.durationMs / 1000).toFixed(1)} 秒 · 退出码 {s.code ?? "—"}
              </summary>
              <code>{s.command}</code>
              <pre>{s.output || "（无输出）"}</pre>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
