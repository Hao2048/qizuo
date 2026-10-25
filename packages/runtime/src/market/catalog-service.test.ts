import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogService, RECOMMEND_INTERVAL } from "./catalog-service.js";
import type { MarketService } from "./market-service.js";
import type { ClaudeSkillSource } from "./claude-source.js";

function fixture() {
 const data = new Map<string, string>();
 const gallery = vi.fn(async () => ({ items: [
 { name: "plugin", source: "npm:plugin", description: "browser tools", downloads: 3000, popularity: 0.7 },
 { name: "skill", source: "npm:skill", description: "PDF workflow", downloads: 1000 },
 { name: "both", source: "npm:both", description: "git workflow", downloads: null },
 ] }));
 const claude = vi.fn(async () => [
 { name: "github", description: "GitHub tools", kind: "mcp-plugin", installable: true },
 { name: "native", description: "Claude hooks", kind: "plugin", installable: false },
 ]);
 vi.stubGlobal("fetch", vi.fn(async (url: string) => {
 const name = new URL(url).pathname.split("/")[1];
 return new Response(JSON.stringify({ pi: name === "plugin" ? { extensions: ["./index.ts"] } : name === "skill" ? { skills: ["./skills"] } : { skills: ["./skills"], extensions: ["./index.ts"] } }));
 }));
 const meta = { get: (key: string) => data.get(key) ?? null, set: vi.fn((key: string, value: string) => { data.set(key, value); }) };
 const service = new CatalogService({ listPiGallery: gallery } as unknown as MarketService, { list: claude } as unknown as ClaudeSkillSource, meta);
 return { service, gallery, claude, meta, data };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("official marketplace recommendations", () => {
 it("Pi manifests separate plugins/skills and retain packages containing both", async () => {
 const { service, gallery } = fixture();
 expect((await service.list("pi", "plugins")).items.map(x => x.name)).toEqual(["plugin", "both"]);
 expect((await service.list("pi", "skills")).items.map(x => x.name)).toEqual(["skill", "both"]);
 expect(gallery).toHaveBeenCalledTimes(1);
 });
 it("recommendations persist across restarts, coalesce requests and refresh after seven days", async () => {
 vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01"));
 const { service, gallery, claude, meta } = fixture();
 const [a,b] = await Promise.all([service.recommend("pi", "plugins"), service.recommend("pi", "plugins")]);
 expect(a).toEqual(b); expect(gallery).toHaveBeenCalledTimes(1);
 expect(a.nextRefreshAt - a.generatedAt).toBe(RECOMMEND_INTERVAL);
 const restarted = new CatalogService({ listPiGallery: gallery } as unknown as MarketService, { list: claude } as unknown as ClaudeSkillSource, meta);
 expect(await restarted.recommend("pi", "plugins")).toEqual(a); expect(gallery).toHaveBeenCalledTimes(1);
 vi.setSystemTime(Date.now() + RECOMMEND_INTERVAL + 1);
 expect((await restarted.recommend("pi", "plugins")).generatedAt).toBeGreaterThan(a.generatedAt);
 expect(gallery).toHaveBeenCalledTimes(2);
 });
 it("source and resource type have independent keys; unsupported Claude plugins are never recommended", async () => {
 const { service, data, claude } = fixture();
 await service.recommend("pi", "plugins"); await service.recommend("pi", "skills");
 const result = await service.recommend("claude", "plugins");
 expect(claude).toHaveBeenCalledWith(undefined, "plugins");
 expect(result.items.map(x => x.name)).toEqual(["github"]);
 expect(result.items[0]?.downloads).toBeNull(); expect(result.items[0]?.source).toBe("claude:github");
 expect(result.note).toContain("未公开"); expect(data.size).toBe(3);
 });
 it("failed weekly refresh keeps last good result and retries instead of freezing failures for a week", async () => {
 vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-01"));
 const { service, gallery } = fixture(); const old = await service.recommend("pi", "plugins");
 vi.setSystemTime(Date.now()+RECOMMEND_INTERVAL+1); gallery.mockRejectedValueOnce(new Error("offline"));
 const fallback = await service.recommend("pi", "plugins"); expect(fallback.items).toEqual(old.items); expect(fallback.note).toContain("沿用");
 const fresh = await service.recommend("pi", "plugins"); expect(fresh.generatedAt).toBeGreaterThan(old.generatedAt);
 });
 it("catalog errors do not poison cache; disposed service cannot write to closed metadata", async () => {
 const { service, gallery, meta } = fixture(); gallery.mockRejectedValueOnce(new Error("offline"));
 await expect(service.list("pi", "plugins")).rejects.toThrow("offline");
 expect((await service.list("pi", "plugins")).items.length).toBe(2);
 service.dispose(); await service.recommend("pi", "plugins"); expect(meta.set).not.toHaveBeenCalled();
 });
});
