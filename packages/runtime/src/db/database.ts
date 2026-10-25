/**
 * SQLite 数据库层：迁移内嵌为代码（避免运行时读 .sql 文件）。
 * WAL + 外键 + busy_timeout；单写者（主进程独占）符合需求的数据安全口径。
 */
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Migration {
	version: number;
	name: string;
	sql: string;
}

/**
 * v1：核心表骨架（M1-M4 在此之上追加迁移，不回改历史迁移）。
 * 设计对应开发方案 §5：
 * - roles                 角色卡六项
 * - memories / memory_versions   三层记忆 + 版本
 * - tasks / task_events   任务与状态机事件流
 * - task_graph_nodes      主管模式子任务图
 * - usage_ledger          token/成本真实回执账本
 * - projects              项目目录
 */
export const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "init-core-tables",
		sql: `
CREATE TABLE IF NOT EXISTS app_meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
	id         TEXT PRIMARY KEY,
	name       TEXT NOT NULL,
	dir        TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
	id               TEXT PRIMARY KEY,
	name             TEXT NOT NULL,
	intro            TEXT NOT NULL DEFAULT '',
	system_prompt    TEXT NOT NULL DEFAULT '',
	bound_skills     TEXT NOT NULL DEFAULT '[]',
	bound_plugins    TEXT NOT NULL DEFAULT '[]',
	preferred_model  TEXT,
	preferred_thinking TEXT,
	is_default       INTEGER NOT NULL DEFAULT 0,
	status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
	created_at       INTEGER NOT NULL,
	updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_status ON roles(status);

CREATE TABLE IF NOT EXISTS memories (
	id             TEXT PRIMARY KEY,
	scope_type     TEXT NOT NULL CHECK (scope_type IN ('user','role','project')),
	scope_id       TEXT NOT NULL CHECK (scope_id != ''),
	title          TEXT NOT NULL,
	content        TEXT NOT NULL,
	summary        TEXT NOT NULL DEFAULT '',
	tags           TEXT NOT NULL DEFAULT '[]',
	status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','forgotten')),
	source_task_id TEXT,
	created_at     INTEGER NOT NULL,
	updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope_type, scope_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_fts_stub ON memories(title);

CREATE TABLE IF NOT EXISTS memory_versions (
	memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
	ver        INTEGER NOT NULL,
	title      TEXT NOT NULL,
	content    TEXT NOT NULL,
	reason     TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (memory_id, ver)
);

CREATE TABLE IF NOT EXISTS tasks (
	id            TEXT PRIMARY KEY,
	project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
	title         TEXT NOT NULL,
	mode          TEXT NOT NULL DEFAULT 'single' CHECK (mode IN ('single','team','supervisor')),
	forced_model  TEXT,
	thinking      TEXT,
	status        TEXT NOT NULL DEFAULT 'draft'
		CHECK (status IN ('draft','running','waiting_approval','waiting_recommend','waiting_user','paused','done','error','cancelled')),
	role_snapshot TEXT NOT NULL DEFAULT '{}',
	created_at    INTEGER NOT NULL,
	updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

CREATE TABLE IF NOT EXISTS task_events (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	type       TEXT NOT NULL,
	payload    TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);

CREATE TABLE IF NOT EXISTS task_graph_nodes (
	id             TEXT PRIMARY KEY,
	task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	parent_id      TEXT,
	title          TEXT NOT NULL,
	assignee_role  TEXT,
	status         TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending','dispatched','running','review','rework','done','failed','skipped')),
	acceptance     TEXT NOT NULL DEFAULT '',
	result         TEXT,
	rework_count   INTEGER NOT NULL DEFAULT 0,
	created_at     INTEGER NOT NULL,
	updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_task ON task_graph_nodes(task_id, status);

CREATE TABLE IF NOT EXISTS usage_ledger (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	role_id       TEXT,
	provider      TEXT,
	model         TEXT,
	input_tokens  INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	cache_read    INTEGER,
	cache_write   INTEGER,
	cost_usd_micros INTEGER NOT NULL DEFAULT 0,
	created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_task ON usage_ledger(task_id, id);
`,
	},
	{
		version: 2,
		name: "m1-task-session-columns",
		sql: `
ALTER TABLE tasks ADD COLUMN pi_session_id TEXT;
ALTER TABLE tasks ADD COLUMN resolved_provider TEXT;
ALTER TABLE tasks ADD COLUMN resolved_model TEXT;
`,
	},
	{
		version: 3,
		name: "m2-roles-memory-checkpoints",
		sql: `
ALTER TABLE tasks ADD COLUMN role_id TEXT;
ALTER TABLE tasks ADD COLUMN system_prompt TEXT;

CREATE TABLE IF NOT EXISTS checkpoints (
	id         TEXT PRIMARY KEY,
	task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	seq        INTEGER NOT NULL,
	tool       TEXT NOT NULL,
	args       TEXT NOT NULL DEFAULT '{}',
	files      TEXT NOT NULL DEFAULT '[]',
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_task ON checkpoints(task_id, seq);
`,
	},
	{
		version: 4,
		name: "m3-multi-agent",
		sql: `
ALTER TABLE tasks ADD COLUMN members TEXT;
ALTER TABLE tasks ADD COLUMN max_rounds INTEGER;
`,
	},
	{
		version: 5,
		name: "m8-resource-visibility",
		sql: `
CREATE TABLE IF NOT EXISTS resource_visibility (
	name        TEXT PRIMARY KEY,
	kind        TEXT NOT NULL CHECK (kind IN ('skill', 'package')),
	visibility  TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
	source      TEXT,
	updated_at  INTEGER NOT NULL
);
`,
	},
	{
		version: 6,
		name: "task-plan",
		sql: `ALTER TABLE tasks ADD COLUMN plan TEXT;`,
	},
 { version:7, name:"conversation-context", sql:`
 CREATE TABLE conversation_references (
  id TEXT PRIMARY KEY, owner_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  payload TEXT NOT NULL, created_at INTEGER NOT NULL
 );
 CREATE TABLE tool_outputs (id TEXT PRIMARY KEY, size_chars INTEGER NOT NULL, created_at INTEGER NOT NULL);
 CREATE TABLE task_tool_outputs (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  output_id TEXT NOT NULL REFERENCES tool_outputs(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id,output_id)
 );
 ` },

 {version:8,name:"role-workbench-v2",sql:`
 ALTER TABLE tasks ADD COLUMN workbench_owner TEXT;
 ALTER TABLE tasks ADD COLUMN execution_root TEXT;
 CREATE TABLE workbenches (id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
 CREATE TABLE workbench_runs (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, workbench_id TEXT NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE, role_id TEXT NOT NULL, root TEXT NOT NULL, baseline TEXT NOT NULL, owned_paths TEXT NOT NULL, request_id TEXT NOT NULL, contract_versions TEXT NOT NULL);
 CREATE TABLE workbench_applications(id TEXT PRIMARY KEY, workbench_id TEXT NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE, role_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
 CREATE INDEX idx_workbench_runs_owner ON workbench_runs(workbench_id,role_id);
 `},
 {version:9,name:"workbench-history-order",sql:`
 CREATE INDEX idx_workbenches_history ON workbenches(updated_at DESC,id DESC);
 `},
 {version:10,name:"workbench-attachments",sql:`
 CREATE TABLE workbench_attachments (
 id TEXT PRIMARY KEY, workbench_id TEXT NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE,
 name TEXT NOT NULL, kind TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL,
 data BLOB NOT NULL, request_id TEXT, created_at INTEGER NOT NULL
 );
 CREATE INDEX idx_workbench_attachments_owner ON workbench_attachments(workbench_id,request_id);
 `},
 {version:11,name:"role-memory-quality",sql:`
 ALTER TABLE memories ADD COLUMN quality TEXT NOT NULL DEFAULT '{}';
 ALTER TABLE memory_versions ADD COLUMN quality TEXT NOT NULL DEFAULT '{}';
 `},
 {version:12,name:"composer-drafts",sql:`
 CREATE TABLE composer_drafts (
 key TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
 workbench_id TEXT REFERENCES workbenches(id) ON DELETE CASCADE,
 body TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 CHECK(NOT(task_id IS NOT NULL AND workbench_id IS NOT NULL))
 );
 CREATE TABLE composer_draft_files (
 draft_key TEXT NOT NULL REFERENCES composer_drafts(key) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(draft_key,ordinal)
 );
 `},
 {version:13,name:"draft-storage-accounting",sql:`
 ALTER TABLE composer_drafts ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE composer_draft_files ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
 UPDATE composer_drafts SET bytes=length(CAST(body AS BLOB));
 UPDATE composer_draft_files SET bytes=length(CAST(body AS BLOB));
 `},
 {version:14,name:"workbench-model-usage",sql:`
 CREATE TABLE workbench_model_calls (
 id TEXT PRIMARY KEY,
 workbench_id TEXT NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, role_id TEXT NOT NULL, role_name TEXT NOT NULL,
 stage TEXT NOT NULL CHECK(stage IN ('routing','planning')),
 provider TEXT NOT NULL, model TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
 started_at INTEGER NOT NULL, duration_ms INTEGER,
 input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER,
 cost_usd_micros INTEGER
 );
 CREATE INDEX idx_workbench_model_calls ON workbench_model_calls(workbench_id,role_id,stage);
 ALTER TABLE usage_ledger ADD COLUMN cost_reported INTEGER;
 `},
 {version:15,name:"workbench-call-timing",sql:`
 ALTER TABLE workbench_model_calls ADD COLUMN first_response_ms INTEGER;
 ALTER TABLE workbench_model_calls ADD COLUMN first_text_ms INTEGER;
 CREATE TABLE workbench_execution_calls (
 id TEXT PRIMARY KEY, workbench_id TEXT NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 usage_id INTEGER UNIQUE REFERENCES usage_ledger(id) ON DELETE SET NULL,
 request_id TEXT NOT NULL, role_id TEXT NOT NULL, role_name TEXT NOT NULL,
 stage TEXT NOT NULL DEFAULT 'execution' CHECK(stage='execution'),
 provider TEXT NOT NULL, model TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
 started_at INTEGER NOT NULL, duration_ms INTEGER,first_response_ms INTEGER,first_text_ms INTEGER,
 input_tokens INTEGER,output_tokens INTEGER,cache_read INTEGER,cache_write INTEGER,cost_usd_micros INTEGER
 );
 CREATE INDEX idx_workbench_execution_calls ON workbench_execution_calls(workbench_id,request_id,started_at,id);
 CREATE INDEX idx_workbench_execution_task ON workbench_execution_calls(task_id);
 CREATE INDEX idx_workbench_raw_round ON workbench_model_calls(workbench_id,request_id,started_at,id);
 `},
 {version:16,name:"role-memory-citations",sql:`
 CREATE TABLE memory_citations (
 memory_id TEXT NOT NULL, version INTEGER NOT NULL,
 owner_key TEXT NOT NULL, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
 workbench_id TEXT REFERENCES workbenches(id) ON DELETE CASCADE,
 stage TEXT NOT NULL CHECK(stage IN ('routing','planning','execution')),
 first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,
 FOREIGN KEY(memory_id,version) REFERENCES memory_versions(memory_id,ver) ON DELETE CASCADE,
 PRIMARY KEY(memory_id,version,owner_key,stage),
 CHECK((task_id IS NOT NULL AND workbench_id IS NULL AND stage='execution') OR
       (task_id IS NULL AND workbench_id IS NOT NULL AND stage IN ('routing','planning')))
 );
 CREATE INDEX idx_memory_citations_task ON memory_citations(task_id);
 CREATE INDEX idx_memory_citations_workbench ON memory_citations(workbench_id);
 INSERT OR IGNORE INTO app_meta(key,value) VALUES('memory_observed_since',CAST(unixepoch('now')*1000 AS TEXT));
 `},

 {version:17,name:"workbench-host-execution",sql:`
 CREATE TABLE workbench_plans (
 workbench_id TEXT NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL,body TEXT NOT NULL,ready INTEGER NOT NULL CHECK(ready IN(0,1)),created_at INTEGER NOT NULL,
 PRIMARY KEY(workbench_id,request_id));
 CREATE TABLE workbench_run_receipts (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 workbench_id TEXT NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE,body TEXT NOT NULL);
 CREATE INDEX idx_workbench_plans_latest ON workbench_plans(workbench_id,ready,created_at DESC,request_id DESC);
 CREATE INDEX idx_workbench_run_receipts_owner ON workbench_run_receipts(workbench_id);
 `},
 {version:18,name:"role-time-memories",sql:`
 CREATE TABLE role_time_memories(id TEXT PRIMARY KEY,role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,body TEXT NOT NULL,enabled INTEGER NOT NULL,next_run INTEGER,status TEXT NOT NULL,active_task_id TEXT,last_task_id TEXT,last_at INTEGER,last_error TEXT NOT NULL DEFAULT '',dedupe_key TEXT UNIQUE,created_at INTEGER NOT NULL);
 CREATE INDEX idx_time_memories_due ON role_time_memories(enabled,next_run);
 CREATE TABLE time_memory_runs(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES role_time_memories(id) ON DELETE CASCADE,task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,due_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
 `},
];

export class HarnessDatabase {
 transaction<T>(work: () => T): T { return this.#db.transaction(work)(); }
	readonly path: string;
	#db: BetterSqlite3.Database;
	#version: number;

	private constructor(db: BetterSqlite3.Database, path: string, version: number) {
		this.#db = db;
		this.path = path;
		this.#version = version;
	}

	static open(path: string): HarnessDatabase {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		const db = new BetterSqlite3(path);
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		db.pragma("busy_timeout = 5000");
		const version = HarnessDatabase.#migrate(db);
		return new HarnessDatabase(db, path, version);
	}

	static memory(): HarnessDatabase {
		return HarnessDatabase.open(":memory:");
	}

	static #migrate(db: BetterSqlite3.Database): number {
		db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER PRIMARY KEY,
			name       TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		)`);
		const applied = new Set(
			(db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
		);
		let latest = 0;
		for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
			if (applied.has(m.version)) {
				latest = Math.max(latest, m.version);
				continue;
			}
			db.transaction(() => {
				db.exec(m.sql);
				db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
					m.version,
					m.name,
					Date.now(),
				);
			})();
			latest = m.version;
		}
		return latest;
	}

	get version(): number {
		return this.#version;
	}

	tableNames(): string[] {
		const rows = this.#db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
			name: string;
		}[];
		return rows.map((r) => r.name);
	}

	pragma(statement: string): unknown {
		return this.#db.pragma(statement);
	}

	prepare(sql: string): BetterSqlite3.Statement {
		return this.#db.prepare(sql);
	}

	exec(sql: string): void {
		this.#db.exec(sql);
	}

	getMeta(key: string): string | null {
		const row = this.#db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined;
		return row?.value ?? null;
	}

	setMeta(key: string, value: string): void {
		this.#db
			.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
			.run(key, value);
	}

	/** SQLite 自身创建一致快照，避免直接复制 WAL 活库。 */
	snapshot(path: string): void {
		this.#db.prepare("VACUUM INTO ?").run(path);
	}

	close(): void {
		this.#db.close();
	}
}
