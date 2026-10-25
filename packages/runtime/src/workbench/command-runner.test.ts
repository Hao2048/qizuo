import { it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorkbenchCommand } from "./command-runner.js";
it.skipIf(process.platform !== "darwin")(
  "kernel sandbox restricts role writes, private reads, environment, network and child processes",
  async () => {
    const base = mkdtempSync(join(tmpdir(), "pih-command-test-")),
      root = join(base, "role");
    mkdirSync(root);
    writeFileSync(join(root, "own.txt"), "old");
    writeFileSync(join(root, "peer.txt"), "peer");
    writeFileSync(join(base, "secret"), "secret");
    const run = (command: string, extra = {}) =>
      runWorkbenchCommand({
        root,
        command,
        owned: ["own.txt"],
        signal: new AbortController().signal,
        ...extra,
      });
    process.env.PIH_TEST_SECRET = "never-inherit";
    try {
      const ok = await run("printf new > own.txt; cat own.txt");
      expect(ok.code, ok.output).toBe(0);
      expect(readFileSync(join(root, "own.txt"), "utf8")).toBe("new");
      const stateDir=join(base,"private-home");
    expect((await run('printf cache > "$HOME/reuse"',{stateDir})).code).toBe(0);
    expect((await run('cat "$HOME/reuse"',{stateDir})).output).toBe("cache");
    const script = await run("node --version");
      expect(script.code, script.output).toBe(0);
      const link = await run("ln ../secret link.txt && cat link.txt", {
        owned: ["link.txt"],
      });
      expect(link.code).not.toBe(0);
      expect(link.output).not.toContain("secret");
      const local = await run(
        `node -e 'const h=require("node:http");const s=h.createServer((q,r)=>r.end("ok")).listen(0,"127.0.0.1",()=>h.get("http://127.0.0.1:"+s.address().port,r=>{r.resume();r.on("end",()=>{console.log("integration-ok");s.close()})}))'`,
        { loopback: true },
      );
      expect(local.code, local.output).toBe(0);
      expect(local.output).toContain("integration-ok");
      expect((await run("printf hacked > peer.txt")).code).not.toBe(0);
      expect(readFileSync(join(root, "peer.txt"), "utf8")).toBe("peer");
      expect((await run(`cat '${join(base, "secret")}'`)).code).not.toBe(0);
      expect((await run('printf "%s" "$PIH_TEST_SECRET"')).output).toBe("");
      expect(
        (await run("/usr/bin/curl --max-time 2 https://example.com")).code,
      ).not.toBe(0);
      const abort = new AbortController();
      const running = run("sleep 60 & wait", { signal: abort.signal });
      setTimeout(() => abort.abort(), 150);
      const result = await running;
      expect(result.cancelled).toBe(true);
      expect(result.durationMs).toBeLessThan(3000);
    } finally {
      delete process.env.PIH_TEST_SECRET;
      rmSync(base, { recursive: true, force: true });
    }
  },
);
