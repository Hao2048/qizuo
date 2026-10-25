import { useEffect, useState } from "react";
import type { McpServerInfo, MarketAuthInfo } from "@pi-harness/contracts";
import { invoke } from "../api.js";
const AUTH_URL_RULES: Array<{ match: RegExp; url: string; label: string }> = [
	{ match: /^(GITHUB_PERSONAL_ACCESS_TOKEN|GITHUB_TOKEN|GH_TOKEN)$/i, url: "https://github.com/settings/personal-access-tokens/new", label: "GitHub 新建令牌" },
	{ match: /^(LARK|FEISHU)[A-Z_]*$/i, url: "https://open.feishu.cn/app", label: "飞书开放平台" },
	{ match: /^ANTHROPIC_API_KEY$/i, url: "https://console.anthropic.com/settings/keys", label: "Anthropic 控制台" },
	{ match: /^OPENAI_API_KEY$/i, url: "https://platform.openai.com/api-keys", label: "OpenAI 控制台" },
	{ match: /^(GEMINI|GOOGLE)_API_KEY$/i, url: "https://aistudio.google.com/apikey", label: "Google AI Studio" },
	{ match: /^SLACK[A-Z_]*$/i, url: "https://api.slack.com/apps", label: "Slack 应用管理" },
	{ match: /^NOTION[A-Z_]*$/i, url: "https://www.notion.so/profile/integrations", label: "Notion 集成" },
	{ match: /^LINEAR[A-Z_]*$/i, url: "https://linear.com/settings/api", label: "Linear 设置" },
];

function authUrlFor(varName: string, serverName: string): { url: string; label: string } | null {
	for (const r of AUTH_URL_RULES) if (r.match.test(varName)) return r;
	const s = serverName.toLowerCase();
	if (/github/.test(s)) return { url: "https://github.com/settings/personal-access-tokens/new", label: "GitHub 新建令牌" };
	if (/lark|feishu/.test(s)) return { url: "https://open.feishu.cn/app", label: "飞书开放平台" };
	return null;
}

/** MCP 服务器令牌配置弹窗：列出 ${VAR} 占位符，逐项填写/覆盖/清除，可一键打开获取页。 */
export function McpAuthModal({ server, onDone }: { server: McpServerInfo | null; onDone: () => void }): React.ReactElement | null {
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!server) return null;
	const authVars = server.authVars ?? [];
	const missing = new Set(server.missingVars ?? []);

	const openAuthPage = (url: string) => {
		void invoke("sys:openExternal", { url }).catch(() => {});
	};

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			for (const [k, v] of Object.entries(values)) {
				if (!v.trim()) continue;
				const r = await invoke("mcp:setCredential", { varName: k, value: v.trim() });
				if (!r.ok) throw new Error(r.message ?? "保存失败");
			}
			onDone();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="modal-mask" onClick={(e) => e.target === e.currentTarget && onDone()}>
			<div className="modal small anim-pop" role="dialog" aria-modal="true" aria-label={`配置令牌 · ${server.name}`}>
				<h2>配置令牌 · {server.name}</h2>
				<p className="hint">填写该插件需要的令牌。令牌仅保存在本机，保存后不会显示完整内容。</p>
				{authVars.length === 0 ? (
					<p className="hint">未检测到令牌占位符，无需配置。</p>
				) : (
					authVars.map((v) => {
					const link = authUrlFor(v, server.name);
					return (
						<label key={v}>
							<span className="auth-var-row">
								<code>{v}</code>
								{missing.has(v) ? <span className="auth-miss">未配置</span> : <span className="auth-ok">已配置（输入可覆盖）</span>}
								{link ? (
									<button type="button" className="ghost sm auth-link" onClick={() => openAuthPage(link.url)} title={link.url}>
										↗ {link.label}
									</button>
								) : null}
							</span>
							<input
								type="password"
                                autoFocus={v === authVars[0]}
								autoComplete="off"
								value={values[v] ?? ""}
								placeholder={missing.has(v) ? "粘贴令牌…" : "••••••（留空保持不变）"}
								onChange={(e) => setValues((s) => ({ ...s, [v]: e.target.value }))}
							/>
						</label>
					);
				})
				)}
				{authVars.length > 0 ? (
					<div className="auth-clear-row">
						{authVars.filter((v) => !missing.has(v)).map((v) => (
							<button key={v} type="button" className="ghost sm danger-text" onClick={() => void invoke("mcp:clearCredential", { varName: v }).then(onDone)}>
								清除 {v}
							</button>
						))}
					</div>
				) : null}
				{error ? <p className="hint bad">{error}</p> : null}
				<div className="modal-actions">
					<button type="button" className="ghost" disabled={busy} onClick={onDone}>
						取消
					</button>
					<button type="button" className="primary" disabled={busy || authVars.length === 0 || [...missing].some(v => !values[v]?.trim())} onClick={() => void save()}>
						保存
					</button>
				</div>
			</div>
		</div>
	);
}


export function PluginAuthModal({ source, onDone }: { source: string; onDone: () => void }): React.ReactElement {
 const [info, setInfo] = useState<MarketAuthInfo | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [manual, setManual] = useState(false);
 useEffect(() => {
 let cancelled = false;
 const refresh = () => void invoke("market:authInfo", { source }).then(x => { if (!cancelled) setInfo(x); }).catch(e => { if (!cancelled) setError(String(e)); });
 refresh(); const timer = setInterval(refresh, 2000);
 return () => { cancelled = true; clearInterval(timer); };
 }, [source]);
 if (info?.kind === "token" && info.servers.length && manual) {
 const server = { ...info.servers[0]!, name: source.replace(/^claude:/,""), authVars: [...new Set(info.servers.flatMap(s => s.authVars ?? []))], missingVars: [...new Set(info.servers.flatMap(s => s.missingVars ?? []))] };
 return <McpAuthModal server={server} onDone={() => {
 // Some OAuth servers first require a client secret. Continue into browser authorization after saving it.
 void invoke("market:authInfo", { source }).then(next => {
 if (next.kind === "oauth" && next.status === "required") setInfo(next);
 else onDone();
 }).catch(onDone);
 }} />;
 }
 const start = async () => { setError(null); try { setInfo(await invoke("market:authStart", { source })); } catch(e) { setError(String(e)); } };
 return <div className="modal-mask"><div className="modal small anim-pop" role="dialog" aria-modal="true" aria-labelledby="plugin-auth-title">
 <h2 id="plugin-auth-title">{info?.kind === "lark" ? "飞书认证" : source === "claude:github" ? "GitHub 认证" : "插件认证"}</h2>
 {info?.status !== "error" ? <p className="hint">{info?.message ?? (info?.kind === "none" ? "该插件没有需要填写的认证信息。" : "正在检查认证方式…")}</p> : null}
 {info?.kind === "lark" && info.status !== "ready" ? <p className="hint">首次认证包含应用开通和用户登录两个步骤。每一步都会打开对应授权页，软件会自动核验登录结果。</p> : null}
 {info?.status === "error" ? <p role="alert" className="hint bad">{info.message}</p> : null}
 {info?.url ? <button className="ghost" type="button" onClick={() => void invoke("sys:openExternal", { url: info.url! })}>重新打开授权页面</button> : null}
 {info?.verificationCode ? <p className="hint">一次性验证码：<strong>{info.verificationCode}</strong> <button type="button" className="ghost sm" onClick={() => void navigator.clipboard.writeText(info.verificationCode!).catch(() => setError("复制失败，请直接输入上方验证码。"))}>复制验证码</button></p> : null}
 {info?.kind === "token" ? <button type="button" className="ghost" onClick={() => setManual(true)}>高级配置 · 服务密钥</button> : null}
 {error ? <p role="alert" className="hint bad">{error}</p> : null}
 <div className="modal-actions"><button type="button" className="ghost" onClick={onDone}>{info?.status === "ready" ? "完成" : "稍后认证"}</button>
 {(info?.kind === "lark" || info?.kind === "oauth") ? <button type="button" className="primary" disabled={info.status === "working"} onClick={() => void start()}>{info.status === "working" ? "等待浏览器授权…" : info.status === "ready" ? "检查认证" : "开始认证"}</button> : null}</div>
 </div></div>;
}
