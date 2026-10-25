import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configurePackagedTools } from "./packaged-tools.js";

it("uses an existing unpacked executable only in packaged apps and preserves explicit overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "pih-packaged-tools-"));
  try {
    const dir = join(root, "app.asar.unpacked/node_modules/@esbuild", `${process.platform}-${process.arch}`, "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "esbuild"), "fixture");
    const env: NodeJS.ProcessEnv = {};
    let loads = 0;
    const load = () => { loads++; expect(env.ESBUILD_BINARY_PATH).toBe(join(dir, "esbuild")); expect(env.ESBUILD_WORKER_THREADS).toBe("0"); };
    configurePackagedTools(root, false, env, load);
    expect(env.ESBUILD_BINARY_PATH).toBeUndefined();
    expect(loads).toBe(0);
    configurePackagedTools(root, true, env, load);
    expect(loads).toBe(1);
    expect(env.ESBUILD_BINARY_PATH).toBeUndefined();
    expect(env.ESBUILD_WORKER_THREADS).toBeUndefined();
    env.ESBUILD_BINARY_PATH = "/custom/esbuild";
    configurePackagedTools(root, true, env, load);
    expect(env.ESBUILD_BINARY_PATH).toBe("/custom/esbuild");
    expect(loads).toBe(1);
    const missing: NodeJS.ProcessEnv = {};
    configurePackagedTools(join(root, "missing"), true, missing, load);
    expect(missing.ESBUILD_BINARY_PATH).toBeUndefined();
    missing.ESBUILD_WORKER_THREADS = "1";
    expect(() => configurePackagedTools(root, true, missing, () => { throw Error("load failed"); })).toThrow("load failed");
    expect(missing.ESBUILD_BINARY_PATH).toBeUndefined();
    expect(missing.ESBUILD_WORKER_THREADS).toBe("1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
