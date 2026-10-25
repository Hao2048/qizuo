/**
 * RoleService：角色卡六项定义的 CRUD、克隆、默认卡与快照。
 */
import type { RoleInfo } from "@pi-harness/contracts";
import { uuidv7 } from "@pi-harness/shared";
import type { HarnessDatabase } from "../db/database.js";
import type { MemoryService } from "../memory/memory-service.js";
import { type RoleSnapshot } from "./prompts.js";

export const DEFAULT_ROLE_NAME = "任务助手";
const DEFAULT_ROLE_INTRO =
  "理解需求，推荐角色，协调任务；专业工作由用户选定的角色完成。";
export const COORDINATOR_PROMPT = `你是 栖作 Qizuo 的默认任务助手。理解用户需求，推荐已有专业角色，说明职责与依赖，协调已有参与者。不要虚构角色，不要自行恢复暂停角色，不要替用户选择互斥方案。执行状态以工具和内核事实为准，不能仅凭计划宣布已经执行。记录可复用偏好，项目细节留在项目状态。`;
const DEFAULT_ROLE_MEMORY_SEED = {
  title: "工作偏好",
  content: "回答简洁直接、用中文；修改前先说明意图；不确定时先问再做。",
};

interface RoleRow {
  id: string;
  name: string;
  intro: string;
  system_prompt: string;
  bound_skills: string;
  bound_plugins: string;
  preferred_model: string | null;
  preferred_thinking: string | null;
  is_default: number;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface RoleServiceOptions {
  db: HarnessDatabase;
  memory: MemoryService;
}

export class RoleService {
  #db: HarnessDatabase;
  #memory: MemoryService;

  constructor(opts: RoleServiceOptions) {
    this.#db = opts.db;
    this.#memory = opts.memory;
  }

  /** 框架默认角色（幂等 seed，含记忆种子）。 */
  seedDefault(): RoleInfo {
    const existing = this.#db
      .prepare("SELECT * FROM roles WHERE is_default = 1 AND status = 'active'")
      .get() as RoleRow | undefined;
    if (existing) {
      if (
        existing.name !== DEFAULT_ROLE_NAME ||
        existing.system_prompt !== COORDINATOR_PROMPT
      )
        this.#db
          .prepare(
            "UPDATE roles SET name=?,intro=?,system_prompt=?,updated_at=? WHERE id=?",
          )
          .run(
            DEFAULT_ROLE_NAME,
            DEFAULT_ROLE_INTRO,
            COORDINATOR_PROMPT,
            Date.now(),
            existing.id,
          );
      return this.get(existing.id);
    }

    const now = Date.now();
    const id = uuidv7();
    this.#db
      .prepare(
        "INSERT INTO roles (id, name, intro, system_prompt, is_default, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)",
      )
      .run(
        id,
        DEFAULT_ROLE_NAME,
        DEFAULT_ROLE_INTRO,
        COORDINATOR_PROMPT,
        now,
        now,
      );
    // 记忆种子：默认角色的角色层记忆
    this.#memory.write({
      scopeType: "role",
      scopeId: id,
      title: DEFAULT_ROLE_MEMORY_SEED.title,
      content: DEFAULT_ROLE_MEMORY_SEED.content,
      tags: ["seed"],
      category: "preference",
      quality: {
        source: "builtin",
        verification: "legacy",
        evidence: "应用初始偏好，尚未经用户核对",
      },
    });
    return this.#toInfo(this.#row(id));
  }

  list(includeArchived = false): RoleInfo[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM roles ${includeArchived ? "" : "WHERE status = 'active'"} ORDER BY is_default DESC, updated_at DESC`,
      )
      .all() as unknown as RoleRow[];
    return rows.map((r) => this.#toInfo(r));
  }

  get(roleId: string): RoleInfo {
    return this.#toInfo(this.#row(roleId));
  }

  create(input: {
    name: string;
    intro?: string;
    systemPrompt?: string;
    boundSkills?: string[];
    boundPlugins?: string[];
    preferredModel?: { provider: string; modelId: string } | null;
    preferredThinking?: string | null;
  }): RoleInfo {
    const now = Date.now();
    const id = uuidv7();
    this.#db
      .prepare(
        "INSERT INTO roles (id, name, intro, system_prompt, bound_skills, bound_plugins, preferred_model, preferred_thinking, is_default, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)",
      )
      .run(
        id,
        input.name.trim(),
        input.intro ?? "",
        input.systemPrompt ?? "",
        JSON.stringify(input.boundSkills ?? []),
        JSON.stringify(input.boundPlugins ?? []),
        input.preferredModel ? JSON.stringify(input.preferredModel) : null,
        input.preferredThinking ?? null,
        now,
        now,
      );
    return this.get(id);
  }

  update(
    roleId: string,
    patch: {
      name?: string;
      intro?: string;
      systemPrompt?: string;
      boundSkills?: string[];
      boundPlugins?: string[];
      preferredModel?: { provider: string; modelId: string } | null;
      preferredThinking?: string | null;
    },
  ): RoleInfo {
    const row = this.#row(roleId);
    if (
      row.is_default &&
      ((patch.name !== undefined && patch.name !== row.name) ||
        (patch.intro !== undefined && patch.intro !== row.intro) ||
        (patch.systemPrompt !== undefined &&
          patch.systemPrompt !== row.system_prompt))
    )
      throw new Error("默认任务助手的身份与核心提示词由系统维护，可克隆后编辑");
    const now = Date.now();
    this.#db
      .prepare(
        "UPDATE roles SET name = ?, intro = ?, system_prompt = ?, bound_skills = ?, bound_plugins = ?, preferred_model = ?, preferred_thinking = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.name?.trim() ?? row.name,
        patch.intro ?? row.intro,
        patch.systemPrompt ?? row.system_prompt,
        JSON.stringify(patch.boundSkills ?? JSON.parse(row.bound_skills)),
        JSON.stringify(patch.boundPlugins ?? JSON.parse(row.bound_plugins)),
        patch.preferredModel !== undefined
          ? patch.preferredModel
            ? JSON.stringify(patch.preferredModel)
            : null
          : row.preferred_model,
        patch.preferredThinking !== undefined
          ? patch.preferredThinking
          : row.preferred_thinking,
        now,
        roleId,
      );
    return this.get(roleId);
  }

  archive(roleId: string, archived: boolean): void {
    const row = this.#row(roleId);
    if (row.is_default && archived) throw new Error("默认角色卡不能归档");
    this.#db
      .prepare("UPDATE roles SET status = ?, updated_at = ? WHERE id = ?")
      .run(archived ? "archived" : "active", Date.now(), roleId);
  }

  /**
   * 克隆：仅配置 / 配置+记忆快照。
   * 记忆快照 = 复制该角色记忆为新角色私有副本（provenance 标记），此后互不影响。
   */
  clone(roleId: string, withMemory: boolean, name?: string): RoleInfo {
    return this.#db.transaction(() => {
      const row = this.#row(roleId);
      const created = this.create({
        name: name ?? `${row.name} 副本`,
        intro: row.intro,
        systemPrompt: row.system_prompt,
        boundSkills: JSON.parse(row.bound_skills) as string[],
        boundPlugins: JSON.parse(row.bound_plugins) as string[],
        preferredModel: row.preferred_model
          ? JSON.parse(row.preferred_model)
          : null,
        preferredThinking: row.preferred_thinking,
      });
      if (withMemory) {
        for (let offset = 0; ; offset += 200) {
          const memories = this.#memory.list({
            scopeType: "role",
            scopeId: roleId,
            status: "active",
            limit: 200,
            offset,
          });
          for (const m of memories.items) {
            this.#memory.write({
              scopeType: "role",
              scopeId: created.id,
              title: m.title,
              content: m.content,
              summary: m.summary,
              tags: [...m.tags, "clone"],
              sourceTaskId: m.sourceTaskId,
              category: m.quality?.category,
              appliesTo: m.quality?.appliesTo,
              projectId: m.quality?.projectId,
              quality: m.quality
                ? {
                    ...m.quality,
                    note: `${m.quality.note}；克隆自角色 ${roleId} / 记忆 ${m.id} v${m.version}`,
                  }
                : {
                    verification: "legacy",
                    source: "legacy",
                    evidence: "",
                    note: `克隆自角色 ${roleId} / 记忆 ${m.id}`,
                  },
              sourceNote: `用户克隆角色记忆；原角色 ${roleId} / 记忆 ${m.id} v${m.version}`,
            });
          }
          if (offset + memories.items.length >= memories.total) break;
        }
      }
      return this.get(created.id);
    });
  }

  /** 任务绑定的角色快照（冻结当时六项+资源绑定，编辑不影响运行中任务）。 */
  snapshot(roleId: string): RoleSnapshot {
    const row = this.#row(roleId);
    return {
      roleId: row.id,
      name: row.name,
      intro: row.intro,
      systemPrompt: row.system_prompt,
      preferredModel: row.preferred_model
        ? JSON.parse(row.preferred_model)
        : null,
      preferredThinking: row.preferred_thinking,
      boundSkills: JSON.parse(row.bound_skills) as string[],
      boundPlugins: JSON.parse(row.bound_plugins) as string[],
    };
  }

  memoryCountOf(roleId: string): number {
    return this.#memory.count({
      scopeType: "role",
      scopeId: roleId,
      status: "active",
    });
  }

  #row(roleId: string): RoleRow {
    const row = this.#db
      .prepare("SELECT * FROM roles WHERE id = ?")
      .get(roleId) as RoleRow | undefined;
    if (!row) throw new Error(`角色不存在: ${roleId}`);
    return row;
  }

  #toInfo(row: RoleRow): RoleInfo {
    return {
      id: row.id,
      name: row.name,
      intro: row.intro,
      systemPrompt: row.system_prompt,
      boundSkills: JSON.parse(row.bound_skills) as string[],
      boundPlugins: JSON.parse(row.bound_plugins) as string[],
      preferredModel: row.preferred_model
        ? JSON.parse(row.preferred_model)
        : null,
      preferredThinking: row.preferred_thinking,
      isDefault: row.is_default === 1,
      status: row.status === "archived" ? "archived" : "active",
      memoryCount: this.#memory.count({
        scopeType: "role",
        scopeId: row.id,
        status: "active",
      }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
