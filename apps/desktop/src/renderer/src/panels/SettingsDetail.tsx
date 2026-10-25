import PageHeader from "../components/PageHeader.js";
import { useAppearance, setAppearance } from "../appearance.js";
import { useEffect, useState } from "react";
import type { ProviderInfo, ConnectionTestResult } from "@pi-harness/contracts";
import { DEFAULT_AGENT_LIMITS } from "@pi-harness/shared";
import type { AgentLimits } from "@pi-harness/contracts";
import { invoke, bridge } from "../api.js";
import { useStore } from "../store.js";
import { refreshStaticData } from "../data.js";
import {
  ApprovalPolicySection,
  SandboxSection,
} from "../components/M7Widgets.js";
import McpStatusPanel from "../components/McpStatusPanel.js";
import { LoginModal } from "../components/LoginModal.js";

/** 设置右列：按中列分区渲染。 */
export default function SettingsDetail(): React.ReactElement {
  const section = useStore((s) => s.settingsSection);
  const load = () => {
    void refreshStaticData().catch(() => {});
  };
  useEffect(load, []);

  return (
    <div className="detail settings-detail">
      <PageHeader
        section="设置"
        title={
          {
            model: "模型与思考",
            connections: "账号与连接",
            mcp: "MCP 服务",
            approval: "权限与审批",
            prefs: "外观与偏好",
            backup: "数据与备份",
            about: "关于软件",
          }[section]
        }
      />
      <div className="page-scroll">
        <div className="settings-body">
          {section === "model" ? <ModelSection /> : null}
          {section === "connections" ? (
            <ConnectionsSection onRefresh={load} />
          ) : null}
          {section === "mcp" ? <McpSection /> : null}
          {section === "approval" ? (
            <section className="panel flat">
              <div className="panel-head">
                <h1>工具审批策略</h1>
              </div>
              <ApprovalPolicySection />
              <div className="panel-head" style={{ marginTop: 22 }}>
                <h1>运行沙箱（bash）</h1>
              </div>
              <SandboxSection />
              <AgentLimitsSection />
            </section>
          ) : null}
          {section === "prefs" ? <PrefsSection /> : null}
          {section === "backup" ? <BackupSection /> : null}
          {section === "about" ? <AboutSection /> : null}
        </div>
      </div>
      <LoginModal />
    </div>
  );
}

/* ---------------- 默认模型 ---------------- */

function ModelSection(): React.ReactElement {
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const connected = providers.filter(
    (p) => p.authConfigured && p.models.length > 0,
  );
  return (
    <section className="panel flat">
      <div className="panel-head">
        <h1>默认模型</h1>
      </div>
      {settings?.defaultModel ? (
        <p className="hint">
          当前默认：
          <strong>
            {settings.defaultModel.provider}/{settings.defaultModel.modelId}
          </strong>
        </p>
      ) : (
        <p className="hint danger">
          尚未设置默认模型——发起新任务前需要先选择。
        </p>
      )}
      {connected.map((p) => (
        <div key={p.id} className="card-row">
          <div className="card-main">
            <div className="card-name">{p.name}</div>
            <div className="card-meta">{p.models.length} 个模型</div>
          </div>
          <div className="bar-actions">
            <ModelPicker provider={p} />
          </div>
        </div>
      ))}
      {connected.length === 0 ? (
        <p className="hint">
          没有已连接的提供商——到「连接」配置 API Key 或订阅登录。
        </p>
      ) : null}
    </section>
  );
}

function ModelPicker({
  provider,
}: {
  provider: ProviderInfo;
}): React.ReactElement {
  const settings = useStore((s) => s.settings);
  const current = settings?.defaultModel;
  const [open, setOpen] = useState(false);
  return (
    <div className="usage-panel">
      <button type="button" className="ghost" onClick={() => setOpen(!open)}>
        {current?.provider === provider.id ? "更换模型" : "设为默认"}
      </button>
      {open ? (
        <div className="usage-table">
          {provider.models.slice(0, 20).map((m) => (
            <button
              type="button"
              key={m.id}
              className="popover-item"
              onClick={async () => {
                setOpen(false);
                const next = await invoke("settings:set", {
                  defaultModel: { provider: provider.id, modelId: m.id },
                  autoApproveTools: settings?.autoApproveTools ?? [
                    "read",
                    "grep",
                    "find",
                    "ls",
                  ],
                  autoMemory: settings?.autoMemory ?? false,
                  sandboxMode: settings?.sandboxMode ?? "off",
                });
                useStore.getState().hydrate({ settings: next });
              }}
            >
              {m.name}
              {current?.modelId === m.id && current?.provider === provider.id
                ? " ✓"
                : ""}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- 连接 ---------------- */

function ConnectionsSection({
  onRefresh,
}: {
  onRefresh: () => void;
}): React.ReactElement {
  const providers = useStore((s) => s.providers);
  const [openId, setOpenId] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    provider: string;
    result: ConnectionTestResult;
  } | null>(null);

  const order = (p: ProviderInfo): number => {
    if (p.authConfigured) return 0;
    if (
      ["anthropic", "openai", "zai", "zai-coding-cn", "deepseek"].includes(p.id)
    )
      return 1;
    if (p.models.length > 0) return 2;
    return 3;
  };
  const visible = [...providers]
    .filter((p) => p.models.length > 0)
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .slice(0, 40);

  const saveKey = async (provider: string) => {
    if (!keyDraft.trim()) return;
    try {
      await invoke("model:setApiKey", { provider, apiKey: keyDraft.trim() });
      setKeyDraft("");
      onRefresh();
    } catch (e) {
      useStore
        .getState()
        .setNotice({
          level: "error",
          message: e instanceof Error ? e.message : String(e),
        });
    }
  };

  return (
    <section className="panel flat">
      <div className="panel-head">
        <h1>连接</h1>
      </div>
      {visible.map((p) => (
        <div
          key={p.id}
          className={`card-row${p.authConfigured ? " connected" : ""}`}
        >
          <div className="card-main">
            <div className="card-name">
              {p.name}
              <span
                className={`conn-dot ${p.authConfigured ? "on" : ""}`}
                title={p.authConfigured ? "已连接" : "未配置"}
              />
            </div>
            <div className="card-meta">
              {p.models.length} 个模型 · {p.id}
            </div>
          </div>
          <div className="bar-actions">
            {p.oauthSupported ? (
              <button
                type="button"
                className="ghost accent-text"
                onClick={async () => {
                  try {
                    await invoke("model:login", { provider: p.id });
                  } catch (e) {
                    useStore
                      .getState()
                      .setNotice({
                        level: "error",
                        message: e instanceof Error ? e.message : String(e),
                      });
                  }
                }}
              >
                订阅登录
              </button>
            ) : null}
            {p.authConfigured ? (
              <>
                {p.models[0] ? (
                  <button
                    type="button"
                    className="ghost"
                    disabled={testing === p.id}
                    onClick={async () => {
                      setTesting(p.id);
                      setTestResult(null);
                      try {
                        const result = await invoke("model:testConnection", {
                          provider: p.id,
                          modelId: p.models[0]!.id,
                        });
                        setTestResult({ provider: p.id, result });
                      } finally {
                        setTesting(null);
                      }
                    }}
                  >
                    {testing === p.id ? "测试中…" : "测试连接"}
                  </button>
                ) : null}
                {testResult?.provider === p.id ? (
                  <span
                    className={`test-result ${testResult.result.ok ? "ok" : "bad"}`}
                  >
                    {testResult.result.ok
                      ? `✓ ${testResult.result.latencyMs ?? "?"}ms`
                      : `✗ ${testResult.result.message.slice(0, 50)}`}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="ghost danger-text"
                  onClick={async () => {
                    await invoke("model:removeApiKey", { provider: p.id });
                    onRefresh();
                  }}
                >
                  清除密钥
                </button>
              </>
            ) : openId === p.id ? (
              <>
                <input
                  type="password"
                  className="key-input"
                  placeholder="API Key"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                />
                <button
                  type="button"
                  className="primary sm"
                  onClick={() => void saveKey(p.id)}
                >
                  保存
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setOpenId(null);
                    setKeyDraft("");
                  }}
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setOpenId(p.id);
                  setKeyDraft("");
                }}
              >
                配置 API Key
              </button>
            )}
          </div>
        </div>
      ))}
      {providers.length > visible.length ? (
        <p className="hint">
          另有 {providers.length - visible.length} 个提供商未展示。
        </p>
      ) : null}
    </section>
  );
}

/* ---------------- MCP ---------------- */

function McpSection(): React.ReactElement {
  const [servers, setServers] = useState<
    Array<{
      name: string;
      kind: string;
      command?: string | null;
      url?: string | null;
      enabled: boolean;
    }>
  >([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    void invoke("mcp:list", {})
      .then((r) => setServers(r.servers))
      .catch(() => setServers([]));
  };
  useEffect(reload, []);

  const add = async () => {
    setError(null);
    try {
      const parts = command.trim() ? command.trim().split(/\s+/) : [];
      await invoke("mcp:add", {
        name: name.trim(),
        command: parts[0] ?? undefined,
        args: parts.length > 1 ? parts.slice(1) : undefined,
        url: url.trim() || undefined,
      });
      setAdding(false);
      setName("");
      setCommand("");
      setUrl("");
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="panel flat">
      <div className="panel-head">
        <h1>MCP 服务器</h1>
        <button type="button" className="ghost" onClick={() => setAdding(true)}>
          添加服务器
        </button>
      </div>
      <McpStatusPanel revision={servers} />
      <details className="mcp-config-details">
        <summary>服务器配置与管理</summary>
        {servers.length === 0 ? (
          <p className="hint">
            暂无 MCP 服务器。常用：npx -y
            @modelcontextprotocol/server-filesystem /path
          </p>
        ) : (
          servers.map((srv) => (
            <div key={srv.name} className="card-row">
              <div className="card-main">
                <div className="card-name">
                  {srv.name}
                  <span className="card-meta">
                    {srv.enabled ? "配置已启用" : "配置已停用"}
                  </span>
                </div>
                <div className="card-meta clamp">
                  {srv.kind === "stdio" ? (srv.command ?? "") : (srv.url ?? "")}
                </div>
              </div>
              <div className="bar-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={async () => {
                    await invoke("mcp:setEnabled", {
                      name: srv.name,
                      enabled: !srv.enabled,
                    });
                    reload();
                  }}
                >
                  {srv.enabled ? "停用" : "启用"}
                </button>
                <button
                  type="button"
                  className="ghost danger-text"
                  onClick={async () => {
                    await invoke("mcp:remove", { name: srv.name });
                    reload();
                  }}
                >
                  移除
                </button>
              </div>
            </div>
          ))
        )}
      </details>
      {adding ? (
        <div className="mcp-form anim-pop">
          <input
            placeholder="名称（字母数字-_）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="stdio 命令（如：npx -y @modelcontextprotocol/server-filesystem /path）"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <input
            placeholder="或 HTTP URL（https://…/mcp）"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {error ? <p className="hint danger">{error}</p> : null}
          <div className="provider-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void add()}
            >
              保存
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setAdding(false)}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}
      <p className="hint">
        添加后新任务自动接入（工具默认对模型直接可用，受审批策略管控）。
      </p>
    </section>
  );
}

/* ---------------- 任务偏好 ---------------- */

function PrefsSection(): React.ReactElement {
  const appearance = useAppearance();
  const settings = useStore((s) => s.settings);
  const toggleAutoMemory = async (on: boolean) => {
    const current = useStore.getState().settings;
    const next = await invoke("settings:set", {
      defaultModel: current?.defaultModel ?? null,
      autoApproveTools: current?.autoApproveTools ?? [
        "read",
        "grep",
        "find",
        "ls",
      ],
      autoMemory: on,
      sandboxMode: current?.sandboxMode ?? "off",
    });
    useStore.getState().hydrate({ settings: next });
  };
  return (
    <section className="panel flat">
      <div className="panel-head">
        <h2>外观</h2>
      </div>
      <div className="appearance-row">
        <div>
          <strong>主题</strong>
          <p className="hint">为整个软件选择浅色、深色或跟随系统。</p>
        </div>
        <div className="seg" role="group" aria-label="主题">
          {(
            [
              ["light", "浅色"],
              ["dark", "深色"],
              ["system", "跟随系统"],
            ] as const
          ).map(([v, label]) => (
            <button
              type="button"
              key={v}
              className={`seg-btn${appearance === v ? " on" : ""}`}
              aria-pressed={appearance === v}
              onClick={() => setAppearance(v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <h2>角色记忆</h2>
      <label className="toggle-label block">
        <input
          type="checkbox"
          checked={settings?.autoMemory ?? false}
          onChange={(e) => void toggleAutoMemory(e.target.checked)}
        />
        回合后自动记忆：在系统提示词中加入主动记忆指令（模型自行判断是否保存；明确要求记住时必调用）
      </label>
    </section>
  );
}

/* ---------------- 备份与维护 ---------------- */

function BackupSection(): React.ReactElement {
  const [backups, setBackups] = useState<
    Array<{ id: string; createdAt: number; sizeBytes?: number }>
  >([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    void invoke("backup:list", {})
      .then((r) => setBackups(r.backups))
      .catch(() => setBackups([]));
  };
  useEffect(reload, []);

  return (
    <section className="panel flat">
      <div className="panel-head">
        <h1>备份与维护</h1>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const info = await invoke("backup:create", {});
              setMessage(`已创建备份 ${info.id}`);
              reload();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "备份中…" : "创建备份"}
        </button>
      </div>
      <div className="provider-actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="ghost"
          onClick={async () => {
            const r = await invoke("diag:export", {}).catch(() => null);
            if (r?.ok)
              useStore
                .getState()
                .setNotice({
                  level: "info",
                  message: `诊断目录已打开：${r.path}`,
                });
          }}
        >
          导出诊断信息
        </button>
      </div>
      {backups.slice(0, 10).map((b) => (
        <div key={b.id} className="card-row">
          <div className="card-main">
            <div className="card-name">
              {new Date(b.createdAt).toLocaleString("zh-CN")}
            </div>
            <div className="card-meta">
              {b.sizeBytes ? `${Math.round(b.sizeBytes / 1024)} KB` : ""}
            </div>
          </div>
          <button
            type="button"
            className="ghost danger-text"
            onClick={async () => {
              const r = await invoke("backup:restore", { id: b.id });
              setMessage(r.message);
              if (
                r.ok &&
                window.confirm("恢复需要重启应用（当前凭证保留）。现在重启吗？")
              ) {
                await invoke("app:restart", {});
              }
            }}
          >
            恢复
          </button>
        </div>
      ))}
      {message ? <p className="hint">{message}</p> : null}
      <p className="hint">凭证（API Key / OAuth）不进入备份与诊断导出。</p>
    </section>
  );
}

/* ---------------- 运行环境 ---------------- */

function AboutSection(): React.ReactElement {
  const [checkState, setCheckState] = useState<
    "idle" | "running" | "done" | "error"
  >("idle");
  const versions: { electron: string; chrome: string } | null = (() => {
    try {
      return bridge().versions;
    } catch {
      return null;
    }
  })();
  return (
    <section className="panel flat">
      <div className="panel-head">
        <h1>运行环境</h1>
      </div>
      <p className="hint">
        Electron {versions?.electron ?? "未知"} · Chromium{" "}
        {versions?.chrome ?? "未知"} · 更新检查待分发渠道接入
      </p>
      <button
        type="button"
        className="ghost"
        onClick={async () => {
          setCheckState("running");
          try {
            const health = await invoke("health:get", {});
            const pong = await invoke("dev:ping", { echo: "自检" });
            setCheckState(health.ok && pong.pong ? "done" : "error");
          } catch {
            setCheckState("error");
          }
        }}
      >
        运行系统自检
      </button>
      {checkState === "done" ? <p className="hint ok">自检通过</p> : null}
      {checkState === "error" ? (
        <p className="hint danger">自检存在失败项</p>
      ) : null}
    </section>
  );
}

function AgentLimitsSection(): React.ReactElement {
  const settings = useStore((s) => s.settings);
  const [limits, setLimits] = useState<AgentLimits>(DEFAULT_AGENT_LIMITS),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setLimits({ ...DEFAULT_AGENT_LIMITS, ...settings?.agentLimits });
  }, [settings?.agentLimits]);
  const fields: Array<{
    key: keyof AgentLimits;
    label: string;
    min: number;
    max: number;
    factor?: number;
  }> = [
    { key: "maxConcurrent", label: "同时运行的成员", min: 1, max: 6 },
    { key: "maxMembers", label: "成员数量上限", min: 1, max: 12 },
  ];
  return (
    <section className="agent-limits-settings">
      <h2>协作并发</h2>
      <p className="hint">设置同时运行的角色和参与人数，下一轮协作生效。</p>
      {fields.map((f) => (
        <label key={f.key}>
          {f.label}
          <input
            type="number"
            min={f.min}
            max={f.max}
            step="1"
            value={
              (limits[f.key] ??
                DEFAULT_AGENT_LIMITS[
                  f.key as keyof typeof DEFAULT_AGENT_LIMITS
                ]) / (f.factor ?? 1)
            }
            onChange={(e) =>
              setLimits((v) => ({
                ...v,
                [f.key]: Number(e.target.value) * (f.factor ?? 1),
              }))
            }
          />
        </label>
      ))}
      <button
        type="button"
        className="btn primary"
        disabled={busy || !settings}
        onClick={async () => {
          if (!settings) return;
          setBusy(true);
          try {
            await invoke("settings:set", { ...settings, agentLimits: limits });
            await refreshStaticData();
            useStore
              .getState()
              .setNotice({ level: "info", message: "协作并发设置已保存" });
          } catch (error) {
            useStore
              .getState()
              .setNotice({ level: "error", message: String(error) });
          } finally {
            setBusy(false);
          }
        }}
      >
        保存并发设置
      </button>
    </section>
  );
}
