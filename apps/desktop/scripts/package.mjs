#!/usr/bin/env node
// Build -> isolated packaged smoke -> promote latest -> delete old output. A failed build never deletes the last usable app.
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promoteRelease } from "./release-files.mjs";
import { verifyPackagedRuntime } from "./verify-packaged-runtime.mjs";
const app = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = join(app, "release"),
  candidate = join(root, ".candidate-" + randomUUID());
const run = (args) =>
  new Promise((ok, no) => {
    const child = spawn("pnpm", args, { cwd: app, stdio: "inherit" });
    child.once("error", no);
    child.once("exit", (code) =>
      code === 0
        ? ok()
        : no(Error("命令退出码 " + code + ": pnpm " + args.join(" "))),
    );
  });
function ensureOldAppClosed() {
  const running = execFileSync("ps", ["-axo", "comm="], { encoding: "utf8" })
    .split("\n")
    .some(
      (line) =>
        line.trim().startsWith(root + "/") &&
        ["栖作","Pi Harness"].some(name=>line.trim().endsWith(".app/Contents/MacOS/"+name)),
    );
  if (running)
    throw Error("请先退出正在运行的 栖作，再打包；旧包尚未删除。");
}
async function verify() {
  const exe = join(
    candidate,
    "mac-arm64/栖作.app/Contents/MacOS/栖作",
  );
  if (!existsSync(exe)) throw Error("没有生成 macOS arm64 软件");
  const dir = mkdtempSync(join(tmpdir(), "pih-release-smoke-")),
    out = join(dir, "smoke.json");
  let child, timer;
  try {
    child = spawn(exe, ["--pih-smoke"], {
      env: {
        ...process.env,
        PIH_DATA_DIR: dir,
        PIH_SMOKE_OUT: out,
        PIH_ENABLE_FAUX: "1",
      },
      stdio: "ignore",
    });
    await new Promise((ok, no) => {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        no(Error("打包版检查超时，旧包保留"));
      }, 60000);
      child.once("error", no);
      child.once("exit", (code) =>
        code === 0 ? ok() : no(Error("打包版检查失败：" + code)),
      );
    });
    const report = JSON.parse(readFileSync(out, "utf8"));
    if (!report.ok || !report.health?.ok || !report.faux?.workbenchOk)
      throw Error("打包版检查未通过，旧包保留");
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null) child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
}
let promoted = false;
try {
  ensureOldAppClosed();
  mkdirSync(root, { recursive: true });
  await run(["exec", "electron-vite", "build"]);
  await run([
    "exec",
    "electron-builder",
    "--mac",
    ...(process.argv.includes("--dir") ? ["--dir"] : []),
    "--config.directories.output=" + candidate,
  ]);
  verifyPackagedRuntime(join(candidate, "mac-arm64/栖作.app"));
  await verify();
  ensureOldAppClosed();
  const result = promoteRelease(root, candidate);
  promoted = true;
  console.log(
    "已验证新包并清理旧产物：" +
      result.removed +
      " 项。软件：" +
      join(result.latest, "mac-arm64/栖作.app"),
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (!promoted) rmSync(candidate, { recursive: true, force: true });
  try {
    await run(["-r", "rebuild", "better-sqlite3"]);
  } catch (e) {
    console.error("恢复 Node SQLite 失败：" + e.message);
    process.exitCode = 1;
  }
}
