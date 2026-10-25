import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowedLarkAuthUrl, isLarkSource, MarketAuthService } from "./auth-service.js";
import type { MarketService } from "./market-service.js";
import { authorizeMcpServer, checkMcpServer } from "./mcp-authorization.js";
vi.mock("./mcp-authorization.js", () => ({ authorizeMcpServer: vi.fn(), checkMcpServer: vi.fn().mockResolvedValue("required") }));
import { McpService } from "../mcp/mcp-service.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); vi.unstubAllEnvs(); delete process.env.PIH_LARK_APP_SECRET; });
function fixture(installed = false) {
 const dir = mkdtempSync(join(tmpdir(), "pih-market-auth-")); dirs.push(dir);
 vi.stubEnv("LARKSUITE_CLI_CONFIG_DIR", dir);
 const open = vi.fn(); const mcp = new McpService(dir);
 const market = { listInstalled: () => ({ packages: installed ? [{ source: "npm:@amaster.ai/pi-lark@0.1.23", installedPath: dir }] : [] }) } as unknown as MarketService;
 return { dir, open, mcp, service: new MarketAuthService(market, mcp, dir, open) };
}
describe("market authentication", () => {
 it("recognizes versioned Lark packages and rejects fake authorization hosts", () => {
 expect(isLarkSource("npm:@amaster.ai/pi-lark@0.1.23")).toBe(true);
 expect(isLarkSource("npm:@evil/pi-lark")).toBe(false);
 expect(allowedLarkAuthUrl("https://accounts.feishu.cn/device?code=abc")).toBe(true);
 expect(allowedLarkAuthUrl("https://open.larksuite.com/oauth")).toBe(true);
 expect(allowedLarkAuthUrl("https://feishu.cn.evil.com/login")).toBe(false);
 expect(allowedLarkAuthUrl("http://feishu.cn/login")).toBe(false);
 });
 it("reports token requirements without returning secret values and refreshes after saving", () => {
 const { service, mcp } = fixture(); const key = "PIH_TEST_GH_TOKEN"; delete process.env[key];
 mcp.add({ name: "github", url: "https://example.org/mcp", headers: { Authorization: `Bearer \u0024{${key}}` }, description: "来自官方插件 github" });
 expect(service.info("claude:github").status).toBe("required");
 mcp.setCredential(key, "secret-never-rendered");
 const result = service.info("claude:github"); expect(result.status).toBe("ready"); expect(result.kind).toBe("token");
 expect(JSON.stringify(result)).not.toContain("secret-never-rendered"); mcp.clearCredential(key);
 });
 it("cannot authorize uninstalled Lark package", () => {
 const { service, open } = fixture(); expect(service.start("npm:@amaster.ai/pi-lark").status).toBe("error"); expect(open).not.toHaveBeenCalled(); service.dispose();
 });
 it("Lark setup and login open approved browser URLs, reuse active authorization and sync protected settings", async () => {
 const { dir, service, open } = fixture(true);
 vi.stubEnv("LARKSUITE_CLI_CONFIG_DIR", dir);
 const binDir = join(dir, "node_modules", ".bin"); mkdirSync(binDir, { recursive: true });
 writeFileSync(join(binDir,"lark-cli"), `#!/bin/sh
if [ "$1" = "config" ]; then
 printf '%s' '{"apps":[{"appId":"app123","appSecret":"private-lark-secret","brand":"feishu"}]}' > "$LARKSUITE_CLI_CONFIG_DIR/config.json"
 printf '%s\\n' 'https://open.feishu.cn/setup?code=test' 'https://feishu.cn.evil.com/steal' 'private-lark-secret'
elif [ "$2" = "status" ]; then
 if [ -f "$LARKSUITE_CLI_CONFIG_DIR/logged-in" ]; then
  printf '%s' '{"identities":{"user":{"available":true,"tokenStatus":"valid"}}}'
 else
  printf '%s' '{"identities":{"user":{"available":false}}}'
 fi
else
 touch "$LARKSUITE_CLI_CONFIG_DIR/logged-in"
 printf '%s\\n' 'https://accounts.feishu.cn/auth?code=test'
fi
`, { mode: 0o755 });
 const first = service.start("npm:@amaster.ai/pi-lark"); expect(first.status).toBe("working"); expect(service.start(first.source).status).toBe("working");
 expect(service.start("npm:@amaster.ai/pi-lark@0.1.23").status).toBe("working");
 await vi.waitFor(() => expect(service.info(first.source)).toMatchObject({ status: "ready" }), { timeout: 5000 });
 expect(open.mock.calls.map(x => x[0])).toEqual(["https://open.feishu.cn/setup?code=test", "https://accounts.feishu.cn/auth?code=test"]);
 const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
 expect(settings["pi-lark"]).toMatchObject({ appId: "app123", appSecret: "${PIH_LARK_APP_SECRET}" });
 expect(JSON.stringify(service.info(first.source))).not.toContain("private-lark-secret"); service.dispose();
 });
 it("remote MCP without static tokens uses SDK browser authorization and redacts failures", async () => {
 const { service, mcp } = fixture(); mcp.add({ name: "linear", url: "https://mcp.linear.app/mcp", description: "来自官方插件 linear" });
 expect(service.info("claude:linear")).toMatchObject({ kind: "oauth", status: "required" });
 vi.mocked(authorizeMcpServer).mockImplementationOnce(async (_name, options) => { options.openUrl("https://linear.app/oauth/authorize?code=test"); return 0; });
 expect(service.start("claude:linear").status).toBe("working");
 await vi.waitFor(() => expect(service.info("claude:linear").status).toBe("ready"));
 expect(authorizeMcpServer).toHaveBeenCalledWith("linear", expect.objectContaining({ agentDir: mcp.path.replace(/\/mcp.json$/, "") }));
 vi.mocked(authorizeMcpServer).mockRejectedValueOnce(new Error("sensitive-secret"));
 service.start("claude:linear"); await vi.waitFor(() => expect(service.info("claude:linear").status).toBe("error"));
 expect(JSON.stringify(service.info("claude:linear"))).not.toContain("sensitive-secret"); service.dispose();
 });
});

it("OAuth client secrets do not incorrectly mark browser authorization as complete", async () => {
 const { service, mcp } = fixture(); const key="PIH_TEST_OAUTH_SECRET"; delete process.env[key];
 mcp.add({ name: "custom", url: "https://example.org/mcp", description: "来自官方插件 custom", oauth: { clientId: "known-client", clientSecret: `\u0024{${key}}` } });
 expect(service.info("claude:custom")).toMatchObject({ kind: "token", status: "required" });
 mcp.setCredential(key,"fake-secret");
 expect(service.info("claude:custom")).toMatchObject({ kind: "oauth", status: "required" });
 vi.mocked(authorizeMcpServer).mockResolvedValueOnce(0);
 service.start("claude:custom");
 await vi.waitFor(() => expect(service.info("claude:custom").status).toBe("ready"));
 mcp.clearCredential(key);
 expect(service.info("claude:custom")).toMatchObject({ kind: "token", status: "required" });
 service.dispose();
});

function statusFixture(valid = true) {
 const f = fixture(true); const binDir = join(f.dir, "node_modules", ".bin"); mkdirSync(binDir, { recursive: true });
 const path = join(binDir, "lark-cli");
 writeFileSync(path, `#!/bin/sh
if [ "$2" = "status" ]; then
 cat "$LARKSUITE_CLI_CONFIG_DIR/status.json"
else
 echo 'private-token-should-not-render' >&2
 exit 1
fi
`, { mode: 0o755 });
 writeFileSync(join(f.dir,"status.json"), JSON.stringify({ identities: { user: { available: valid, tokenStatus: valid ? "valid" : "expired" } } }));
 writeFileSync(join(f.dir,"config.json"), JSON.stringify({ apps: [{ appId:"app123", appSecret:"private-secret", users:[{ userOpenId:"saved-user" }] }] }));
 return f;
}
it("restores verified CLI authorization after restarting without reopening the browser", async () => {
 const { service, open } = statusFixture();
 expect(await service.refresh("npm:@amaster.ai/pi-lark")).toMatchObject({ status:"ready" });
 expect(await service.refresh("npm:@amaster.ai/pi-lark@0.1.23")).toMatchObject({ status:"ready" });
 expect(open).not.toHaveBeenCalled(); service.dispose();
});
it("recovers a failed attempt when the CLI later reports browser authorization complete", async () => {
 const { dir, service } = statusFixture(false); const source="npm:@amaster.ai/pi-lark";
 service.start(source);
 await vi.waitFor(() => expect(service.info(source).status).toBe("error"), { timeout: 5000 });
 expect(JSON.stringify(service.info(source))).not.toContain("private-token");
 writeFileSync(join(dir,"status.json"), JSON.stringify({ identities:{ user:{ available:true,tokenStatus:"valid" } } }));
 expect(await service.refresh(source)).toMatchObject({ status:"ready" }); service.dispose();
});
it("does not treat saved app configuration or user records as valid authorization", async () => {
 const { service } = statusFixture(false);
 expect(await service.refresh("npm:@amaster.ai/pi-lark")).toMatchObject({ status:"required" }); service.dispose();
});
it("uses the official native binary when node is absent from the desktop PATH", async () => {
 const { dir, service, open } = statusFixture();
 const cliDir=join(dir,"node_modules","@larksuite","cli");
 mkdirSync(join(cliDir,"scripts"),{recursive:true}); mkdirSync(join(cliDir,"bin"),{recursive:true});
 const wrapper=join(dir,"node_modules",".bin","lark-cli");
 rmSync(wrapper);
 const { symlinkSync } = await import("node:fs");
 writeFileSync(join(cliDir,"scripts","run.js"),"#!/usr/bin/env node\nprocess.exit(1)",{mode:0o755});
 symlinkSync(join(cliDir,"scripts","run.js"),wrapper);
 writeFileSync(join(cliDir,"bin","lark-cli"), `#!/bin/sh
printf '%s' '{"identities":{"user":{"available":true,"tokenStatus":"valid"}}}'`, {mode:0o755});
 vi.stubEnv("PATH","/usr/bin:/bin");
 expect(await service.refresh("npm:@amaster.ai/pi-lark")).toMatchObject({status:"ready"});
 expect(open).not.toHaveBeenCalled(); service.dispose();
});

it("checks a reused grant immediately after discovering browser authentication", async () => {
 const { service, mcp, open } = fixture();
 const source = "claude:discover";
 const server = { name: "discover", url: "https://example.org/mcp", description: "来自官方插件 discover" };
 mcp.add({ ...server, headers: { Authorization: "Bearer ${PIH_DISCOVERY_TOKEN}" } });
 vi.spyOn(mcp, "prepareBrowserAuth").mockImplementationOnce(async () => { mcp.upsert(server); return true; });
 vi.mocked(checkMcpServer).mockResolvedValueOnce("ready");
 const result = await service.refresh(source);
 expect(result).toMatchObject({ kind: "oauth", status: "ready" });
 expect(checkMcpServer).toHaveBeenCalledWith("discover", mcp.path.replace(/\/mcp.json$/, ""));
 expect(open).not.toHaveBeenCalled(); service.dispose();
});
