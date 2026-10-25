import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { safePath } from "./workspace.js";
export type CommandResult = {
  code: number | null;
  output: string;
  durationMs: number;
  cancelled: boolean;
};
const quote = (s: string) => JSON.stringify(s);
/** No fallback to an unrestricted shell. Credentials and the host HOME never enter the child. */
export async function runWorkbenchCommand(opts: {
  root: string;
  command: string;
  owned: string[];
  signal: AbortSignal;
  network?: boolean;
  loopback?: boolean;
  stateDir?: string;
}): Promise<CommandResult> {
  opts.signal.throwIfAborted();
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    throw new Error("此系统尚无可用的工作台命令沙箱，已拒绝执行");
  if (!opts.command.trim() || opts.command.length > 8000)
    throw new Error("命令不能为空或超过 8000 字符");
  const root = realpathSync(opts.root);
  // Resolve only a Node distribution, never grant the whole user bin directory or shell environment.
  const toolchains: string[] = [];
  for (const bin of (process.env.PATH ?? "").split(":"))
    try {
      const executable = realpathSync(join(bin, "node")),
        distribution = dirname(dirname(executable));
      if (
        basename(dirname(executable)) === "bin" &&
        (/^node-v\d+\.\d+\.\d+$/.test(basename(distribution)) ||
          /[/\\](?:\.nvm[/\\]versions[/\\]node|\.volta[/\\]tools[/\\]image[/\\]node)[/\\]v?\d/.test(
            distribution,
          ))
      ) {
        toolchains.push(distribution);
        break;
      }
    } catch {}

  const paths = opts.owned.map((p) => safePath(root, p));
  let privateHome: string | undefined;
  if (opts.stateDir) {
    const state = safePath(dirname(opts.stateDir), basename(opts.stateDir));
    mkdirSync(state, { recursive: true, mode: 0o700 });
    privateHome = realpathSync(state);
  }
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "pih-exec-")));
  const home = privateHome ?? temp;
  const profile = join(temp, "policy.sb");
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-read* file-write* network* signal appleevent-send process-info* mach-lookup)",
    ' (allow file-read-metadata) (allow file-read-data (literal "/"))',
    ...[
      "/usr",
      "/bin",
      "/sbin",
      "/System",
      "/Library/Apple",
      "/Library/Developer",
      "/opt/homebrew",
      "/dev",
      "/private/etc/ssl",
      "/private/etc/localtime",
    ].map((p) => `(allow file-read* (subpath ${quote(p)}))`),
    `(allow file-read* (subpath ${quote(root)}))`,
    `(allow file-read* file-write* (subpath ${quote(temp)}))`,
    `(allow file-read* file-write* (subpath ${quote(home)}))`,
    `(deny file-read* file-write* (literal ${quote(profile)}))`,
    '(allow file-write* (literal "/dev/null"))',
    "(allow signal (target same-sandbox)) (allow process-info* (target self))",
    '(allow mach-lookup (global-name "com.apple.system.notification_center") (global-name "com.apple.system.opendirectoryd.libinfo"))',
    '(allow file-read* (literal "/private/etc/passwd") (literal "/private/etc/group") (literal "/private/etc/hosts") (literal "/private/var/run/resolv.conf"))',

    ...toolchains.map((p) => `(allow file-read* (subpath ${quote(p)}))`),
    ...paths.map((p) => `(allow file-write* (subpath ${quote(p)}))`),
    ...(opts.loopback
      ? [
          '(allow network-bind network-inbound (local ip "localhost:*")) (allow network-outbound (remote ip "localhost:*"))',
        ]
      : []),
    ...(opts.network
      ? [
          '(allow network-outbound) (allow mach-lookup (global-name "com.apple.mDNSResponder") (global-name "com.apple.trustd"))',
        ]
      : []),
  ];
  const started = Date.now();
  try {
    writeFileSync(profile, lines.join("\n"), { mode: 0o600 });
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(
        "/usr/bin/sandbox-exec",
        [
          "-f",
          profile,
          "/bin/bash",
          "--noprofile",
          "--norc",
          "-c",
          opts.command,
        ],
        {
          cwd: root,
          detached: true,
          env: {
            PATH: [
              ...toolchains.map((p) => join(p, "bin")),
              "/opt/homebrew/bin",
              "/usr/local/bin",
              "/usr/bin",
              "/bin",
              "/usr/sbin",
              "/sbin",
            ].join(":"),
            HOME: home,
            TMPDIR: temp,
            TMP: temp,
            TEMP: temp,
            LANG: "en_US.UTF-8",
            CI: "1",
            npm_config_cache: join(home, "npm"),
            npm_config_update_notifier: "false",
            GIT_CONFIG_NOSYSTEM: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "",
        cancelled = false;
      const kill = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
      };
      const cancel = () => {
        cancelled = true;
        kill();
      };
      const collect = (data: Buffer) => {
        output = (output + data.toString("utf8")).slice(-24000);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      opts.signal.addEventListener("abort", cancel, { once: true });
      if (opts.signal.aborted) cancel();
      const cleanup = () => {
        opts.signal.removeEventListener("abort", cancel);
        kill();
      };
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.on("close", (code, signal) => {
        cleanup();
        if (signal) output += `\n进程终止：${signal}`;
        resolve({ code, output, durationMs: Date.now() - started, cancelled });
      });
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
