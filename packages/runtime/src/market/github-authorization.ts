import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type GithubAuthOptions = {
 agentDir: string; signal: AbortSignal;
 progress(message: string): void;
 authorize(url: string, verificationCode?: string): void;
 configuredToken?: string;
 validate?(token: string): Promise<"ready" | "required" | "unavailable">;
};
// Delegate OAuth to GitHub's own registered CLI application; never borrow its client ID.
const VERSION = "2.76.2";
export function allowedGithubAuthUrl(value: string): boolean {
 try { const u = new URL(value); return u.origin === "https://github.com" && !u.username && !u.password && ["/login/device", "/login/oauth/authorize"].includes(u.pathname); } catch { return false; }
}
function run(binary: string, args: string[], options: GithubAuthOptions, env: NodeJS.ProcessEnv, login = false): Promise<string> {
 options.signal.throwIfAborted();
 return new Promise((resolve, reject) => {
 const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
 let stdout = "", tail = "", code: string | undefined; const opened = new Set<string>();
 let hardKill: ReturnType<typeof setTimeout> | undefined;
 const abort = () => { child.kill("SIGTERM"); hardKill = setTimeout(() => child.kill("SIGKILL"), 2000); };
 options.signal.addEventListener("abort", abort, { once: true });
 const timer = setTimeout(abort, login ? 900_000 : 30_000);
 const consume = (chunk: Buffer) => {
 if (!login) return;
 tail = (tail + chunk.toString()).replace(/\x1b\[[0-9;]*m/g, "").slice(-8192);
 code = tail.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1] ?? code;
 for (const match of tail.matchAll(/https:\/\/[^\s"'<>]+(?=\s)/g)) {
 const url = match[0].replace(/[),.;]+$/, "");
 if (!allowedGithubAuthUrl(url) || opened.has(url)) continue;
 opened.add(url); options.authorize(url, code);
 }
 };
 child.stdout?.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-65536); consume(chunk); });
 child.stderr?.on("data", consume);
 const cleanup = () => { clearTimeout(timer); clearTimeout(hardKill); options.signal.removeEventListener("abort", abort); };
 child.once("error", () => { cleanup(); reject(new Error("GitHub CLI could not start")); });
 child.once("close", exit => { cleanup(); exit === 0 && !options.signal.aborted ? resolve(stdout) : reject(new Error("GitHub authorization did not complete")); });
 });
}
async function getCli(options: GithubAuthOptions, env: NodeJS.ProcessEnv, install = true): Promise<string | undefined> {
 const installed = [...(process.env.PATH ?? "").split(":"), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", join(options.agentDir, "bin")].map(dir => join(dir, "gh")).find(existsSync);
 if (installed) return installed;
 if (!install) return undefined;
 if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("GitHub CLI unavailable");
 options.progress("正在下载 GitHub 官方认证组件…");
 const arch = process.arch === "arm64" ? "arm64" : "amd64";
 const filename = `gh_${VERSION}_macOS_${arch}.zip`;
 const base = `https://github.com/cli/cli/releases/download/v${VERSION}`;
 const signal = AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]);
 const [archive, sums] = await Promise.all([fetch(`${base}/${filename}`, { signal }), fetch(`${base}/gh_${VERSION}_checksums.txt`, { signal })]);
 if (!archive.ok || !sums.ok) throw new Error("GitHub CLI download failed");
 const bytes = Buffer.from(await archive.arrayBuffer());
 const expected = (await sums.text()).split("\n").find(line => line.trim().split(/\s+/).at(-1) === filename)?.trim().split(/\s+/)[0];
 if (!expected || createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("GitHub CLI checksum failed");
 const staging = mkdtempSync(join(tmpdir(), "pih-github-cli-"));
 try {
 writeFileSync(join(staging, "cli.zip"), bytes);
 await run("/usr/bin/unzip", ["-q", join(staging, "cli.zip"), "-d", staging], options, env);
 const binary = join(staging, `gh_${VERSION}_macOS_${arch}`, "bin", "gh");
 if (!existsSync(binary)) throw new Error("GitHub CLI binary missing");
 const binDir = join(options.agentDir, "bin"); mkdirSync(binDir, { recursive: true });
 // Staging may be on another filesystem. Copy bytes rather than moving across devices.
 const { readFileSync } = await import("node:fs");
 const target = join(binDir, "gh"); const temporary = `${target}.installing`;
 writeFileSync(temporary, readFileSync(binary), { mode: 0o755 }); chmodSync(temporary, 0o755); renameSync(temporary, target);
 return target;
 } finally { rmSync(staging, { recursive: true, force: true }); }
}
function cliEnv(configDir?: string): NodeJS.ProcessEnv {
 const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
 for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_DEBUG", "DEBUG", "GH_HTTP_UNIX_SOCKET", "GH_FORCE_TTY", "GH_BROWSER", "BROWSER"]) delete env[key];
 if (configDir) env.GH_CONFIG_DIR = configDir;
 return env;
}
export type GithubReuse = { status: "ready" | "required" | "unavailable"; token?: string; account?: string };
export class GithubAccessError extends Error {
 constructor(readonly status: "required" | "unavailable") { super("GitHub access validation failed"); }
}
async function verify(token: string, options: GithubAuthOptions): Promise<GithubReuse> {
 if (!token || token.length > 4096 || /\s/.test(token)) return { status: "required" };
 try {
 const result = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) });
 if (!result.ok) return { status: result.status === 401 || (result.status === 403 && result.headers.get("x-ratelimit-remaining") !== "0") ? "required" : "unavailable" };
 const user = await result.json() as { login?: string };
 if (!user.login) return { status: "required" };
 const access = await options.validate?.(token) ?? "ready";
 return access === "ready" ? { status: "ready", token, account: user.login } : { status: access };
 } catch { return { status: "unavailable" }; }
}
/** Read only the official CLI's active github.com account; never scan another application's secret files. */
export async function reuseGithub(options: GithubAuthOptions): Promise<GithubReuse> {
 options.signal.throwIfAborted();
 if (options.configuredToken) {
 const result = await verify(options.configuredToken, options);
 if (result.status !== "required") return result;
 }
 const binary = await getCli(options, cliEnv(), false); if (!binary) return { status: "required" };
 const own = join(options.agentDir, "github-auth");
 for (const dir of [ ...(existsSync(own) ? [own] : []), undefined ]) {
 try {
 const token = (await run(binary, ["auth", "token", "--hostname", "github.com"], options, cliEnv(dir))).trim();
 const result = await verify(token, options);
 if (result.status !== "required") return result;
 } catch { options.signal.throwIfAborted(); }
 }
 return { status: "required" };
}
/** Reuse first; only missing/invalid permissions start a fresh browser flow. Tokens never enter UI. */
export async function authorizeGithub(options: GithubAuthOptions): Promise<string> {
 const previous = await reuseGithub(options);
 if (previous.status === "ready") return previous.token!;
 if (previous.status === "unavailable") throw new GithubAccessError("unavailable");
 const configDir = join(options.agentDir, "github-auth"); mkdirSync(configDir, { recursive: true, mode: 0o700 }); chmodSync(configDir, 0o700);
 const env = cliEnv(configDir);
 const binary = await getCli(options, env); if (!binary) throw new GithubAccessError("unavailable");
 await run(binary, ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https", "--skip-ssh-key"], options, env, true);
 const token = (await run(binary, ["auth", "token", "--hostname", "github.com"], options, env)).trim();
 const access = await verify(token, options);
 if (access.status !== "ready") throw new GithubAccessError(access.status);
 const config = join(configDir, "hosts.yml"); if (existsSync(config)) chmodSync(config, 0o600);
 return token;
}
