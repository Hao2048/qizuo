// Show schema locations and known field names, never provider text, values or arbitrary keys.
const fields = new Set(["reply","action","roleIds","assignments","roleId","instructions","files","dependsOn","attachmentIds","deliverables","path","format","fields","pointer","type","equals","includes","schema","required","properties","items","additionalProperties","sections","plan","contracts","id","title","content","roles"]);
export function routingDiagnostic(message: string): string {
  const split = message.indexOf(":");
  const candidate = split >= 0 ? message.slice(0, split) : "/";
  const path = candidate.startsWith("/") && candidate.length <= 180 && candidate.split("/").slice(1).every(p => p === "" || fields.has(p) || /^\d{1,5}$/.test(p)) ? candidate : "/";
  const reason = split >= 0 ? message.slice(split + 1).trim() : "";
  const missing = reason.startsWith("must have required properties ")
    ? reason.slice("must have required properties ".length).split(/[,\s]+/).filter(p => fields.has(p)) : [];
  return `字段 ${path}${missing.length ? ` 缺少必填项 ${[...new Set(missing)].join("、")}` : " 的格式不符合分工约定"}`;
}
