import { authorizeMcpServer, checkMcpServer } from "./mcp-authorization.js";
import { authorizeGithub, reuseGithub, GithubAccessError, type GithubAuthOptions } from "./github-authorization.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { MarketAuthInfo } from "@pi-harness/contracts";
import type { MarketService } from "./market-service.js";
import type { McpService } from "../mcp/mcp-service.js";

const LARK_PACKAGES = new Set(["@amaster.ai/pi-lark", "@tunglam/pi-lark-cli", "@yandy0725/pi-lark"]);
function packageName(source: string): string { return source.replace(/^npm:/, "").replace(/@[^@/]+$/, ""); }
export function isLarkSource(source: string): boolean { return LARK_PACKAGES.has(packageName(source)); }
function stateKey(source: string): string { return isLarkSource(source) ? `npm:${packageName(source)}` : source; }
export function allowedLarkAuthUrl(value: string): boolean {
 try { const url = new URL(value); return url.protocol === "https:" && ["feishu.cn", "larksuite.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)); } catch { return false; }
}
/** CLI device authorization stays in main; tokens and raw CLI output never reach renderer. */
export class MarketAuthService {
 #market: MarketService; #mcp: McpService; #agentDir: string; #open: (url: string) => void;
 #states = new Map<string, MarketAuthInfo>(); #children = new Set<ChildProcess>(); #disposed = false;
 #checked = new Map<string, number>();
 #checks = new Map<string, Promise<MarketAuthInfo>>();
 #abort = new AbortController();
 #done: () => void;
 constructor(market: MarketService, mcp: McpService, agentDir: string, open: (url: string) => void, done: () => void = () => {}) { this.#market = market; this.#mcp = mcp; this.#agentDir = agentDir; this.#open = open; this.#done = done; }
 info(source: string): MarketAuthInfo {
 const state = this.#states.get(stateKey(source));
 if (state) {
 const clearedClientCredential = state.kind === "oauth" && state.status === "ready" && this.#mcp.list().some(server => state.servers.some(previous => previous.name === server.name) && server.missingVars?.length);
 if (!clearedClientCredential) return { ...state, source };
 this.#states.delete(stateKey(source));
 }
 if (isLarkSource(source)) return { source, kind: "lark", status: "required", message: "在浏览器中创建或选择飞书应用，然后授权登录。已有 CLI 配置会复用。", servers: [] };
 const name = source.replace(/^claude:/, "");
 const servers = this.#mcp.list().filter(s => s.description === `来自官方插件 ${name}` || s.name === name);
 const github = servers.filter(server => this.#mcp.githubCredential(server.name));
 if (github.length && github.length === servers.length) return { source, kind: "oauth", status: github.some(server => server.missingVars?.length) ? "required" : "ready", message: "通过 GitHub 官方浏览器授权，无需创建或粘贴令牌。GitHub 可能要求输入一次性验证码。", servers };
 const vars = servers.flatMap(s => s.authVars ?? []);
 if (vars.length && servers.some(s => s.missingVars?.length)) return { source, kind: "token", status: "required", message: "该服务尚未提供可用的浏览器授权，当前仍需服务密钥。可在高级配置中填写。", servers };
 const remote = servers.filter(s => s.kind === "http" && s.url && this.#mcp.supportsBrowserAuth(s.name));
 if (remote.length) {
 let states: Record<string, { tokens?: { access_token?: string } }> = {};
 try { states = JSON.parse(readFileSync(join(this.#agentDir, "mcp-auth.json"), "utf8")); } catch { /* not authorized */ }
 const configured = remote.every(s => !!states[`mcp__${s.name.replace(/-/g, "_")}|${new URL(s.url!).href}`]?.tokens?.access_token);
 return { source, kind: "oauth", status: configured ? "ready" : "required", message: "检测远程服务器并打开其浏览器授权页；无需认证的服务器会直接完成检测。", servers };
 }
 return { source, kind: vars.length ? "token" : "none", status: "ready", servers };
 }
 async refresh(source: string): Promise<MarketAuthInfo> {
 const info = this.info(source); const key = stateKey(source);
 if (info.status === "working" || this.#disposed) return info;
 const github = info.servers.filter(server => this.#mcp.githubCredential(server.name));
 if (github.length && github.length === info.servers.length) {
 const pending = this.#checks.get(key); if (pending) return { ...await pending, source };
 if (this.#states.has(key) && Date.now() - (this.#checked.get(key) ?? 0) < 60_000) return info;
 const previous = this.#states.get(key);
 const check = (async () => {
 const result = await reuseGithub(this.#githubOptions(source, github));
 if (!this.#disposed && this.#states.get(key) === previous) {
 if (result.status === "ready") for (const server of github) this.#mcp.setCredential(this.#mcp.githubCredential(server.name)!, result.token!);
 this.#checked.set(key, Date.now());
 this.#states.set(key, { ...info, status: result.status === "unavailable" ? "error" : result.status,
 message: result.status === "ready" ? `已复用 GitHub 登录（${result.account}），插件连接及工具访问已验证。` : result.status === "unavailable" ? "暂时无法连接 GitHub 或插件服务器，已保留已有授权，请稍后重试。" : "已有登录缺失、失效或插件权限不足，请通过浏览器完成授权。" });
 }
 return this.info(source);
 })();
 this.#checks.set(key, check);
 try { return await check; } finally { this.#checks.delete(key); }
 }
 if (info.kind === "oauth" && info.servers.length) {
 const pending = this.#checks.get(key); if (pending) return { ...await pending, source };
 if (this.#states.has(key) && Date.now() - (this.#checked.get(key) ?? 0) < 60_000) return info;
 const previous = this.#states.get(key);
 const check = (async () => {
 const results = await Promise.all(info.servers.filter(server => server.kind === "http").map(server => checkMcpServer(server.name, this.#agentDir)));
 if (!this.#disposed && this.#states.get(key) === previous) {
 const status = results.includes("unavailable") ? "error" : results.includes("required") ? "required" : "ready";
 this.#checked.set(key, Date.now());
 this.#states.set(key, { ...info, status, message: status === "ready" ? "已有授权与插件工具访问已验证，无需重复认证。" : status === "error" ? "插件服务器暂时不可用，已保留已有授权，请稍后重试。" : "已有授权失效或权限不足，请在浏览器中完成授权。" });
 }
 return this.info(source);
 })();
 this.#checks.set(key, check);
 try { return await check; } finally { this.#checks.delete(key); }
 }
 if (info.kind === "token" && info.status === "required" && !this.#disposed) {
 const pending = this.#checks.get(key); if (pending) return { ...await pending, source };
 if (Date.now() - (this.#checked.get(key) ?? 0) < 60_000) return info;
 const check = (async () => {
 await Promise.all(info.servers.filter(server => server.kind === "http").map(server => this.#mcp.prepareBrowserAuth(server.name)));
 this.#checked.set(key, Date.now()); return this.info(source);
 })();
 this.#checks.set(key, check);
 let prepared: MarketAuthInfo;
 try { prepared = await check; } finally { this.#checks.delete(key); }
 // Discovery can reveal an OAuth server with a valid shared grant. Verify it before showing a dialog.
 return prepared.kind === "oauth" ? this.refresh(source) : prepared;
 }
 if (info.kind !== "lark" || this.#disposed) return info;
 const pending = this.#checks.get(key); if (pending) return { ...await pending, source };
 if (Date.now() - (this.#checked.get(key) ?? 0) < 10_000) return info;
 const installed = this.#market.listInstalled().packages.find(p => packageName(p.source) === packageName(source));
 const binary = installed && this.#findBinary(installed.installedPath ?? undefined);
 if (!binary) return info;
 const previous = this.#states.get(key);
 const check = (async () => {
 const ready = await this.#loggedIn(source, binary);
 if (!this.#disposed && this.#states.get(key) === previous) {
 this.#checked.set(key, Date.now());
 this.#states.set(key, ready ? this.#ready(source) : { ...info, status: info.status === "ready" ? "required" : info.status, message: info.status === "ready" ? "飞书登录已失效，请重新认证。" : info.message });
 }
 return this.info(source);
 })();
 this.#checks.set(key, check);
 try { return await check; } finally { this.#checks.delete(key); }
 }
 #ready(source: string): MarketAuthInfo { return { source, kind: "lark", status: "ready", message: "飞书授权已验证，新任务可使用该插件。", servers: [] }; }
 async #loggedIn(source: string, binary: string): Promise<boolean> {
 try {
 const result = JSON.parse(await this.#run(source, binary, ["auth", "status", "--json"], 20_000, false));
 return result.identities?.user?.available === true && result.identities.user.tokenStatus === "valid";
 } catch { return false; }
 }
 start(source: string): MarketAuthInfo {
 const info = this.info(source);
 if (info.kind !== "lark" && info.kind !== "oauth") return info;
 if (info.status === "working") return info;
 if (info.kind === "oauth") {
 const state: MarketAuthInfo = { ...info, status: "working", message: "正在连接服务器并准备浏览器授权…" };
 this.#states.set(stateKey(source), state);
 void this.#authorizeMcp(source, info.servers).catch(error => { if (!this.#disposed) {
 this.#checked.set(stateKey(source), Date.now());
 this.#states.set(stateKey(source), { ...state, status: "error", message: error instanceof GithubAccessError ? error.status === "unavailable" ? "暂时无法连接 GitHub 或插件服务器，已保留已有授权，请稍后重试。" : "GitHub 登录已完成，但插件访问仍受限制。请检查账号权限或组织审批。" : "服务器认证失败或超时，请重试。" });
 } });
 return state;
 }
 const installed = this.#market.listInstalled().packages.find(p => packageName(p.source) === packageName(source));
 if (!installed) return { ...info, status: "error", message: "请先安装飞书插件" };
 const state: MarketAuthInfo = { source, kind: "lark", status: "working", message: "正在准备飞书认证…", servers: [] };
 this.#states.set(stateKey(source), state);
 void this.#authorize(source, installed.installedPath ?? undefined).catch(() => {
 if (!this.#disposed) {
 const phase = this.#states.get(stateKey(source))?.message;
 this.#states.set(stateKey(source), { ...state, status: "error", message: phase?.includes("创建") ? "飞书应用配置未完成或超时，请重试。" : "飞书用户登录未完成或超时。应用开通成功后，还需完成用户授权；稍后会自动核验已有登录。" });
 this.#checked.delete(stateKey(source));
 }
 });
 return state;
 }
 #githubOptions(source: string, servers: MarketAuthInfo["servers"]): GithubAuthOptions {
 return {
 agentDir: this.#agentDir, signal: this.#abort.signal,
 configuredToken: process.env[this.#mcp.githubCredential(servers[0]!.name)!],
 validate: async token => {
 const results = await Promise.all(servers.map(server => checkMcpServer(server.name, this.#agentDir, token)));
 return results.includes("unavailable") ? "unavailable" : results.includes("required") ? "required" : "ready";
 },
 progress: message => { if (!this.#disposed) this.#states.set(stateKey(source), { source, kind: "oauth", status: "working", message, servers }); },
 authorize: (url, verificationCode) => {
 if (this.#disposed) return;
 this.#states.set(stateKey(source), { source, kind: "oauth", status: "working", message: "请在 GitHub 浏览器页面登录并同意授权。若要求验证码，请输入下方代码。", url, verificationCode, servers }); this.#open(url);
 },
 };
 }
 async #authorizeMcp(source: string, servers: MarketAuthInfo["servers"]) {
 for (const server of servers) {
 const variable = this.#mcp.githubCredential(server.name); if (!variable) continue;
 const token = await authorizeGithub(this.#githubOptions(source, [server]));
 if (this.#disposed) return;
 if (!this.#mcp.setCredential(variable, token).ok) throw new Error("Cannot save GitHub authorization");
 }
 // Use the pinned SDK's official MCP command so tokens match its runtime store and refresh flow.
 for (const server of servers.filter(s => s.kind === "http" && s.url && this.#mcp.supportsBrowserAuth(s.name))) {
 const code = await authorizeMcpServer(server.name, {
 cwd: this.#agentDir, agentDir: this.#agentDir,
 openUrl: url => { if (!this.#disposed && new URL(url).protocol === "https:") { this.#states.set(stateKey(source), { source, kind: "oauth", status: "working", message: "请在浏览器中完成插件授权…", url, servers }); this.#open(url); } },
 log: () => {}, error: () => {},
 });
 if (code !== 0) throw new Error("MCP authorization failed");
 if (this.#disposed) return;
 }
 this.#states.set(stateKey(source), { source, kind: "oauth", status: "ready", message: "浏览器授权已完成，新任务可使用该插件。", servers });
 this.#checked.set(stateKey(source), Date.now());
 this.#done();
 }
 async #authorize(source: string, packagePath?: string) {
 let binary = this.#findBinary(packagePath);
 if (!binary) {
 this.#update(source, "正在安装飞书官方 CLI…");
 const prefix = join(homedir(), ".lark-cli");
 mkdirSync(prefix, { recursive: true });
 const manifestPath = join(prefix, "package.json");
 const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { private: true };
 const policy = manifest.allowScripts;
 manifest.allowScripts = { ...(Array.isArray(policy) ? Object.fromEntries(policy.map((name: string) => [name, true])) : policy && typeof policy === "object" ? policy : {}), "@larksuite/cli": true };
 writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
 await this.#run(source, "npm", ["install", "--prefix", prefix, "@larksuite/cli"], 120_000);
 binary = this.#findBinary(packagePath);
 if (!binary) throw new Error("CLI not installed");
 }
 const configDir = process.env.LARKSUITE_CLI_CONFIG_DIR ?? join(homedir(), ".lark-cli");
 const configPath = join(configDir, "config.json");
 let config: { apps?: Array<{ appId?: string; appSecret?: string; brand?: string }> } = {};
 try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch { /* new setup */ }
 if (!config.apps?.some(a => a.appId && a.appSecret)) {
 this.#update(source, "请在浏览器中创建或选择飞书应用…");
 await this.#run(source, binary, ["config", "init", "--new"], 300_000);
 config = JSON.parse(readFileSync(configPath, "utf8"));
 }
 // pi-lark requires its own settings as well as the CLI's app configuration.
 if (source.includes("@amaster.ai/pi-lark")) {
 const app = config.apps?.find(a => a.appId && a.appSecret);
 if (!app) throw new Error("No app configured");
 const result = this.#mcp.setCredential("PIH_LARK_APP_SECRET", app.appSecret!);
 if (!result.ok) throw new Error("Cannot store credential");
 const path = join(this.#agentDir, "settings.json");
 const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
 settings["pi-lark"] = { appId: app.appId, appSecret: "${PIH_LARK_APP_SECRET}", domain: app.brand === "lark" ? "lark" : "feishu" };
 writeFileSync(path, JSON.stringify(settings, null, "\t"), { mode: 0o600 }); chmodSync(path, 0o600);
 }
 if (await this.#loggedIn(source, binary)) {
 if (!this.#disposed) { this.#states.set(stateKey(source), this.#ready(source)); this.#done(); }
 return;
 }
 this.#update(source, "应用已配置，请在浏览器完成飞书用户授权…");
 await this.#run(source, binary, ["auth", "login", "--recommend"], 300_000);
 if (!await this.#loggedIn(source, binary)) throw new Error("User login not verified");
 if (!this.#disposed) { this.#states.set(stateKey(source), this.#ready(source)); this.#done(); }
 }
 #findBinary(packagePath?: string): string | undefined {
 const dirs = [ ...(packagePath ? [join(packagePath, "node_modules", ".bin"), join(dirname(packagePath), "..", ".bin"), join(dirname(packagePath), ".bin")] : []), join(homedir(), ".lark-cli", "node_modules", ".bin"), ...(process.env.PATH ?? "").split(":") ];
 const wrapper = dirs.map(d => join(d, "lark-cli")).find(path => existsSync(path));
 if (!wrapper) return undefined;
 // The official npm launcher requires node on PATH; Finder-launched apps may not have it.
 // Prefer the installed native CLI, which also owns the OS keychain credentials.
 const native = join(dirname(realpathSync(wrapper)), "..", "bin", process.platform === "win32" ? "lark-cli.exe" : "lark-cli");
 return existsSync(native) ? native : wrapper;
 }
 #update(source: string, message: string, url?: string) {
 if (this.#disposed) return;
 this.#states.set(stateKey(source), { source, kind: "lark", status: "working", message, servers: [], ...(url ? { url } : {}) });
 }
 #run(source: string, command: string, args: string[], timeout: number, openUrls = true): Promise<string> {
 if (this.#disposed) return Promise.reject(new Error("Disposed"));
 return new Promise((resolve, reject) => {
 const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
 if (command === "npm") for (const key of Object.keys(env)) if (/^npm_config_(allow_scripts|install_scripts)$/i.test(key)) delete env[key];
 const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
 this.#children.add(child);
 let hardKill: ReturnType<typeof setTimeout> | undefined;
 const timer = setTimeout(() => { child.kill("SIGTERM"); hardKill = setTimeout(() => child.kill("SIGKILL"), 2000); }, timeout);
 let tail = ""; const opened = new Set<string>();
 const consume = (chunk: Buffer) => {
 tail = (tail + chunk.toString()).replace(/\x1b\[[0-9;]*m/g, "").slice(-8192);
 for (const m of tail.matchAll(/https:\/\/[^\s"'<>]+(?=\s)/g)) {
 const url = m[0].replace(/[),.;]+$/, "");
 if (!openUrls || !allowedLarkAuthUrl(url) || opened.has(url)) continue;
 opened.add(url); this.#update(source, args[0] === "config" ? "请在浏览器中创建或选择飞书应用…" : "应用已配置，请在浏览器完成飞书用户授权…", url); this.#open(url);
 }
 };
 let output = "";
 child.stdout?.on("data", chunk => { output = (output + chunk.toString()).slice(-65536); consume(chunk); }); child.stderr?.on("data", consume);
 const cleanup = () => { clearTimeout(timer); clearTimeout(hardKill); this.#children.delete(child); };
 child.once("error", () => { cleanup(); reject(new Error("CLI startup failed")); });
 child.once("close", code => { cleanup(); code === 0 ? resolve(output) : reject(new Error("CLI authorization failed")); });
 });
 }
 dispose() { this.#disposed = true; this.#abort.abort(); for (const child of this.#children) child.kill("SIGTERM"); this.#children.clear(); }
}
