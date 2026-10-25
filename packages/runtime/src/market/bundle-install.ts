import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { sealInstall } from "./install-operations.js";

const PREFIX = ".pih-bundle-";
const active = new Set<string>();
const roots = new Set<string>();
export type InstallChange = { target: string; staged: string };
type Entry = { target: string; hadTarget: boolean };
type Journal = { committed: boolean; entries: Entry[] };

function allowed(target: string, agentName: string): boolean {
	return [ `${agentName}/npm`, `${agentName}/settings.json`, `${agentName}/mcp.json` ].includes(target)
		|| /^claude-pkg\/claude-[A-Za-z0-9_-]+$/.test(target);
}
function ordinary(path: string): void {
	try { if (lstatSync(path).isSymbolicLink()) throw new Error("安装事务路径不能是符号链接"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function releaseOwnedLock(root: string, dir: string, agentName: string): void {
	ordinary(join(root,agentName));
	const lock = join(root, agentName, "settings.json.lock"), owner = join(lock, "pih-owner");
	ordinary(lock); ordinary(owner);
	if (existsSync(owner) && readFileSync(owner, "utf8") === basename(dir)) rmSync(lock, { recursive: true, force: true });
}
function targetPath(root: string, target: string, agentName: string): string {
	if (!allowed(target, agentName)) throw new Error("安装事务目标无效，已保留现场");
	const path = join(root, target);
	ordinary(root);
	for (let parent = dirname(path); parent !== root; parent = dirname(parent)) ordinary(parent);
	ordinary(path);
	return path;
}
function save(dir: string, journal: Journal): void {
	const temporary = join(dir, "journal.tmp");
	writeFileSync(temporary, JSON.stringify(journal), { mode: 0o600 });
	renameSync(temporary, join(dir, "journal.json"));
}
function recover(root: string, dir: string, agentName: string): void {
	ordinary(dir); ordinary(join(dir, "journal.json"));
	if (!existsSync(join(dir, "journal.json"))) { releaseOwnedLock(root, dir, agentName); rmSync(dir, { recursive: true, force: true }); return; }
	const journal = JSON.parse(readFileSync(join(dir, "journal.json"), "utf8")) as Journal;
	if (typeof journal.committed !== "boolean" || !Array.isArray(journal.entries) || !journal.entries.length) throw new Error("安装事务记录无效，已保留现场");
	const names = new Set<string>();
	ordinary(join(dir,"old")); ordinary(join(dir,"new"));
	for (const entry of journal.entries) {
		if (typeof entry.hadTarget !== "boolean" || names.has(entry.target)) throw new Error("安装事务记录无效，已保留现场");
		targetPath(root, entry.target, agentName); names.add(entry.target);
	}
	if (!journal.committed) {
		for (let i = journal.entries.length - 1; i >= 0; i--) {
			const entry = journal.entries[i]!;
			const target = targetPath(root, entry.target, agentName), old = join(dir, "old", String(i)), next = join(dir, "new", String(i));
			ordinary(old); ordinary(next);
			if (existsSync(old)) { rmSync(target, { recursive: true, force: true }); renameSync(old, target); }
			else if (!entry.hadTarget && !existsSync(next)) rmSync(target, { recursive: true, force: true });
			else if (entry.hadTarget && !existsSync(target)) throw new Error("原安装文件缺失，已保留现场");
		}
	}
	releaseOwnedLock(root, dir, agentName);
	rmSync(dir, { recursive: true, force: true });
}
export function recoverBundleInstalls(root: string, agentName = "pi"): void {
	root = resolve(root);
	if (!existsSync(root)) return;
	ordinary(root);
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const dir = join(root, entry.name);
		if (entry.name.startsWith(PREFIX) && !active.has(dir)) recover(root, dir, agentName);
	}
}

/** Build asynchronously, then merge configs and publish without yielding between replacements. */
export async function installBundle(rootPath: string, agentName: string, build: (work: string) => Promise<() => InstallChange[]>, signal?: AbortSignal): Promise<void> {
	const root = resolve(rootPath);
	if (!/^[A-Za-z0-9_-]+$/.test(agentName)) throw new Error("非法安装目录名称");
	if (roots.has(root)) throw new Error("正在提交另一个安装，请稍后重试");
	signal?.throwIfAborted(); ordinary(root); mkdirSync(root, { recursive: true }); recoverBundleInstalls(root, agentName);
	const dir = mkdtempSync(join(root, PREFIX)); active.add(dir); roots.add(root);
	let lock: string | undefined;
	try {
		const finalize = await build(dir);
		signal?.throwIfAborted();
		// Compatible with Pi's proper-lockfile settings lock; never remove another writer's lock.
		const candidate = join(root, agentName, "settings.json.lock");
		ordinary(dirname(candidate)); mkdirSync(dirname(candidate), { recursive: true }); mkdirSync(candidate); lock = candidate;
		writeFileSync(join(candidate,"pih-owner"),basename(dir),{mode:0o600});
		const changes = finalize();
		if (!changes.length) throw new Error("安装没有可提交的资源");
		mkdirSync(join(dir, "new")); mkdirSync(join(dir, "old"));
		const entries: Entry[] = [], names = new Set<string>();
		for (const [index, change] of changes.entries()) {
			const target = targetPath(root, change.target, agentName);
			if (names.has(change.target)) throw new Error("安装目标重复"); names.add(change.target);
			if (!resolve(change.staged).startsWith(`${dir}${sep}`)) throw new Error("资源必须位于安装暂存目录");
			for(let parent=dirname(resolve(change.staged));parent!==dir;parent=dirname(parent))ordinary(parent);
			ordinary(change.staged);
			renameSync(change.staged, join(dir, "new", String(index)));
			entries.push({ target: change.target, hadTarget: existsSync(target) });
		}
		const journal: Journal = { committed: false, entries };
		save(dir, journal); sealInstall(signal);
		for (const [index, entry] of entries.entries()) {
			const target = targetPath(root, entry.target, agentName);
			mkdirSync(dirname(target), { recursive: true });
			if (entry.hadTarget) renameSync(target, join(dir, "old", String(index)));
			renameSync(join(dir, "new", String(index)), target);
		}
		journal.committed = true; save(dir, journal);
		releaseOwnedLock(root,dir,agentName); lock=undefined;
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* Committed cleanup resumes on startup. */ }
	} catch (error) {
		try { recover(root, dir, agentName); }
		catch { throw new Error("安装失败且自动恢复未完成，已保留目录和恢复记录，请重启后重试。"); }
		throw error;
	} finally {
		try { if (lock) releaseOwnedLock(root,dir,agentName); } catch { /* Recovery error retains the journal and lock for inspection. */ }
		active.delete(dir); roots.delete(root);
	}
}

/** Staging publication must not seal the parent request's cancellation boundary. */
export async function stageInstall<T>(signal: AbortSignal | undefined, build: (child?: AbortSignal) => Promise<T>): Promise<T> {
	if (!signal) return build();
	signal.throwIfAborted(); const child = new AbortController();
	const abort = () => child.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	try { return await build(child.signal); }
	finally { signal.removeEventListener("abort", abort); }
}
