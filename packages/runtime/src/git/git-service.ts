import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GitStatus, GitAction, GitDiff } from "@pi-harness/contracts";

export type AgentGitInput = { action: "status"|"diff"|"log"|"init"|"commit"|"create_branch"|"switch_branch"; paths?:string[]; message?:string; branch?:string };
const MAX_OUTPUT = 8 * 1024 * 1024;
export class GitService {
 #binary: string | null | undefined;
 #queues = new Map<string, Promise<unknown>>();
 #baselines = new Map<string, { root: string; dirty: Set<string> }>();
 constructor(binary?: string | null) { this.#binary = binary; }
 async #find(): Promise<string | null> {
 if (this.#binary !== undefined) return this.#binary;
 const candidates = [...new Set([...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin"), "/usr/bin"])].map(dir => join(dir, "git"));
 for (const binary of candidates) {
 if (!existsSync(binary)) continue;
 try {
 // Apple's shim can open an installer; only use it when developer tools are installed.
 if (process.platform === "darwin" && binary === "/usr/bin/git") await this.#exec("/usr/bin/xcode-select", ["-p"]);
 await this.#exec(binary, ["--version"]); this.#binary=binary; return binary;
 } catch { /* try another installation */ }
 }
 return null;
 }
 #exec(binary: string, args: string[], cwd?: string, extraEnv?: NodeJS.ProcessEnv): Promise<string> {
 const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" };
 for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|TRACE.*|EXTERNAL_DIFF)$/.test(key) && !(key in (extraEnv ?? {}))) delete env[key];
 return new Promise((res, rej) => execFile(binary, args, { cwd, env, encoding: "utf8", timeout: 30_000, maxBuffer: MAX_OUTPUT }, (error, stdout, stderr) => {
 if (error) rej(new Error(stderr.trim().slice(0, 1500) || "Git 操作失败，请检查项目和本机 Git 配置。")); else res(stdout);
 }));
 }
 async #run(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
 const binary = await this.#find(); if (!binary) throw new Error("未找到可用的本机 Git，请安装 Git 后重试。");
 return this.#exec(binary, ["--literal-pathspecs", "-c", "core.quotepath=false", "-c", "diff.external=", ...args], cwd, env);
 }
 async status(cwd: string | null): Promise<GitStatus> {
 const binary = await this.#find();
 const empty: GitStatus = { available: !!binary, repository: false, root: null, branch: null, head: null, files: [], branches: [], commits: [] };
 if (!cwd) return { ...empty, message: "选择项目对话后可使用 Git 版本管理。" };
 if (!binary) return { ...empty, message: "未找到可用的本机 Git。安装 Git 后即可启用项目版本管理。" };
 let root: string;
 try { root = (await this.#run(cwd, ["rev-parse", "--show-toplevel"])).trim(); }
 catch (error) { return { ...empty, message: /not a git repository/i.test(String(error)) ? "项目尚未使用 Git，可初始化版本管理。" : `无法读取项目 Git：${error instanceof Error ? error.message : "请检查项目目录和 Git 配置。"}` }; }
 const scope = relative(root, realpathSync(cwd));
 const raw = await this.#run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", scope || "."]);
 const files = raw.split("\0").filter(Boolean).map(line => ({ path: line.slice(3), status: line.slice(0, 2), staged: line[0] !== " " && line[0] !== "?", tracked: !line.startsWith("??"), conflicted: /U|AA|DD/.test(line.slice(0,2)) }));
 let branch: string | null = null; let head: string | null = null;
 try { branch = (await this.#run(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim(); } catch { /* detached HEAD */ }
 try { head = (await this.#run(root, ["rev-parse", "--verify", "HEAD"])).trim(); } catch { /* unborn */ }
 const branches = (await this.#run(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).trim().split("\n").filter(Boolean);
 const commits = head ? (await this.#run(root, ["log", "-20", "--format=%H%x00%s%x00%ct"])).trim().split("\n").filter(Boolean).map(line => { const [id, message, timestamp] = line.split("\0"); return { id: id!, message: message!, timestamp: Number(timestamp) * 1000 }; }) : [];
 return { available: true, repository: true, root, branch, head, files, branches, commits };
 }
 /** 发送前只读取工作区基线；分支列表与提交历史留给版本面板。 */
 async begin(taskId: string, cwd: string | null): Promise<{available:boolean; root:string|null}> {
 this.release(taskId);
 const binary = await this.#find();
 if (!binary || !cwd) return {available:!!binary,root:null};
 try {
 const root = (await this.#run(cwd,["rev-parse","--show-toplevel"])).trim();
 const scope = relative(root,realpathSync(cwd)) || ".";
 const raw = await this.#run(root,["status","--porcelain=v1","-z","--untracked-files=all","--no-renames","--",scope]);
 this.#baselines.set(taskId,{root,dirty:new Set(raw.split("\0").filter(Boolean).map(line=>line.slice(3)))});
 return {available:true,root};
 } catch { return {available:true,root:null}; }
 }
 release(taskId: string): void { this.#baselines.delete(taskId); }
 async #repo(cwd: string): Promise<GitStatus & { root: string }> {
 const state = await this.status(cwd); if (!state.root) throw new Error(state.message ?? "项目尚未使用 Git。");
 return state as GitStatus & { root: string };
 }
 #path(root: string, cwd: string, path: string): string {
 if (!path || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).some(p => p === ".." || p.toLowerCase() === ".git")) throw new Error("文件路径必须位于当前项目内。");
 const abs = resolve(root, path), project = realpathSync(cwd);
 const rel = relative(project, abs);
 if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("文件路径超出当前项目。");
 let current = abs;
 while (current !== root && current !== dirname(current)) {
 try { if (lstatSync(current).isSymbolicLink()) throw new Error("请在项目中直接处理符号链接，Git 面板不修改链接路径。"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
 current = dirname(current);
 }
 return path;
 }
 async #version(state: GitStatus & { root: string }, cwd: string, paths: string[]): Promise<string> {
 const hash = createHash("sha256").update(state.root).update(state.head ?? "").update(state.branch ?? "");
 for (const path of [...paths].sort()) {
 this.#path(state.root, cwd, path); hash.update(path).update(state.files.find(f => f.path === path)?.status ?? "clean");
 hash.update(await this.#run(state.root, ["ls-files", "--stage", "--", path]));
 const abs = join(state.root, path);
 if (existsSync(abs)) { if (!lstatSync(abs).isFile()) throw new Error("请选择普通文件。"); hash.update(await this.#run(state.root, ["hash-object", "--no-filters", "--", path])); } else hash.update("missing");
 }
 return hash.digest("hex");
 }
 async diff(cwd: string, paths: string[], scope: "working" | "staged" | "all" = "all", commit?: string): Promise<GitDiff> {
 const state = await this.#repo(cwd);
 if (paths.length > 200) throw new Error("一次最多查看 200 个文件，请缩小选择范围。");
 for (const p of paths) this.#path(state.root, cwd, p);
 let text = "";
 if (commit) {
 if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("提交编号无效。");
 const folder = relative(state.root, realpathSync(cwd)) || ".";
 text = await this.#run(state.root, ["show", "--format=fuller", "--no-ext-diff", "--no-textconv", commit, "--", ...(paths.length ? paths : [folder])]);
 } else if (paths.length) {
 const args = ["diff", "--no-ext-diff", "--no-textconv", ...(scope === "staged" ? ["--cached"] : scope === "all" && state.head ? ["HEAD"] : []), "--", ...paths];
 if (!state.head && scope === "all") {
 text = await this.#run(state.root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", ...paths]);
 text += await this.#run(state.root, ["diff", "--no-ext-diff", "--no-textconv", "--", ...paths]);
 } else text = await this.#run(state.root, args);
 if (scope !== "staged") for (const p of paths.filter(p => state.files.some(f => f.path === p && !f.tracked))) {
 const abs = join(state.root,p), size = lstatSync(abs).size;
 if (size > 1024 * 1024) { text += `\n新文件 ${p}（超过 1 MB，请在编辑器中查看）\n`; continue; }
 const bytes = readFileSync(abs);
 text += bytes.includes(0) ? `\n新二进制文件 ${p}\n` : `\ndiff --git a/${p} b/${p}\n--- /dev/null\n+++ b/${p}\n${bytes.toString("utf8").split("\n").map(line => `+${line}`).join("\n")}\n`;
 }
 }
 return { text: text.slice(0, 200_000), truncated: text.length > 200_000, version: await this.#version(state,cwd,paths) };
 }
 async mutate(taskId: string, cwd: string, input: GitAction, agent = false): Promise<GitStatus> {
 const lock = realpathSync(cwd);
 const state = await this.status(cwd);
 const key = state.root ?? lock;
 const previous = this.#queues.get(key) ?? Promise.resolve();
 const operation = previous.catch(() => {}).then(() => this.#mutate(taskId,cwd,input,agent));
 this.#queues.set(key,operation);
 try { return await operation; } finally { if(this.#queues.get(key) === operation) this.#queues.delete(key); }
 }
 async #mutate(taskId: string, cwd: string, input: GitAction, agent: boolean): Promise<GitStatus> {
 if (input.action === "init") {
 const before = await this.status(cwd);
 if (!before.available) throw new Error(before.message);
 if (!before.repository) await this.#run(cwd,["init"]);
 const state = await this.status(cwd);
 if (agent && state.root) {
 // Existing files in a new repository belong to the user, so never auto-commit them.
 this.#baselines.set(taskId,{root:state.root,dirty:new Set(state.files.map(f=>f.path))});
 }
 return state;
 }
 const state = await this.#repo(cwd);
 if (state.files.some(f=>f.conflicted)) throw new Error("项目存在合并冲突，请先解决冲突。");
 if (input.action === "create_branch" || input.action === "switch_branch") {
 if (!state.head) throw new Error("请先创建首次提交，再创建或切换分支。");
 const branch = input.branch?.trim();
 if (!branch || branch.startsWith("-")) throw new Error("请输入有效的分支名称。");
 await this.#run(state.root,["check-ref-format","--branch",branch]);
 if(input.action === "switch_branch") {
 if ((await this.#run(state.root,["status","--porcelain=v1","--untracked-files=all"])).trim()) throw new Error("切换分支前请先提交或撤销当前修改。");
 if(!state.branches.includes(branch)) throw new Error("目标本地分支不存在。");
 }
 await this.#run(state.root,["switch",...(input.action === "create_branch" ? ["-c"] : []),branch]);
 return this.status(cwd);
 }
 const paths = [...new Set(input.paths ?? [])];
 if(!paths.length || paths.length > 200) throw new Error("请选择 1–200 个具体文件。");
 for(const path of paths) {
 this.#path(state.root,cwd,path);
 if(!state.files.some(f=>f.path === path)) throw new Error(`文件已无待处理修改：${path}`);
 }
 if (agent) {
 if (input.action !== "commit") throw new Error("自动 Git 工具仅可创建版本与分支，撤销修改请由用户在面板操作。");
 const baseline = this.#baselines.get(taskId);
 if(!baseline || baseline.root !== state.root) throw new Error("缺少本轮 Git 基线，请先开始新的任务轮次。");
 if(paths.some(path=>baseline.dirty.has(path))) throw new Error("选中文件包含本轮开始前已有的修改，已保留，不能自动提交。");
 if(paths.some(path=>/(^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519)$|\.(?:pem|key)$/i.test(path))) throw new Error("自动提交不包含凭据或密钥文件，请由用户检查后处理。");
 }
 if(!input.version || input.version !== await this.#version(state,cwd,paths)) throw new Error("文件或分支已变化，请刷新差异后再操作。");
 if(input.action === "stage") await this.#run(state.root,["add","--",...paths]);
 else if(input.action === "unstage") await this.#run(state.root,state.head ? ["reset","-q","HEAD","--",...paths] : ["rm","--cached","--force","--",...paths]);
 else if(input.action === "discard") {
 const tracked = paths.filter(p=>state.files.find(f=>f.path===p)!.tracked), fresh=paths.filter(p=>!tracked.includes(p));
 if(tracked.length) {
 if(!state.head) throw new Error("首次提交前的暂存文件请先取消暂存，再撤销新文件。");
 await this.#run(state.root,["restore","--source=HEAD","--staged","--worktree","--",...tracked]);
 }
 for(const p of fresh) rmSync(join(state.root,p));
 } else if(input.action === "commit") {
 const message = input.message?.trim(); if(!message || message.length>1000) throw new Error("请输入 1–1000 字符的提交说明。");
 // A temporary index commits only the selected files and leaves unrelated staged changes intact.
 const temp = mkdtempSync(join(tmpdir(),"pih-git-index-")); const env={GIT_INDEX_FILE:join(temp,"index")};
 try {
 await this.#run(state.root,state.head ? ["read-tree","HEAD"] : ["read-tree","--empty"],env);
 await this.#run(state.root,["add","--",...paths],env);
 const latest=await this.#repo(cwd);
 if(input.version !== await this.#version(latest,cwd,paths)) throw new Error("文件或分支已变化，请刷新差异后再操作。");
 await this.#run(state.root,["commit","-m",message],env);
 await this.#run(state.root,["reset","-q","HEAD","--",...paths]);
 } finally { rmSync(temp,{recursive:true,force:true}); }
 } else throw new Error("不支持的 Git 操作。");
 return this.status(cwd);
 }
}
