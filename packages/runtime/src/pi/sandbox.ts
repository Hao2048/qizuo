/**
 * bash 工具的 macOS 系统级沙箱（Seatbelt / sandbox-exec）。
 * 原理：pi 的 bash 工具 shell 可经 settings.shellPath 指向 wrapper，
 * wrapper 用 sandbox-exec -f <profile> 包住 /bin/bash——命令执行被内核强制约束：
 * - read_only：全盘只读（临时目录可写，网络允许）
 * - workspace_write：工作区与临时目录可写，其余只读（网络允许）
 * write/edit 工具不经 shell，仍由审批策略 + 检查点管控。
 *
 * 隔离与注入防护：
 * - profile/wrapper 按 mode+cwd 哈希独立命名：不同任务的工作区互不覆盖、互不可写。
 * - 路径进入 SBPL（双引号字符串，转义 " 与 \）与 shell（单引号，转义 ' 与 \）前均做转义。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SandboxMode = "read_only" | "workspace_write";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const REAL_BASH = "/bin/bash";

/** seatbelt 按真实路径匹配（macOS 的 /var 实为 /private/var 符号链接，需解析）。 */
function realPath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** SBPL 字符串字面量转义（profile 里路径出现在 "…" 内）。 */
function sbplEscape(p: string): string {
	return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** shell 单引号转义（' → '\''）。 */
function shellEscape(p: string): string {
	return `'${p.replace(/'/g, `'\\''`)}'`;
}

function profileFor(mode: SandboxMode, cwd: string): string {
	const lines = [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		// 命令重定向与运行时需要的标准设备
		'(allow file-write* (literal "/dev/null"))',
		'(allow file-write* (literal "/dev/dtracehelper"))',
		`(allow file-write* (subpath "${sbplEscape(realPath(tmpdir()))}"))`,
	];
	if (mode === "workspace_write") {
		lines.push(`(allow file-write* (subpath "${sbplEscape(realPath(cwd))}"))`);
	}
	return `${lines.join("\n")}\n`;
}

function writeIfChanged(path: string, content: string): void {
	if (existsSync(path) && readFileSync(path, "utf8") === content) return;
	writeFileSync(path, content, "utf8");
}

/**
 * 生成（或复用）沙箱 wrapper，返回应写入 settings.shellPath 的路径。
 * 按 mode+cwd 哈希独立存放：多任务不同工作区互不覆盖；幂等复用。
 */
export function ensureBashSandbox(opts: { dir: string; mode: SandboxMode; cwd: string }): string | null {
	if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return null;
	const dir = join(opts.dir, "sandbox");
	mkdirSync(dir, { recursive: true });
	const key = createHash("sha256").update(`${opts.mode}\0${realPath(opts.cwd)}`).digest("hex").slice(0, 16);
	const profilePath = join(dir, `${opts.mode}-${key}.sb`);
	writeIfChanged(profilePath, profileFor(opts.mode, opts.cwd));
	const wrapperPath = join(dir, `bash-wrapper-${opts.mode}-${key}.sh`);
	writeIfChanged(
		wrapperPath,
		`#!/bin/bash\n# Pi Harness 沙箱 wrapper（由应用生成，档位=${opts.mode}）\nexec ${shellEscape(SANDBOX_EXEC)} -f ${shellEscape(profilePath)} ${shellEscape(REAL_BASH)} "$@"\n`,
	);
	try {
		chmodSync(wrapperPath, 0o755);
	} catch {
		/* chmod 失败将由后续执行暴露 */
	}
	return wrapperPath;
}
