#!/usr/bin/env node
/**
 * Electron 冒烟测试：真实拉起应用（--pih-smoke），
 * 渲染进程经真实 IPC 链路完成自检并回报，主进程写结果文件后退出。
 *
 * 流程：
 * 1. （可跳过：PIH_SKIP_ABI=1）把 better-sqlite3 重建为 Electron ABI
 * 2. 启动 Electron，等待结果文件与退出码
 * 3. 校验结果：rendererBoot / ping / health.ok / steps 全绿
 * 4. 恢复 Node ABI（保证后续 pnpm test 可用）
 */
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const skipAbi = process.env["PIH_SKIP_ABI"] === "1";

const entry = path.join(root, "out", "main", "index.js");
const preloadEntry = path.join(root, "out", "preload", "index.cjs");
for (const f of [entry, preloadEntry]) {
	if (!existsSync(f)) {
		console.error(`✗ 缺少构建产物 ${path.relative(root, f)}，请先运行 pnpm build:desktop`);
		process.exit(2);
	}
}

function run(cmd, cwd) {
	execSync(cmd, { cwd, stdio: "inherit" });
}

if (!skipAbi) {
	console.log("▸ 重建 better-sqlite3 → Electron ABI …");
	run("npx electron-rebuild -f -w better-sqlite3", root);
}

const electronPath = require("electron");
const out = path.join(tmpdir(), `pih-smoke-${Date.now()}.json`);
const dataDir = mkdtempSync(path.join(tmpdir(), "pih-smoke-data-"));

console.log("▸ 启动 Electron 冒烟实例 …");
const child = spawn(electronPath, [".", "--pih-smoke"], {
	cwd: root,
	env: {
		...process.env,
		PIH_SMOKE_OUT: out,
		PIH_DATA_DIR: dataDir,
		PIH_ENABLE_FAUX: "1",
		ELECTRON_ENABLE_LOGGING: "1",
	},
	stdio: ["ignore", "inherit", "inherit"],
});

let killed = false;
const guard = setTimeout(() => {
	console.error("✗ 冒烟测试总超时（120s），强制结束");
	killed = true;
	child.kill("SIGKILL");
}, 120_000);

const code = await new Promise((resolve) => {
	child.on("exit", (c) => resolve(c ?? -1));
});

clearTimeout(guard);

let pass = false;
if (!existsSync(out)) {
	console.error(`✗ 未生成冒烟结果文件（Electron 退出码 ${code}${killed ? "，已超时强杀" : ""}）`);
	if (String(code) !== "0") {
		console.error("  提示：若上方日志出现 NODE_MODULE_VERSION 不匹配，说明原生模块 ABI 未重建。");
	}
} else {
	const report = JSON.parse(readFileSync(out, "utf8"));
	const health = report.health ?? null;
	const steps = health?.steps ?? [];

	console.log("── 冒烟结果 ──────────────────────");
	console.log(`  渲染进程启动 : ${report.rendererBoot ? "✓" : "✗"}`);
	console.log(`  IPC 往返 ping : ${report.ping === true ? "✓" : "✗"}`);
	const faux = report.faux ?? null;
	console.log(
		`  faux 全链路对话 : ${faux?.ok === true ? "✓" : "✗"}（文本 ${faux?.textChars ?? 0} 字符 · 工具 ${faux?.toolCalls ?? 0} 次）`,
	);
	if (faux?.error) console.log(`  faux 错误   : ${faux.error}`);
	console.log(`  健康报告     : ${health ? (health.ok ? "✓ 全绿" : "✗ 存在失败项") : "✗ 未获得"}`);
	for (const s of steps) {
		console.log(`    · ${s.ok ? "✓" : "✗"} ${s.name} — ${s.detail ?? ""}`);
	}
	if (report.error) console.log(`  渲染层错误   : ${report.error}`);
	console.log(`  应用版本     : ${health?.appVersion ?? "?"} · schema v${health?.schemaVersion ?? "?"}`);
	console.log("──────────────────────────────────");

	pass =
		report.ok === true &&
		report.rendererBoot === true &&
		report.ping === true &&
		report.faux?.ok === true &&
		health?.ok === true &&
		steps.length > 0 &&
		steps.every((s) => s.ok) &&
		code === 0;

	if (!pass && code !== 0) {
		console.error(`  Electron 退出码异常: ${code}`);
	}
}

try {
	rmSync(out, { force: true });
	rmSync(dataDir, { recursive: true, force: true });
} catch {
	/* 清理尽力而为 */
}

if (!skipAbi) {
	console.log("▸ 恢复 better-sqlite3 → Node ABI …");
	try {
		run("pnpm -r rebuild better-sqlite3", root);
	} catch (err) {
		console.error("⚠ Node ABI 恢复失败（后续 pnpm test 前请手动执行 pnpm rebuild）:", err.message);
		pass = false;
	}
}

console.log(pass ? "✅ 冒烟测试通过" : "❌ 冒烟测试失败");
process.exit(pass ? 0 : 1);
