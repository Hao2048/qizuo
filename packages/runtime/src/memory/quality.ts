import type { MemoryQuality } from "@pi-harness/contracts";
export const legacyQuality: MemoryQuality = {
  category: "experience",
  appliesTo: "相关任务",
  projectId: null,
  verification: "legacy",
  source: "legacy",
  evidence: "",
  note: "旧版记录，尚无验证依据",
};
export function readQuality(text?: string): MemoryQuality {
  try {
    const value = JSON.parse(text ?? "{}");
    return { ...legacyQuality, ...value };
  } catch {
    return { ...legacyQuality };
  }
}
const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, "");
/** Conservative topic overlap: a review hint, never a claim that two statements contradict. */
export function relatedTopic(
  a: { title: string; content: string },
  b: { title: string; content: string },
) {
  if (normalize(a.content) === normalize(b.content)) return true;
  const x = normalize(a.title),
    y = normalize(b.title);
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))
    return true;
  const tokens = (text: string) =>
    new Set(text.match(/[a-z0-9]+|[\p{Script=Han}]{2}/gu) ?? []);
  const xt = tokens(x),
    yt = tokens(y),
    common = [...xt].filter((t) => yt.has(t)).length;
  return common >= 2 && common / Math.max(xt.size, yt.size) >= 0.7;
}
