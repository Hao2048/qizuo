import { createHash } from "node:crypto";
import type { RoleSnapshot } from "./prompts.js";
export function configurationHash(value: RoleSnapshot) {
  return createHash("sha256")
    .update(JSON.stringify(normalizeConfiguration(value)))
    .digest("hex");
}
export function normalizeConfiguration(s: RoleSnapshot): RoleSnapshot {
  return {
    roleId: s.roleId,
    name: s.name,
    intro: s.intro,
    systemPrompt: s.systemPrompt,
    preferredModel: s.preferredModel ?? null,
    preferredThinking: s.preferredThinking ?? null,
    boundSkills: s.boundSkills ?? [],
    boundPlugins: s.boundPlugins ?? [],
  };
}
export function configurationChanges(
  before: RoleSnapshot,
  after: RoleSnapshot,
) {
  const labels = {
    name: "名称",
    intro: "简介",
    systemPrompt: "角色提示词",
    preferredModel: "推荐模型",
    preferredThinking: "思考强度",
    boundSkills: "绑定技能",
    boundPlugins: "绑定插件",
  };
  const a = normalizeConfiguration(before),
    b = normalizeConfiguration(after);
  return (Object.keys(labels) as Array<keyof typeof labels>).flatMap((key) =>
    JSON.stringify(a[key]) === JSON.stringify(b[key])
      ? []
      : [
          {
            label: labels[key],
            before:
              typeof a[key] === "string"
                ? (a[key] as string)
                : JSON.stringify(a[key]),
            after:
              typeof b[key] === "string"
                ? (b[key] as string)
                : JSON.stringify(b[key]),
          },
        ],
  );
}
export function receipt(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
