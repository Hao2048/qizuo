import type { CatalogItem } from "@pi-harness/contracts";
import type { MarketService } from "./market-service.js";
import type { ClaudeSkillSource } from "./claude-source.js";
import { mapConcurrent } from "./concurrency.js";

export const RECOMMEND_INTERVAL = 7 * 24 * 3600_000;
export type CatalogSource = "pi" | "claude";
export type CatalogKind = "plugins" | "skills";
type Meta = { get(key: string): string | null; set(key: string, value: string): void };
type Recommendations = { items: CatalogItem[]; generatedAt: number; nextRefreshAt: number; note?: string };

/** 来源、类型均参与缓存键；不把社区资源标成 Claude 官方。 */
export class CatalogService {
 #market: MarketService;
 #claude: ClaudeSkillSource;
 #meta: Meta;
 #pending = new Map<string, Promise<Recommendations>>();
 #catalog = new Map<string, { at: number; value: Promise<{ items: CatalogItem[]; note?: string }> }>();
 #piGallery = new Map<string, { at: number; value: ReturnType<MarketService["listPiGallery"]> }>();
 #manifest = new Map<string, { at: number; value: Promise<CatalogKind[] | null> }>();
 #disposed = false;
 constructor(market: MarketService, claude: ClaudeSkillSource, meta: Meta) { this.#market = market; this.#claude = claude; this.#meta = meta; }
 dispose() { this.#disposed = true; }
 async list(source: CatalogSource, kind: CatalogKind, query?: string): Promise<{ items: CatalogItem[]; note?: string }> {
 const key = `${source}:${kind}:${query ?? ""}`;
 const cached = this.#catalog.get(key);
 if (cached && Date.now() - cached.at < 600_000) return cached.value;
 const value = this.#load(source, kind, query);
 this.#catalog.set(key, { at: Date.now(), value });
 if (this.#catalog.size > 32) this.#catalog.delete(this.#catalog.keys().next().value!);
 try {
 const result = await value;
 if (!result.items.length || result.note) this.#catalog.delete(key);
 return result;
 } catch (error) { this.#catalog.delete(key); throw error; }
 }
 async #load(source: CatalogSource, kind: CatalogKind, query?: string): Promise<{ items: CatalogItem[]; note?: string }> {
 if (source === "claude") {
 const all = await this.#claude.list(query, kind);
 return { items: all.map(x => ({ name: x.name, source: `claude:${x.name}`, origin: "claude", description: x.description || null, downloads: null, resourceKinds: [kind], installable: x.installable !== false, compatibility: x.compatibility, auth: x.kind === "mcp-plugin" && x.name === "github" ? "oauth" : undefined })), note: all.some(x => x.fallback) ? "官方目录暂不可用，显示官方技能回退清单" : undefined };
 }
 const queryKey = query ?? "";
 let cached = this.#piGallery.get(queryKey);
 if (!cached || Date.now() - cached.at >= 600_000) {
 const value = this.#market.listPiGallery(query).then(result => { if (!result.items.length || result.note) this.#piGallery.delete(queryKey); return result; }).catch(error => { this.#piGallery.delete(queryKey); throw error; });
 cached = { at: Date.now(), value }; this.#piGallery.set(queryKey, cached);
 if (this.#piGallery.size > 16) this.#piGallery.delete(this.#piGallery.keys().next().value!);
 }
 const catalog = await cached.value;
 let failures = 0;
 const items = await mapConcurrent(catalog.items, 8, async x => {
 try {
 let manifest = this.#manifest.get(x.name);
 if (!manifest || Date.now() - manifest.at >= 600_000) {
 const value = (async () => {
 try {
 const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(x.name)}/latest`, { signal: AbortSignal.timeout(12_000) });
 if (!res.ok) return null;
 const pkg = await res.json() as { pi?: { extensions?: string[]; skills?: string[] } };
 const kinds: CatalogKind[] = [];
 if (pkg.pi?.extensions?.length) kinds.push("plugins");
 if (pkg.pi?.skills?.length) kinds.push("skills");
 return kinds;
 } catch { return null; }
 })();
 manifest = { at: Date.now(), value }; this.#manifest.set(x.name, manifest);
 if (this.#manifest.size > 256) this.#manifest.delete(this.#manifest.keys().next().value!);
 }
 const kinds = await manifest.value;
 if (!kinds) { failures++; this.#manifest.delete(x.name); return null; }
 if (!kinds.includes(kind)) return null;
 return { name: x.name, source: x.source, origin: "pi", description: x.description, downloads: x.downloads, resourceKinds: kinds, installable: true, popularity: x.popularity, auth: /^@(amaster\.ai|tunglam|yandy0725)\/pi-lark(?:-cli)?$/.test(x.name) ? "lark" : undefined } as CatalogItem;
 } catch { failures++; return null; }
 });
 return { items: items.filter((x): x is CatalogItem => x !== null), note: catalog.note ?? (failures ? `${failures} 个包的类型信息暂不可用，稍后刷新可重试` : undefined) };
 }
 recommend(source: CatalogSource = "pi", kind: CatalogKind = "plugins"): Promise<Recommendations> {
 const key = `market_recommend_v2:${source}:${kind}`;
 let cached: Recommendations | undefined;
 try { cached = JSON.parse(this.#meta.get(key) ?? "null") ?? undefined; } catch { /* 重建 */ }
 if (cached && Array.isArray(cached.items) && cached.nextRefreshAt > Date.now()) return Promise.resolve(cached);
 const pending = this.#pending.get(key);
 if (pending) return pending;
 const value = this.#generate(source, kind, cached).then(result => {
 if (!this.#disposed && result.items.length && !result.note?.includes("沿用")) this.#meta.set(key, JSON.stringify(result));
 return result;
 }).finally(() => this.#pending.delete(key));
 this.#pending.set(key, value);
 return value;
 }
 async #generate(source: CatalogSource, kind: CatalogKind, cached?: Recommendations): Promise<Recommendations> {
 try {
 const catalog = await this.list(source, kind);
 if (!catalog.items.length) {
 if (cached?.items.length) return { ...cached, note: "更新暂不可用，沿用上次推荐；稍后自动重试" };
 return { items: [], generatedAt: Date.now(), nextRefreshAt: Date.now(), note: catalog.note ?? "当前来源暂无可推荐内容，稍后刷新重试" };
 }
 const ranked = catalog.items.filter(x => x.installable).map(x => {
 const utility = utilityScore(x);
 const popularity = Math.max(0, Math.min(1, x.popularity ?? 0));
 const score = 0.45 * Math.min(1, Math.log10(1 + (x.downloads ?? 0)) / 5) + 0.25 * popularity + 0.30 * utility;
 return { ...x, score, reasons: [ ...(x.downloads === null ? [] : [`月下载 ${x.downloads.toLocaleString("zh-CN")}`]), ...(popularity ? ["社区热度"] : []), ...(utility >= 0.6 ? ["常用工作流程"] : ["专用工具能力"]) ] };
 }).sort((a,b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0,6).map(({score, ...item}) => item);
 const generatedAt = Date.now();
 return { items: ranked, generatedAt, nextRefreshAt: generatedAt + (catalog.note ? 3600_000 : RECOMMEND_INTERVAL), note: catalog.note ?? (source === "claude" ? "Claude 官方未公开逐项下载量与热度，按工具实用性推荐；每周更新" : "综合月下载量、npm 社区热度与常用工作流程；每周更新") };
 } catch {
 if (cached?.items.length) return { ...cached, note: "更新暂不可用，沿用上次推荐；稍后自动重试" };
 return { items: [], generatedAt: Date.now(), nextRefreshAt: Date.now(), note: "推荐加载失败，稍后重试" };
 }
 }
}
function utilityScore(x: CatalogItem): number {
 // Examples and migration tutorials should not displace everyday tools when metrics are unavailable.
 if (/example|demo|tutorial|migration/i.test(x.name)) return 0.05;
 if (/github|lark|feishu|docx|pdf|xlsx|pptx|web.?access|webapp|browser|frontend|memory|calendar/i.test(x.name)) return 1;
 if (/test|search|debug|git|document|design|workflow|code.?review|agent/i.test(`${x.name} ${x.description}`)) return 0.65;
 if (/mcp/i.test(`${x.name} ${x.description}`)) return 0.5;
 return 0.3;
}
