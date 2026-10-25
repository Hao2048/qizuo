/**
 * MCP 令牌凭据闭环：${VAR} 占位符检测 → 配置（0600 落盘 + 注入进程环境）→ 重启回填 → 清除。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpService } from "./mcp-service.js";

const VAR = "PIH_TEST_GITHUB_TOKEN";
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pih-mcpauth-"));
	delete process.env[VAR];
});

afterEach(() => {
	delete process.env[VAR];
	rmSync(dir, { recursive: true, force: true });
});

describe("McpService 令牌凭据", () => {
	it("${VAR} 检测：headers/env/url/args 中的占位符进 authVars，未配置进 missingVars", () => {
		const svc = new McpService(dir);
		svc.add({
			name: "github",
			url: "https://api.example.com/mcp/",
			headers: { Authorization: `Bearer \${${VAR}}` },
		});
		const s = svc.list().find((x) => x.name === "github")!;
		expect(s.authVars).toEqual([VAR]);
		expect(s.missingVars).toEqual([VAR]);
	});

	it("配置令牌：落盘 0600 + 注入 process.env，missingVars 清空", () => {
		const svc = new McpService(dir);
		svc.add({ name: "github", url: "https://x/mcp/", headers: { Authorization: `Bearer \${${VAR}}` } });

		const r = svc.setCredential(VAR, "tok-123");
		expect(r.ok).toBe(true);
		expect(process.env[VAR]).toBe("tok-123");
		expect(svc.list().find((x) => x.name === "github")!.missingVars).toEqual([]);

		const credFile = join(dir, "mcp-credentials.json");
		expect(existsSync(credFile)).toBe(true);
		expect((statSync(credFile).mode & 0o777)).toBe(0o600);
		expect(JSON.parse(readFileSync(credFile, "utf8"))[VAR]).toBe("tok-123");
	});

	it("重启回填：新实例构造时把已存凭据注入进程环境", () => {
		const svc = new McpService(dir);
		svc.setCredential(VAR, "tok-abc");
		delete process.env[VAR];

		const revived = new McpService(dir);
		expect(process.env[VAR]).toBe("tok-abc");
		expect(revived.list()).toEqual([]); // 凭据文件与服务配置独立：未配服务器不影响凭据回填
	});

	it("清除令牌：文件与进程环境都移除，missingVars 复现", () => {
		const svc = new McpService(dir);
		svc.add({ name: "github", url: "https://x/mcp/", headers: { Authorization: `Bearer \${${VAR}}` } });
		svc.setCredential(VAR, "tok-xyz");

		expect(svc.clearCredential(VAR)).toBe(true);
		expect(process.env[VAR]).toBeUndefined();
		expect(svc.list().find((x) => x.name === "github")!.missingVars).toEqual([VAR]);
		expect(svc.clearCredential(VAR)).toBe(false);
	});

	it("非法输入拒绝：坏变量名 / 空令牌", () => {
		const svc = new McpService(dir);
		expect(svc.setCredential("1bad-name", "x").ok).toBe(false);
		expect(svc.setCredential(VAR, "   ").ok).toBe(false);
	});
});

it("publishes all servers together and preserves prior configuration when any entry is invalid",()=>{
 const svc=new McpService(dir);svc.upsert({name:"existing",url:"https://old.example/mcp"});const before=readFileSync(svc.path,"utf8");
 expect(()=>svc.upsertMany([{name:"valid",url:"https://example.com/mcp"},{name:"invalid"}])).toThrow();expect(readFileSync(svc.path,"utf8")).toBe(before);
 expect(()=>svc.upsertMany([{name:"same",url:"https://a.example"},{name:"same",url:"https://b.example"}])).toThrow("重复");expect(readFileSync(svc.path,"utf8")).toBe(before);
 svc.upsertMany([{name:"one",url:"https://a.example"},{name:"two",command:"test",args:["safe"]}]);expect(svc.list().map(s=>s.name)).toEqual(["existing","one","two"]);expect(statSync(svc.path).mode & 0o777).toBe(0o600);
});

it("does not overwrite malformed server configuration through add or upsert and remains readable",async()=>{
 const {writeFileSync}=await import('node:fs');const svc=new McpService(dir);
 for(const original of ['{"mcpServers":', 'null','[]','{"mcpServers":{"broken":null}}']){
  writeFileSync(svc.path,original);expect(()=>svc.list()).not.toThrow();
  expect(()=>svc.add({name:'new',url:'https://example.com/mcp'})).toThrow();expect(readFileSync(svc.path,'utf8')).toBe(original);
  expect(()=>svc.upsert({name:'new',url:'https://example.com/mcp'})).toThrow();expect(readFileSync(svc.path,'utf8')).toBe(original);
 }
});
it("preserves damaged credentials when a new credential is entered, without changing the environment",async()=>{
 const {writeFileSync}=await import('node:fs');const svc=new McpService(dir),path=join(dir,'mcp-credentials.json');
 for(const original of ['{"EXISTING":','null','[]','{"EXISTING":42}']){
  writeFileSync(path,original);delete process.env[VAR];
  expect(()=>svc.setCredential(VAR,'test-only-placeholder')).toThrow();expect(readFileSync(path,'utf8')).toBe(original);expect(process.env[VAR]).toBeUndefined();
 }
});
