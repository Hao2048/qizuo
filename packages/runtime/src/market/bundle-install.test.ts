import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installBundle, recoverBundleInstalls, stageInstall } from "./bundle-install.js";
import { InstallOperations } from "./install-operations.js";

const fault = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:fs", async importOriginal => {
	const original = await importOriginal<typeof import("node:fs")>();
	return { ...original, renameSync: (from: string, to: string) => {
		if (fault.enabled && from.endsWith("/new/2") && to.endsWith("/mcp.json")) { fault.enabled = false; throw new Error("disk failure"); }
		return original.renameSync(from, to);
	} };
});
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pih-bundle-test-"));
	mkdirSync(join(root, "pi/npm"), { recursive: true });
	writeFileSync(join(root, "pi/npm/old"), "old dependency");
	writeFileSync(join(root, "pi/settings.json"), "old settings");
	writeFileSync(join(root, "pi/mcp.json"), "old MCP");
});
afterEach(() => { fault.enabled = false; rmSync(root, { recursive: true, force: true }); });
async function build(work: string) {
	const npm = join(work, "npm"), settings = join(work, "settings"), mcp = join(work, "mcp");
	mkdirSync(npm); writeFileSync(join(npm, "new"), "new dependency");
	return () => {
		writeFileSync(settings, "new settings", { mode: 0o600 }); writeFileSync(mcp, "new MCP", { mode: 0o600 });
		return [{ target: "pi/npm", staged: npm }, { target: "pi/settings.json", staged: settings }, { target: "pi/mcp.json", staged: mcp }];
	};
}
function originals() {
	expect(readFileSync(join(root, "pi/npm/old"), "utf8")).toBe("old dependency");
	expect(readFileSync(join(root, "pi/settings.json"), "utf8")).toBe("old settings");
	expect(readFileSync(join(root, "pi/mcp.json"), "utf8")).toBe("old MCP");
}
it("publishes resources and both private configuration files together", async () => {
	await installBundle(root, "pi", build);
	expect(existsSync(join(root, "pi/npm/old"))).toBe(false);
	expect(readFileSync(join(root, "pi/settings.json"), "utf8")).toBe("new settings");
	expect(readFileSync(join(root, "pi/mcp.json"), "utf8")).toBe("new MCP");
	expect(statSync(join(root, "pi/settings.json")).mode & 0o777).toBe(0o600);
	expect(readdirSync(root)).toEqual(["pi"]);
});
it("rolls back every earlier replacement when the final configuration write fails", async () => {
	fault.enabled = true;
	await expect(installBundle(root, "pi", build)).rejects.toThrow("disk failure");
	originals(); expect(readdirSync(root)).toEqual(["pi"]);
});
it("does not replace anything when config preparation or lock acquisition fails", async () => {
	await expect(installBundle(root, "pi", async () => () => { throw new Error("invalid config"); })).rejects.toThrow("invalid config");
	const lock = join(root, "pi/settings.json.lock"); mkdirSync(lock);
	await expect(installBundle(root, "pi", build)).rejects.toThrow();
	originals(); expect(existsSync(lock)).toBe(true);
});
it("recovers an interrupted multi-file commit and releases only its own settings lock", () => {
	const dir = join(root, ".pih-bundle-crash"); mkdirSync(join(dir, "old"), {recursive:true}); mkdirSync(join(dir, "new"));
	const entries = ["pi/npm", "pi/settings.json", "pi/mcp.json"].map(target => ({target,hadTarget:true}));
	for (let i = 0; i < 2; i++) renameSync(join(root, entries[i]!.target), join(dir, "old", String(i)));
	mkdirSync(join(root, "pi/npm")); writeFileSync(join(root, "pi/npm/new"), "partial"); writeFileSync(join(root, "pi/settings.json"), "partial");
	writeFileSync(join(dir, "new/2"), "next MCP");
	writeFileSync(join(dir, "journal.json"), JSON.stringify({committed:false,entries}));
	mkdirSync(join(root, "pi/settings.json.lock")); writeFileSync(join(root, "pi/settings.json.lock/pih-owner"), ".pih-bundle-crash");
	recoverBundleInstalls(root); originals(); expect(readdirSync(root)).toEqual(["pi"]);
});
it("keeps a committed installation when shutdown interrupted backup cleanup", () => {
	const dir=join(root,".pih-bundle-committed");mkdirSync(join(dir,"old"),{recursive:true});mkdirSync(join(dir,"new"));
	const entries=["pi/npm","pi/settings.json","pi/mcp.json"].map(target=>({target,hadTarget:true}));
	for(const [index,entry] of entries.entries())renameSync(join(root,entry.target),join(dir,"old",String(index)));
	mkdirSync(join(root,"pi/npm"));writeFileSync(join(root,"pi/npm/new"),"committed");
	writeFileSync(join(root,"pi/settings.json"),"committed settings");writeFileSync(join(root,"pi/mcp.json"),"committed MCP");
	writeFileSync(join(dir,"journal.json"),JSON.stringify({committed:true,entries}));
	recoverBundleInstalls(root);recoverBundleInstalls(root);
	expect(readFileSync(join(root,"pi/npm/new"),"utf8")).toBe("committed");
	expect(readFileSync(join(root,"pi/settings.json"),"utf8")).toBe("committed settings");
	expect(readFileSync(join(root,"pi/mcp.json"),"utf8")).toBe("committed MCP");expect(readdirSync(root)).toEqual(["pi"]);
});
it("refuses malicious journal targets and symlink parents without changing live files", async () => {
	const dir = join(root, ".pih-bundle-bad"); mkdirSync(dir);
	writeFileSync(join(dir, "journal.json"), JSON.stringify({committed:false,entries:[{target:"../outside",hadTarget:false}]}));
	expect(() => recoverBundleInstalls(root)).toThrow("目标无效"); originals(); rmSync(dir,{recursive:true});
	symlinkSync(join(root, "pi"), join(root, "claude-pkg"));
	await expect(installBundle(root,"pi",async work => { const staged=join(work,"file");writeFileSync(staged,"new");return ()=>[{target:"claude-pkg/claude-test",staged}]; })).rejects.toThrow("符号链接"); originals();
});
it("staging can finish while parent cancellation still prevents any live publication", async () => {
	const operations = new InstallOperations();
	const result = operations.run("cancel", signal => installBundle(root,"pi",async work => {
		await stageInstall(signal, async child => { await import("./install-operations.js").then(({sealInstall})=>sealInstall(child)); });
		expect(operations.cancel("cancel")).toBe(true); return build(work);
	},signal).then(()=>"done"),()=>"cancelled");
	expect(await result).toBe("cancelled"); originals(); expect(readdirSync(root)).toEqual(["pi"]);
});
