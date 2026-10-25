/**
 * CheckpointService：文件级检查点（审批前备份 → 批准记录 → 一键回滚）。
 * 覆盖 edit/write（参数含明确 path）；bash 影响面不可知，不自动快照（诚实口径）。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CheckpointInfo } from "@pi-harness/contracts";
import { uuidv7 } from "@pi-harness/shared";
import type { HarnessDatabase } from "../db/database.js";
import type { Logger } from "../logging/logger.js";

interface CheckpointRow {
	id: string;
	task_id: string;
	seq: number;
	tool: string;
	args: string;
	files: string;
	created_at: number;
}

export class CheckpointService {
	#db: HarnessDatabase;
	#dataDir: string;
	#logger: Logger;

	constructor(db: HarnessDatabase, dataDir: string, logger: Logger) {
		this.#db = db;
		this.#dataDir = dataDir;
		this.#logger = logger;
	}

	/** 备份目标文件；返回备份清单。文件不存在时以 created 标记（新建文件，回滚时应删除）。 */
	backupFiles(taskId: string, paths: string[]): Array<{ path: string; backupPath: string; created?: boolean }> {
		const out: Array<{ path: string; backupPath: string; created?: boolean }> = [];
		const seq = this.#nextSeq(taskId);
		for (const p of paths) {
			if (!p) continue;
			if (!existsSync(p)) {
				out.push({ path: p, backupPath: "", created: true });
				continue;
			}
			const backupPath = join(this.#dataDir, "checkpoints", taskId, String(seq), `${uuidv7()}-${p.split("/").pop()}`);
			mkdirSync(join(backupPath, ".."), { recursive: true });
			copyFileSync(p, backupPath);
			out.push({ path: p, backupPath });
		}
		return out;
	}

	/** 批准后记录检查点（created 条目=新建文件，回滚时删除）。 */
	record(
		taskId: string,
		tool: string,
		args: unknown,
		files: Array<{ path: string; backupPath: string; created?: boolean }>,
	): CheckpointInfo {
		const id = uuidv7();
		const seq = this.#nextSeq(taskId);
		this.#db
			.prepare("INSERT INTO checkpoints (id, task_id, seq, tool, args, files, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(id, taskId, seq, tool, JSON.stringify(args ?? {}), JSON.stringify(files), Date.now());
		return this.get(id);
	}

	/** 拒绝后清理备份文件。 */
	discardBackups(files: Array<{ path: string; backupPath: string }>): void {
		for (const f of files) {
			try {
				if (existsSync(f.backupPath)) rmSync(f.backupPath);
			} catch (err) {
				this.#logger.warn("清理备份失败", {
					path: f.backupPath,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	list(taskId: string): CheckpointInfo[] {
		const rows = this.#db
			.prepare("SELECT * FROM checkpoints WHERE task_id = ? ORDER BY seq DESC")
			.all(taskId) as unknown as CheckpointRow[];
		return rows.map((r) => this.#toInfo(r));
	}

	/** 回滚：备份覆盖回原路径；新建文件删除；缺失备份如实记日志（不再静默成功）。 */
	restore(taskId: string, checkpointId: string): string[] {
		const row = this.#db.prepare("SELECT * FROM checkpoints WHERE id = ? AND task_id = ?").get(checkpointId, taskId) as
			| CheckpointRow
			| undefined;
		if (!row) throw new Error(`检查点不存在: ${checkpointId}`);
		const files = JSON.parse(row.files) as Array<{ path: string; backupPath: string; created?: boolean }>;
		const restored: string[] = [];
		const missing: string[] = [];
		for (const f of files) {
			if (f.created) {
				// 新建文件：回滚 = 删除
				try {
					if (existsSync(f.path)) rmSync(f.path);
					restored.push(`${f.path}（新建已删除）`);
				} catch (err) {
					this.#logger.warn("回滚删除新建文件失败", {
						path: f.path,
						message: err instanceof Error ? err.message : String(err),
					});
				}
				continue;
			}
			if (!f.backupPath || !existsSync(f.backupPath)) {
				missing.push(f.path);
				continue;
			}
			copyFileSync(f.backupPath, f.path);
			restored.push(f.path);
		}
		if (missing.length > 0) {
			this.#logger.warn("检查点回滚缺失备份（未恢复）", { taskId, checkpointId, missing });
		}
		this.#logger.info("检查点回滚", { taskId, checkpointId, restored: restored.length, missing: missing.length });
		return restored;
	}

	get(checkpointId: string): CheckpointInfo {
		const row = this.#db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as
			| CheckpointRow
			| undefined;
		if (!row) throw new Error(`检查点不存在: ${checkpointId}`);
		return this.#toInfo(row);
	}

	#nextSeq(taskId: string): number {
		const row = this.#db.prepare("SELECT MAX(seq) AS s FROM checkpoints WHERE task_id = ?").get(taskId) as {
			s: number | null;
		};
		return (row.s ?? 0) + 1;
	}

	#toInfo(row: CheckpointRow): CheckpointInfo {
		return {
			id: row.id,
			taskId: row.task_id,
			seq: row.seq,
			tool: row.tool,
			args: JSON.parse(row.args),
			files: JSON.parse(row.files),
			createdAt: row.created_at,
		};
	}
}
