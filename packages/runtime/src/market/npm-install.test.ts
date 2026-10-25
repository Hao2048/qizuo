import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MarketService } from "./market-service.js";
import { Logger } from "../logging/logger.js";
import { InstallOperations } from "./install-operations.js";

let root: string;
let agent: string;
let npm: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pih-npm-tx-"));
	agent = join(root, "pi"); npm = join(agent, "npm");
	mkdirSync(agent);
	const command = join(root, "npm.cjs");
	// Exercise the actual SDK command, prefix selection and settings persistence offline.
	writeFileSync(command, `const fs=require('node:fs'),p=require('node:path');
const args=process.argv.slice(2),root=args[args.indexOf('--prefix')+1];
fs.mkdirSync(p.join(root,'node_modules'),{recursive:true});
const shared=p.join(root,'node_modules','shared.txt');
fs.writeFileSync(fs.existsSync(p.join(root,'node_modules','bin'))?p.join(root,'node_modules','bin'):shared,'updated');
fs.writeFileSync(p.join(root,'package-lock.json'),'updated lock');
if(args.includes('slow')) {
 const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'late'),1500);setInterval(()=>{},50)",p.join(p.dirname(__filename),'late.txt')],{stdio:'inherit'});
 process.on('SIGTERM',()=>{});fs.writeFileSync(p.join(p.dirname(__filename),'started'),String(child.pid));setInterval(()=>{},50);return;
}
if(args.includes('bad'))process.exit(1);
fs.writeFileSync(p.join(root,'node_modules',args[1]+'.txt'),'installed');`);
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ npmCommand: [process.execPath, command], packages: [] }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const service = () => MarketService.create({ cwd: root, agentDir: agent, logger: new Logger(), emit: () => {}, getVisibility: () => "public", setVisibilityRow: () => {} });
function existing() {
	mkdirSync(join(npm, "node_modules"), { recursive: true });
	writeFileSync(join(npm, "node_modules", "shared.txt"), "original");
	writeFileSync(join(npm, "package-lock.json"), "original lock");
	symlinkSync(join(npm, "node_modules", "shared.txt"), join(npm, "node_modules", "bin"));
}
const packages = () => JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).packages;

it("failed install preserves shared dependencies, lockfile, symlink target and declarations", async () => {
	existing(); const svc = await service();
	expect((await svc.installFromNpm("bad")).ok).toBe(false);
	expect(readFileSync(join(npm, "node_modules", "shared.txt"), "utf8")).toBe("original");
	expect(readFileSync(join(npm, "package-lock.json"), "utf8")).toBe("original lock");
	expect(packages()).toEqual([]);
	expect(readdirSync(agent).some(x => x.startsWith(".pih-install-"))).toBe(false);
});
it("successful queued installs preserve previous packages and publish usable internal links", async () => {
	existing(); const svc = await service();
	const results = await Promise.all([svc.installFromNpm("one"), svc.installFromNpm("two")]);
	expect(results).toEqual([{ ok: true }, { ok: true }]);
	expect(packages()).toEqual(["npm:one", "npm:two"]);
	expect(existsSync(join(npm, "node_modules", "one.txt"))).toBe(true);
	expect(existsSync(join(npm, "node_modules", "two.txt"))).toBe(true);
	expect(readFileSync(join(npm, "node_modules", "bin"), "utf8")).toBe("updated");
	expect(readdirSync(agent).some(x => x.startsWith(".pih-install-"))).toBe(false);
});
it("first-install failure leaves no partial npm directory or declaration", async () => {
	const svc = await service(); expect((await svc.installFromNpm("bad")).ok).toBe(false);
	expect(existsSync(npm)).toBe(false); expect(packages()).toEqual([]);
});
it("refuses externally linked dependencies before an installer can modify them", async () => {
	existing(); const outside = join(root, "external.txt"); writeFileSync(outside, "keep");
	symlinkSync(outside, join(npm, "node_modules", "external"));
	const svc = await service(); const result = await svc.installFromNpm("one");
	expect(result.ok).toBe(false); expect(result.message).toContain("外部链接");
	expect(readFileSync(outside, "utf8")).toBe("keep"); expect(packages()).toEqual([]);
});

it("cancellation kills npm and its script process before cleaning staging; another queued install survives", async () => {
	existing(); const svc = await service(); const operations = new InstallOperations();
	const cancelled = () => ({ ok: false, message: "已取消安装" });
	const first = operations.run("slow", signal => svc.installFromNpm("slow", signal), cancelled);
	await vi.waitFor(() => expect(existsSync(join(root, "started"))).toBe(true));
	const queued = operations.run("next", signal => svc.installFromNpm("next", signal), cancelled);
	expect(operations.cancel("slow")).toBe(true);
	expect(await first).toEqual(cancelled());
	expect(await queued).toEqual({ ok: true });
	expect(packages()).toEqual(["npm:next"]);
	const pid = Number(readFileSync(join(root, "started"), "utf8"));
	await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
	expect(existsSync(join(root, "late.txt"))).toBe(false);
	expect(readdirSync(agent).some(x => x.startsWith(".pih-install-"))).toBe(false);
	expect(operations.cancel("slow")).toBe(false);
});

it("an install cancelled while queued never executes or changes declarations", async () => {
	const svc = await service(); const operations = new InstallOperations();
	const cancelled = () => ({ ok: false, message: "已取消安装" });
	const first = operations.run("slow", signal => svc.installFromNpm("slow", signal), cancelled);
	await vi.waitFor(() => expect(existsSync(join(root, "started"))).toBe(true));
	const queued = operations.run("queued", signal => svc.installFromNpm("never", signal), cancelled);
	expect(operations.cancel("queued")).toBe(true); expect(operations.cancel("slow")).toBe(true);
	await first; expect(await queued).toEqual(cancelled());
	expect(packages()).toEqual([]); expect(existsSync(npm)).toBe(false);
});

it("updates matching versions and preserves package filters plus edits made during download", async () => {
	const path=join(agent,"settings.json"),initial=JSON.parse(readFileSync(path,"utf8"));
	writeFileSync(path,JSON.stringify({...initial,packages:[{source:"npm:one@1",skills:["./review"]}]}));
	const svc=await MarketService.create({cwd:root,agentDir:agent,logger:new Logger(),getVisibility:()=>"public",setVisibilityRow:()=>{},emit:()=>{
		const current=JSON.parse(readFileSync(path,"utf8"));writeFileSync(path,JSON.stringify({...current,customSetting:"latest"}));
	}});
	expect(await svc.installFromNpm("one@2")).toEqual({ok:true});
	const current=JSON.parse(readFileSync(path,"utf8"));expect(current.customSetting).toBe("latest");
	expect(current.packages).toEqual([{source:"npm:one@2",skills:["./review"]}]);
});
