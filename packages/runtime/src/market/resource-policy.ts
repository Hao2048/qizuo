/**
 * ResourcePolicy：资源可见性与角色绑定的运行时执行。
 *
 * 规则（需求 M8）：
 * - 已安装资源默认「公开」：所有角色任务中可按需使用
 * - 「私有」资源（skill：本地技能；package：pi 包整体）：仅绑定了它的角色可用
 * - 绑定资源在角色任务中「优先使用」（系统提示词注入优先提示）
 *
 * 执行手段：
 * - skill → DefaultResourceLoader.skillsOverride 按名单过滤
 * - package（私有）→ 从 pi settings.json 声明移除（默认不加载），绑定角色的会话经
 *   additionalExtensionPaths 以磁盘路径重新注入（文件保留，随时可切回公开）
 */
import type { HarnessDatabase } from "../db/database.js";

export interface ResourcePolicyDeps {
	db: HarnessDatabase;
	resolvePackagePath: (source: string) => string | null;
}

export class ResourcePolicy {
	#db: HarnessDatabase;
	#resolve: (source: string) => string | null;

	constructor(deps: ResourcePolicyDeps) {
		this.#db = deps.db;
		this.#resolve = deps.resolvePackagePath;
	}

	/** 全部私有资源名单。 */
	privateEntries(): Array<{ name: string; kind: "skill" | "package"; source: string | null }> {
		return (
			this.#db
				.prepare("SELECT name, kind, source FROM resource_visibility WHERE visibility = 'private'")
				.all() as Array<{ name: string; kind: string; source: string | null }>
		).map((r) => ({ name: r.name, kind: r.kind === "package" ? "package" : "skill", source: r.source }));
	}

	/**
	 * 计算某角色的会话装配参数：
	 * - allowedSkills：null = 不过滤（无私有 skill）；数组 = 白名单
	 * - extraExtensionPaths：私有且绑定的包路径（注入加载）
	 * - priorityNames：绑定资源名单（优先提示用）
	 */
	computeForRole(boundSkills: string[], boundPlugins: string[]): {
		allowedSkills: string[] | null;
		extraExtensionPaths: string[];
		priorityNames: string[];
	} {
		const priv = this.privateEntries();
		const privateSkills = priv.filter((p) => p.kind === "skill").map((p) => p.name);
		const privatePackages = priv.filter((p) => p.kind === "package");

		// skill 白名单：公开全部 + 私有但绑定
		let allowedSkills: string[] | null = null;
		if (privateSkills.length > 0) {
			const bound = new Set(boundSkills);
			allowedSkills = privateSkills.filter((n) => bound.has(n));
			// 白名单语义 = 排除私有未绑定 → 返回 null 表示不过滤 + 排除集
		}

		// 私有包：绑定 → 注入路径；未绑定 → 不加载（已从 settings 移除）
		const boundPkg = new Set(boundPlugins);
		const extraExtensionPaths: string[] = [];
		for (const pkg of privatePackages) {
			if (pkg.source && boundPkg.has(pkg.name)) {
				const p = this.#resolve(pkg.source);
				if (p) extraExtensionPaths.push(p);
			}
		}

		return {
			allowedSkills,
			extraExtensionPaths,
			priorityNames: [...boundSkills, ...boundPlugins].filter(Boolean),
		};
	}

	/** 优先提示（追加到系统提示词）。 */
	priorityPrompt(names: string[]): string {
		if (names.length === 0) return "";
		return `## 优先资源\n本角色绑定了以下技能/插件，任务中优先使用：${[...new Set(names)].sort().join("、")}。`;
	}

	/** skillsOverride 过滤回调（私有 skill 仅绑定角色可见）。返回类型保持 base 透传。 */
	skillsFilter(boundSkills: string[]): <T extends { skills: Array<{ name: string }>; [k: string]: unknown }>(current: T) => T {
		const bound = new Set(boundSkills);
		return (current) => {
            // One fresh visibility query per load, rather than one query per skill.
            const privateSkills=new Set(this.privateEntries().filter(p=>p.kind==="skill").map(p=>p.name));
            return {...current,skills:current.skills.filter(s=>!privateSkills.has(s.name)||bound.has(s.name))};
        };
	}

}
