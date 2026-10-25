/** Role-owned memory. Unreviewed candidates never enter model context. */
import type {
  MemoryInfo,
  MemoryVersionInfo,
  MemoryQuality,
} from "@pi-harness/contracts";
import { uuidv7 } from "@pi-harness/shared";
import type { HarnessDatabase } from "../db/database.js";
import { MemoryUsage } from "./usage.js";
import { readQuality, relatedTopic } from "./quality.js";
interface MemoryRow {
  id: string;
  scope_type: string;
  scope_id: string;
  title: string;
  content: string;
  summary: string;
  tags: string;
  status: string;
  source_task_id: string | null;
  created_at: number;
  updated_at: number;
  quality: string;
}
export interface MemoryScope {
  scopeType: "user" | "role" | "project";
  scopeId: string;
}
export interface MemoryDetails {
  category?: MemoryQuality["category"];
  appliesTo?: string;
  projectId?: string | null;
}
interface MemoryWrite extends MemoryScope, MemoryDetails {
  title: string;
  content: string;
  summary?: string;
  tags?: string[];
  sourceTaskId?: string | null;
  sourceNote?: string;
  /** Host only: not exposed by memory:write. Model claims must use propose(). */
  quality?: Partial<MemoryQuality>;
}
export class MemoryService {
  readonly usage: MemoryUsage;
  #db: HarnessDatabase;
  #labelResolver: (scope: MemoryScope) => string;
  constructor(
    db: HarnessDatabase,
    opts: { labelResolver?: (scope: MemoryScope) => string } = {},
  ) {
    this.#db = db;
    this.usage = new MemoryUsage(db);
    this.#labelResolver =
      opts.labelResolver ?? ((s) => `角色 ${s.scopeId.slice(0, 8)}`);
  }
  setLabelResolver(fn: (scope: MemoryScope) => string) {
    this.#labelResolver = fn;
  }
  #quality(input: MemoryWrite): MemoryQuality {
    return {
      category: input.category ?? "experience",
      appliesTo: input.appliesTo?.trim() || "相关任务",
      projectId: input.projectId ?? null,
      verification: "confirmed",
      source: "manual",
      evidence: input.sourceNote ?? "用户手动记录",
      note: "",
      ...input.quality,
    };
  }
  write(input: MemoryWrite): MemoryInfo {
    if (input.scopeType !== "role") throw Error("新版只支持角色记忆");
    if (!input.scopeId) throw Error("scopeId 不能为空");
    if (
      !input.title.trim() ||
      !input.content.trim() ||
      input.title.length > 200 ||
      input.content.length > 20000
    )
      throw Error("记忆标题或内容为空或超长");
    const quality = this.#quality(input);
    if (quality.appliesTo.length > 300 || quality.evidence.length > 8192)
      throw Error("记忆适用条件或依据过长");
    return this.#db.transaction(() => {
      const duplicate = (
        this.#db
          .prepare(
            "SELECT * FROM memories WHERE scope_type='role' AND scope_id=? AND title=? AND content=? AND status='active'",
          )
          .all(input.scopeId, input.title.trim(), input.content) as MemoryRow[]
      ).find((r) => {
        const q = readQuality(r.quality);
        return (
          q.projectId === quality.projectId &&
          q.appliesTo === quality.appliesTo &&
          q.category === quality.category
        );
      });
      if (duplicate) return this.#toInfo(duplicate);
      if (
        quality.source === "agent" &&
        (
          this.#db
            .prepare(
              "SELECT count(*) c FROM memories WHERE scope_type='role' AND scope_id=? AND status='active' AND json_extract(quality,'$.verification')='pending'",
            )
            .get(input.scopeId) as { c: number }
        ).c >= 40
      )
        throw Error("本角色已有40条待核对候选，请先处理后再记录");
      const now = Date.now(),
        id = uuidv7();
      if (this.#related(input.scopeId, input, quality).length) {
        quality.verification = "pending";
        quality.note = "与已有记录主题接近，需核对后再使用";
      }
      this.#db
        .prepare(
          "INSERT INTO memories(id,scope_type,scope_id,title,content,summary,tags,status,source_task_id,created_at,updated_at,quality) VALUES(?,'role',?,?,?,?,?,'active',?,?,?,?)",
        )
        .run(
          id,
          input.scopeId,
          input.title.trim(),
          input.content,
          input.summary ?? input.content.slice(0, 120),
          JSON.stringify(input.tags ?? []),
          input.sourceTaskId ?? null,
          now,
          now,
          JSON.stringify(quality),
        );
      this.#insertVersion(
        id,
        1,
        input.title.trim(),
        input.content,
        input.sourceNote ?? "初始保存",
        quality,
      );
      return this.get(id);
    });
  }
  propose(input: Omit<MemoryWrite, "quality">): MemoryInfo {
    if (!input.sourceTaskId) throw Error("经验候选必须关联来源任务");
    const source = this.#db
      .prepare("SELECT role_id FROM tasks WHERE id=?")
      .get(input.sourceTaskId) as { role_id: string } | undefined;
    if (!source || source.role_id !== input.scopeId)
      throw Error("经验来源与当前角色不匹配");
    return this.write({
      ...input,
      quality: {
        verification: "pending",
        source: "agent",
        evidence: input.sourceNote ?? "",
        note: "模型提交的候选，需核对证据；尚未用于后续任务",
      },
    });
  }
  revise(
    memoryId: string,
    patch: {
      title?: string;
      content?: string;
      reason?: string;
      expectedVersion?: number;
    } & MemoryDetails,
  ): MemoryInfo {
    return this.#db.transaction(() => {
      const row = this.#row(memoryId),
        version = this.#latestVersion(memoryId);
      if (
        patch.expectedVersion !== undefined &&
        patch.expectedVersion !== version
      )
        throw Error("记忆已更新，请刷新后重新核对");
      const title = patch.title?.trim() ?? row.title,
        content = patch.content ?? row.content;
      if (
        !title ||
        !content.trim() ||
        title.length > 200 ||
        content.length > 20000
      )
        throw Error("记忆标题或内容为空或超长");
      const quality = {
        ...readQuality(row.quality),
        category: patch.category ?? readQuality(row.quality).category,
        appliesTo:
          patch.appliesTo?.trim() || readQuality(row.quality).appliesTo,
        projectId:
          patch.projectId === undefined
            ? readQuality(row.quality).projectId
            : patch.projectId,
      };
      if (quality.appliesTo.length > 300) throw Error("适用条件不能超过300字");
      // A human correction is not evidence that the new content passed the old verification.
      quality.verification =
        readQuality(row.quality).verification === "pending"
          ? "pending"
          : "confirmed";
      quality.evidence = patch.reason?.trim() || "用户手动修正";
      quality.note = "";
      if (
        this.#related(row.scope_id, { title, content }, quality, memoryId)
          .length
      ) {
        quality.verification = "pending";
        quality.note = "与已有记录主题接近，需核对后再使用";
      }
      this.#db
        .prepare(
          "UPDATE memories SET title=?,content=?,summary=?,quality=?,updated_at=? WHERE id=?",
        )
        .run(
          title,
          content,
          content.slice(0, 120),
          JSON.stringify(quality),
          Date.now(),
          memoryId,
        );
      this.#insertVersion(
        memoryId,
        version + 1,
        title,
        content,
        patch.reason ?? "手动修正",
        quality,
      );
      return this.get(memoryId);
    });
  }
  conflicts(memoryId: string): MemoryInfo[] {
    const r = this.#row(memoryId);
    return this.#related(r.scope_id, r, readQuality(r.quality), r.id).map((r) =>
      this.#toInfo(r),
    );
  }
  review(input: {
    memoryId: string;
    expectedVersion: number;
    decision: "accept" | "replace" | "discard";
    conflicts: { id: string; version: number }[];
    evidence: string;
  }): MemoryInfo {
    return this.#db.transaction(() => {
      const row = this.#row(input.memoryId),
        q = readQuality(row.quality),
        v = this.#latestVersion(row.id);
      if (
        v !== input.expectedVersion ||
        row.status !== "active" ||
        q.verification !== "pending"
      )
        throw Error("候选已变更，请刷新后重新核对");
      if (!input.evidence.trim()) throw Error("请填写核对依据");
      const conflicts = this.conflicts(row.id),
        expected = conflicts
          .map((m) => `${m.id}:${m.version}`)
          .sort()
          .join(),
        received = input.conflicts
          .map((m) => `${m.id}:${m.version}`)
          .sort()
          .join();
      if (expected !== received)
        throw Error("相关记忆已变更，请刷新后重新核对");
      if (input.decision === "accept" && conflicts.length)
        throw Error("存在相近记录，请先修正适用范围或确认替换旧记录");
      if (input.decision === "replace" && !conflicts.length)
        throw Error("已无待替换记录，请重新核对");
      if (input.decision === "replace")
        for (const m of conflicts)
          this.#changeStatus(
            m.id,
            "forgotten",
            `由候选 ${row.id} 替换；${input.evidence}`,
          );
      if (input.decision === "discard")
        this.#changeStatus(
          row.id,
          "forgotten",
          `不采纳候选：${input.evidence}`,
        );
      else {
        q.verification = "confirmed";
        q.evidence = input.evidence.trim();
        q.note =
          input.decision === "replace"
            ? "用户核对后替换相近旧记录"
            : "用户已核对候选";
        this.#db
          .prepare("UPDATE memories SET quality=?,updated_at=? WHERE id=?")
          .run(JSON.stringify(q), Date.now(), row.id);
        this.#insertVersion(
          row.id,
          v + 1,
          row.title,
          row.content,
          input.evidence,
          q,
        );
      }
      return this.get(row.id);
    });
  }
  #changeStatus(id: string, status: "active" | "forgotten", reason: string) {
    const r = this.#row(id),
      q = readQuality(r.quality);
    if (status === "active" && this.#related(r.scope_id, r, q, id).length) {
      q.verification = "pending";
      q.note = "恢复时发现相近记录，需重新核对";
    }
    this.#db
      .prepare("UPDATE memories SET status=?,quality=?,updated_at=? WHERE id=?")
      .run(status, JSON.stringify(q), Date.now(), id);
    this.#insertVersion(
      id,
      this.#latestVersion(id) + 1,
      r.title,
      r.content,
      reason,
      q,
    );
  }
  forget(id: string) {
    this.#db.transaction(() => this.#changeStatus(id, "forgotten", "用户忘记"));
  }
  restore(id: string) {
    this.#db.transaction(() => this.#changeStatus(id, "active", "用户恢复"));
  }
  get(id: string) {
    return this.#toInfo(this.#row(id));
  }
  list(input: {
    verification?: "all" | "pending" | "ready";
    scopeType?: "user" | "role" | "project";
    scopeId?: string;
    query?: string;
    status?: "active" | "forgotten" | "all";
    limit?: number;
    offset?: number;
  }): { items: MemoryInfo[]; total: number } {
    const where = ["scope_type='role'"],
      params: unknown[] = [];
    if (input.scopeType) {
      where.push("scope_type=?");
      params.push(input.scopeType);
    }
    if (input.scopeId) {
      where.push("scope_id=?");
      params.push(input.scopeId);
    }
    if (input.status !== "all") {
      where.push("status=?");
      params.push(input.status ?? "active");
    }
    if (input.verification && input.verification !== "all")
      where.push(
        `COALESCE(json_extract(quality,'$.verification'),'legacy')${input.verification === "pending" ? "=" : "!="}'pending'`,
      );
    if (input.query?.trim()) {
      const like = `%${input.query.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')",
      );
      params.push(like, like, like, like);
    }
    const sql = where.join(" AND "),
      total = (
        this.#db
          .prepare(`SELECT count(*) c FROM memories WHERE ${sql}`)
          .get(...params) as { c: number }
      ).c;
    const rows = this.#db
      .prepare(
        `SELECT * FROM memories WHERE ${sql} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(
        ...params,
        Math.min(200, Math.max(1, input.limit ?? 50)),
        Math.max(0, input.offset ?? 0),
      ) as MemoryRow[];
    return { items: rows.map((r) => this.#toInfo(r)), total };
  }
  count(input: { scopeType?: string; scopeId?: string; status?: string }) {
    const where = ["scope_type='role'", "status=?"],
      params: unknown[] = [input.status ?? "active"];
    if (input.scopeType) {
      where.push("scope_type=?");
      params.push(input.scopeType);
    }
    if (input.scopeId) {
      where.push("scope_id=?");
      params.push(input.scopeId);
    }
    return (
      this.#db
        .prepare(`SELECT count(*) c FROM memories WHERE ${where.join(" AND ")}`)
        .get(...params) as { c: number }
    ).c;
  }
  history(id: string): MemoryVersionInfo[] {
    this.#row(id);
    return (
      this.#db
        .prepare("SELECT * FROM memory_versions WHERE memory_id=? ORDER BY ver")
        .all(id) as {
        ver: number;
        title: string;
        content: string;
        reason: string;
        created_at: number;
        quality: string;
      }[]
    ).map((r) => ({
      ver: r.ver,
      title: r.title,
      content: r.content,
      reason: r.reason,
      createdAt: r.created_at,
      quality: readQuality(r.quality),
    }));
  }
  retrieve(input: {
    scopes: MemoryScope[];
    query?: string;
    perScopeLimit?: number;
    totalLimit?: number;
    maxChars?: number;
    projectId?: string | null;
  }): MemoryInfo[] {
    const picked: MemoryInfo[] = [];
    for (const scope of input.scopes) {
      if (scope.scopeType !== "role") continue;
      const rows = this.#db
        .prepare(
          `SELECT * FROM memories WHERE scope_type='role' AND scope_id=? AND status='active'
    AND COALESCE(json_extract(quality,'$.verification'),'legacy')!='pending'
    AND (json_extract(quality,'$.projectId') IS NULL OR json_extract(quality,'$.projectId')=?) ORDER BY updated_at DESC,id DESC LIMIT 100`,
        )
        .all(scope.scopeId, input.projectId ?? null) as MemoryRow[];
      const q = input.query?.trim().toLowerCase();
      picked.push(
        ...rows
          .map((r) => this.#toInfo(r))
          .map((m) => ({ m, score: q ? this.#score(m, q) : 1 }))
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt)
          .slice(0, input.perScopeLimit ?? 4)
          .map((s) => s.m),
      );
    }
    let remaining = Math.max(0, Math.min(input.maxChars ?? 12000, 24000));
    const seen = new Set<string>();
    return picked.slice(0, input.totalLimit ?? 10).flatMap((m) => {
      if (seen.has(m.id) || remaining < 256) return [];
      seen.add(m.id);
      const content = m.content.slice(0, Math.min(2000, remaining));
      remaining -= content.length + m.title.length;
      return [{ ...m, content, summary: m.summary.slice(0, 120) }];
    });
  }
  #related(
    roleId: string,
    candidate: { title: string; content: string },
    q: MemoryQuality,
    exclude?: string,
  ): MemoryRow[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM memories WHERE scope_type='role' AND scope_id=? AND status='active' AND id!=?
   AND COALESCE(json_extract(quality,'$.verification'),'legacy')!='pending'
   AND (? IS NULL OR json_extract(quality,'$.projectId') IS NULL OR json_extract(quality,'$.projectId')=?)`,
      )
      .all(roleId, exclude ?? "", q.projectId, q.projectId) as MemoryRow[];
    return rows.filter((r) => relatedTopic(candidate, r));
  }
  #score(m: MemoryInfo, q: string): number {
    const title = m.title.toLowerCase();
    const summary = m.summary.toLowerCase();
    const content = m.content.toLowerCase();
    const tags = m.tags.join(" ").toLowerCase();
    // 分词命中（整串 includes 对自然语言查询几乎永不命中）：按标点/空白切词，中文长词再切二元组
    const tokens = new Set<string>();
    for (const t of q
      .toLowerCase()
      .split(/[\s,，。;；!！?？、()（）[\]{}："'’]+/)) {
      if (t.length < 2) continue;
      if (/[\u4e00-\u9fff]/.test(t) && t.length > 2) {
        for (let i = 0; i + 2 <= t.length; i++) tokens.add(t.slice(i, i + 2));
      } else {
        tokens.add(t);
      }
    }
    if (tokens.size === 0) return 0;
    let score = 0;
    for (const t of tokens) {
      if (title.includes(t)) score += 5;
      if (tags.includes(t)) score += 4;
      if (summary.includes(t)) score += 3;
      if (content.includes(t)) score += 1;
    }
    if (score === 0) return 0; // 关键词无命中不参与检索（近期加成不单独放行）
    // 近期加成（90 天内线性衰减）
    const ageDays = (Date.now() - m.updatedAt) / 86_400_000;
    if (ageDays < 90) score += (90 - ageDays) / 90;
    return score;
  }

  #latestVersion(id: string) {
    return (
      (
        this.#db
          .prepare("SELECT MAX(ver) v FROM memory_versions WHERE memory_id=?")
          .get(id) as { v: number | null }
      ).v ?? 0
    );
  }
  #insertVersion(
    id: string,
    ver: number,
    title: string,
    content: string,
    reason: string,
    quality: MemoryQuality,
  ) {
    this.#db
      .prepare(
        "INSERT INTO memory_versions(memory_id,ver,title,content,reason,created_at,quality) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        ver,
        title,
        content,
        reason,
        Date.now(),
        JSON.stringify(quality),
      );
  }
  #row(id: string): MemoryRow {
    const row = this.#db
      .prepare("SELECT * FROM memories WHERE id=? AND scope_type='role'")
      .get(id) as MemoryRow | undefined;
    if (!row) throw Error(`记忆不存在: ${id}`);
    return row;
  }
  #toInfo(r: MemoryRow): MemoryInfo {
    return {
      id: r.id,
      scopeType: "role",
      scopeId: r.scope_id,
      scopeLabel: this.#labelResolver({
        scopeType: "role",
        scopeId: r.scope_id,
      }),
      title: r.title,
      content: r.content,
      summary: r.summary,
      tags: JSON.parse(r.tags),
      status: r.status === "forgotten" ? "forgotten" : "active",
      sourceTaskId: r.source_task_id,
      sourceWorkbenchId: r.source_task_id
        ? (
            this.#db
              .prepare(
                "SELECT workbench_id FROM workbench_runs WHERE task_id=?",
              )
              .get(r.source_task_id) as { workbench_id: string } | undefined
          )?.workbench_id
        : undefined,
      sourceDeleted:
        !!r.source_task_id &&
        !this.#db
          .prepare("SELECT 1 FROM tasks WHERE id=?")
          .get(r.source_task_id),
      quality: readQuality(r.quality),
      version: this.#latestVersion(r.id),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
