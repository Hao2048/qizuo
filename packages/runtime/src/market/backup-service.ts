/** 一致数据库快照 + 文件校验；恢复先暂存，再替换，失败或中断时回退。 */
import {
	cpSync,
	symlinkSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	lstatSync,
	writeFileSync,
	readFileSync,
	readlinkSync,
	renameSync,
} from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import type { BackupInfo } from "@pi-harness/contracts";
import type { Logger } from "../logging/logger.js";

const EXCLUDE = new Set(["auth.json", "mcp-credentials.json"]);
const BACKUP_DIR_NAME = "backups";
const PENDING_RESTORE = "pending-restore.json";
const MANIFEST = "backup-manifest.json";
const STAGE = ".restore-stage";
const PREVIOUS = ".restore-previous";
const JOURNAL = ".restore-journal.json";
const JOURNAL_TMP = ".restore-journal.tmp";
const RESERVED = new Set([BACKUP_DIR_NAME, PENDING_RESTORE, STAGE, PREVIOUS, JOURNAL, JOURNAL_TMP]);
interface Manifest {
	version: 1;
	files: Record<string, string>;
	databaseSnapshot: boolean;
}
interface RestoreJournal {
	committed: boolean;
	originalNames: string[];
	restoreNames: string[];
}

/** Preserve link identity, including dangling top-level links (Node cpSync rejects those). */
function copyEntry(source: string, target: string, filter?: (path: string) => boolean): void {
  if (filter && !filter(source)) return;
  if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), target);
  else cpSync(source, target, { recursive: true, verbatimSymlinks: true, filter });
}

function fingerprints(root: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else {
				const rel = relative(root, path);
				if (rel === MANIFEST) continue;
				const bytes = entry.isSymbolicLink() ? Buffer.from(`symlink:${readlinkSync(path)}`) : readFileSync(path);
				files[rel] = createHash("sha256").update(bytes).digest("hex");
			}
		}
	};
	walk(root);
	return files;
}

function validate(root: string): void {
	if (!existsSync(join(root, "harness.db"))) throw new Error("备份缺少数据库");
	if (!existsSync(join(root, MANIFEST))) {
		// 兼容旧备份，至少验证 SQLite，避免无效备份替换当前数据。
		const db = new BetterSqlite3(join(root, "harness.db"), { readonly: true });
		try {
			if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("备份数据库损坏");
		} finally {
			db.close();
		}
		return;
	}
	const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as Manifest;
	if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== "object") throw new Error("备份清单无效");
	const actual = fingerprints(root);
	if (
		Object.keys(actual).length !== Object.keys(manifest.files).length ||
		Object.entries(manifest.files).some(([path, hash]) => actual[path] !== hash)
	)
		throw new Error("备份文件校验失败");
	if (manifest.databaseSnapshot) {
		const db = new BetterSqlite3(join(root, "harness.db"), { readonly: true });
		try {
			if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("备份数据库损坏");
		} finally {
			db.close();
		}
	}
}

function writeJournal(dataDir: string, journal: RestoreJournal): void {
	writeFileSync(join(dataDir, JOURNAL_TMP), JSON.stringify(journal), "utf8");
	renameSync(join(dataDir, JOURNAL_TMP), join(dataDir, JOURNAL));
}

/** journal 在文件替换前落盘，重启时可恢复中断的替换。 */
function recover(dataDir: string): void {
	const journalPath = join(dataDir, JOURNAL);
	if (!existsSync(journalPath)) return;
	const journal = JSON.parse(readFileSync(journalPath, "utf8")) as RestoreJournal;
	const validName = (name: string) =>
		typeof name === "string" && name === basename(name) && !RESERVED.has(name) && name !== "." && name !== "..";
	if (
		!Array.isArray(journal.originalNames) ||
		!Array.isArray(journal.restoreNames) ||
		![...journal.originalNames, ...journal.restoreNames].every(validName)
	)
		throw new Error("恢复日志无效");
	if (!journal.committed) {
		for (const name of journal.restoreNames) {
			if (!journal.originalNames.includes(name)) rmSync(join(dataDir, name), { recursive: true, force: true });
		}
		for (const name of journal.originalNames) {
			const old = join(dataDir, PREVIOUS, name);
			if (existsSync(old)) {
				rmSync(join(dataDir, name), { recursive: true, force: true });
				renameSync(old, join(dataDir, name));
			}
		}
	}
	rmSync(join(dataDir, STAGE), { recursive: true, force: true });
	rmSync(join(dataDir, PREVIOUS), { recursive: true, force: true });
	rmSync(journalPath, { force: true });
	if (journal.committed) rmSync(join(dataDir, PENDING_RESTORE), { force: true });
}

export class BackupService {
	#dataDir: string;
	#logger: Logger;
	#snapshotDatabase?: (path: string) => void;
	constructor(dataDir: string, logger: Logger, snapshotDatabase?: (path: string) => void) {
		this.#dataDir = dataDir;
		this.#logger = logger;
		this.#snapshotDatabase = snapshotDatabase;
	}
	get backupsDir(): string {
		return join(this.#dataDir, BACKUP_DIR_NAME);
	}
	create(): BackupInfo {
		const id = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
		const target = join(this.backupsDir, id);
		const staging = `${target}.partial`;
		mkdirSync(staging, { recursive: true });
		try {
			for (const entry of readdirSync(this.#dataDir, { withFileTypes: true })) {
				if (
					RESERVED.has(entry.name) ||
					entry.name === "logs" ||
					(entry.name.startsWith("harness.db") && this.#snapshotDatabase)
				)
					continue;
				copyEntry(join(this.#dataDir, entry.name), join(staging, entry.name), (path) => !EXCLUDE.has(basename(path)));
			}
			this.#snapshotDatabase?.(join(staging, "harness.db"));
			const manifest: Manifest = {
				version: 1,
				files: fingerprints(staging),
				databaseSnapshot: !!this.#snapshotDatabase,
			};
			writeFileSync(join(staging, MANIFEST), JSON.stringify(manifest), "utf8");
			validate(staging);
			renameSync(staging, target);
		} catch (err) {
			rmSync(staging, { recursive: true, force: true });
			throw err;
		}
		const info: BackupInfo = { id, createdAt: Date.now(), path: target, sizeBytes: this.#dirSize(target) };
		this.#logger.info("备份完成", { id, sizeBytes: info.sizeBytes });
		return info;
	}
	list(): BackupInfo[] {
		if (!existsSync(this.backupsDir)) return [];
		return readdirSync(this.backupsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && /^backup-[A-Za-z0-9_-]+$/.test(e.name))
			.map((e) => {
				const path = join(this.backupsDir, e.name);
				return { id: e.name, createdAt: Math.floor(statSync(path).mtimeMs), path, sizeBytes: this.#dirSize(path) };
			})
			.sort((a, b) => b.createdAt - a.createdAt);
	}
	requestRestore(id: string): { ok: boolean; message: string } {
		if (!/^backup-[A-Za-z0-9_-]+$/.test(id)) return { ok: false, message: "非法备份 ID" };
		const path = join(this.backupsDir, id);
		if (!existsSync(path) || !lstatSync(path).isDirectory()) return { ok: false, message: `备份不存在: ${id}` };
		try {
			validate(path);
		} catch (err) {
			return { ok: false, message: err instanceof Error ? err.message : String(err) };
		}
		writeFileSync(join(this.#dataDir, PENDING_RESTORE), JSON.stringify({ backupPath: path }), "utf8");
		return { ok: true, message: "已标记恢复，应用重启后生效（当前凭证不会被覆盖）" };
	}
	static executePendingRestore(dataDir: string): boolean {
		recover(dataDir);
		const marker = join(dataDir, PENDING_RESTORE);
		if (!existsSync(marker)) return false;
		const staging = join(dataDir, STAGE),
			previous = join(dataDir, PREVIOUS);
		try {
			const { backupPath } = JSON.parse(readFileSync(marker, "utf8")) as { backupPath: string };
			const id = typeof backupPath === "string" ? basename(backupPath) : "";
			if (
				!/^backup-[A-Za-z0-9_-]+$/.test(id) ||
				resolve(backupPath) !== resolve(dataDir, BACKUP_DIR_NAME, id) ||
				!lstatSync(backupPath).isDirectory()
			)
				throw new Error("非法恢复路径");
			validate(backupPath);
			rmSync(staging, { recursive: true, force: true });
			mkdirSync(staging, { recursive: true });
			for (const entry of readdirSync(backupPath)) {
				if (entry === MANIFEST || RESERVED.has(entry)) continue;
				copyEntry(join(backupPath, entry), join(staging, entry));
			}
			// 旧备份未包含检查点文件时保留现有文件，避免主动破坏可用的回滚记录。
			if (!existsSync(join(staging, "checkpoints")) && existsSync(join(dataDir, "checkpoints")))
				cpSync(join(dataDir, "checkpoints"), join(staging, "checkpoints"), { recursive: true });
			for (const name of EXCLUDE) {
				const current = join(dataDir, "pi", name),
					target = join(staging, "pi", name);
				rmSync(target, { force: true });
				if (existsSync(current)) {
					mkdirSync(join(staging, "pi"), { recursive: true });
					cpSync(current, target);
				}
			}
			const journal: RestoreJournal = {
				committed: false,
				originalNames: readdirSync(dataDir).filter((name) => !RESERVED.has(name)),
				restoreNames: readdirSync(staging),
			};
			mkdirSync(previous, { recursive: true });
			writeJournal(dataDir, journal);
			for (const name of journal.originalNames) renameSync(join(dataDir, name), join(previous, name));
			for (const name of journal.restoreNames) renameSync(join(staging, name), join(dataDir, name));
			journal.committed = true;
			writeJournal(dataDir, journal);
			recover(dataDir);
			return true;
		} catch {
			// 回退失败时保留 journal 并让启动失败，避免应用打开混合状态的数据。
			recover(dataDir);
			rmSync(staging, { recursive: true, force: true });
			rmSync(marker, { force: true });
			return false;
		}
	}
	#dirSize(dir: string): number {
		let total = 0;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			total += entry.isDirectory() ? this.#dirSize(path) : lstatSync(path).size;
		}
		return total;
	}
}
