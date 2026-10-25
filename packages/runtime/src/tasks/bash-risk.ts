/**
 * bash 命令敏感度分级：高敏命令需人工审批，其余自动放行（用户明确要求减少弹窗）。
 * 防绕过设计（经 25 条对抗用例回归）：
 * - 引号感知拆分：'a && rm b' 里的 && 不拆段、不当命令
 * - wrapper 剥离：env/command/nohup/time/nice/xargs/exec 与前导标点（( { \）剥掉再取首词
 * - shell 解释强判：sh/bash/zsh -c、source、eval、$(…)、反引号、find -delete/-exec 一律高敏
 * 未知命令默认放行；识别到的危险宁可多问。
 */

/** 单段命令首词命中即视为高敏 */
const RISKY_HEAD = new Set([
	// 提权 / 破坏
	"sudo",
	"rm",
	"rmdir",
	"dd",
	"mkfs",
	"shred",
	"truncate",
	"shutdown",
	"reboot",
	"halt",
	"kill",
	"pkill",
	"killall",
	// macOS 系统配置 / 权限
	"launchctl",
	"defaults",
	"osascript",
	"tccutil",
	"security",
	"diskutil",
	"csrutil",
	"spctl",
	"pmset",
	"nvram",
	"dscl",
	"chmod",
	"chown",
	"chflags",
	"mount",
	"umount",
	"fsck",
	// 系统级包管理
	"brew",
	"apt",
	"apt-get",
	"yum",
	"dnf",
	"pacman",
	"port",
	// 脚本解释入口（可执行任意串）
	"eval",
]);

/** 段首的 wrapper 命令：剥掉（连同其参数中的赋值/选项）后再取真实首词 */
const WRAPPERS = new Set(["env", "command", "nohup", "time", "nice", "xargs", "exec"]);

/** 命令任意位置命中即视为高敏（发布 / git 破坏性 / 远程执行 / 定向删除） */
const RISKY_PATTERNS: RegExp[] = [
	/\b(npm|pnpm|yarn|cargo)\s+publish\b/,
	/\bgit\s+push\b[^\n]*\s(--force\b|--force-with-lease\b|-f\b)/,
	/\bgit\s+push\b[^\n]*\s\+[A-Za-z0-9_\/.-]+\s*$/, // git push origin +main（旧式强推）
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\b[^\n]*(-[a-zA-Z]*f|-fd\b)/,
	/\bgit\s+filter-branch\b/,
	/\bgit\s+reflog\s+expire\b/,
	/\bgit\s+branch\s+-D\b/,
	/\bgit\s+checkout\s+--(\s|$)/,
	// 下载即执行：同一条命令里出现下载器 + shell/解释器（管道、&& 或 -o 落盘再执行）
	/(curl|wget)[^;&\n]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/,
	/(curl|wget)[^;&\n]*\|\s*(sudo\s+)?(python3?|node)\b/,
	/(curl|wget)\b[^\n]*&&[^\n]*\b(ba|z|fi)?sh\s+\S+/,
	// 命令替换 / 反引号：字符串里嵌了要执行的命令，无法静态分析 → 一律高敏
	/\$\([^)]*\)/,
	/`[^`]*`/,
	// find 的删除/执行动作
	/\bfind\b[^\n]*\s-delete\b/,
	/\bfind\b[^\n]*\s-exec\b/,
	/\bfind\b[^\n]*\s-execdir\b/,
	/\bfind\b[^\n]*\s-ok\b/,
	// 重定向 / tee 写系统目录（var/private 除外——macOS 用户临时目录在 /var/folders 下）
	/[>&|]+\s*\/(etc|usr|bin|sbin|System|Library|private\/etc)(\/|\s|$)/,
	/\btee\s+\/(etc|usr|bin|sbin|System|Library|private\/etc)(\/|\s|$)/,
];

/** 引号感知拆分：只在未引用的分隔符处切开（&& || ; | 换行），引号内原样保留。 */
function splitSegments(command: string): string[] {
	const out: string[] = [];
	let cur: string[] = [];
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				cur.push(ch, command[++i]!);
				continue;
			}
			if (ch === quote) quote = null;
			cur.push(ch);
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			cur.push(ch);
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			// 反斜杠转义下一字符（也覆盖 \rm 形式）
			cur.push(ch, command[i + 1]!);
			i++;
			continue;
		}
		const two = command.slice(i, i + 2);
		const isSep = ch === "\n" || ch === ";" || ch === "|" || ch === "&" || two === "&&" || two === "||";
		if (isSep) {
			out.push(cur.join(""));
			cur = [];
			if (two === "&&" || two === "||") i++;
			continue;
		}
		cur.push(ch);
	}
	out.push(cur.join(""));
	return out;
}

/** Shell words：保留引号内空格为同一参数，拼接引号片段并解析反斜杠。 */
function shellWords(segment: string): string[] {
	const words: string[] = [];
	let word = "",
		quote: string | null = null,
		started = false;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i]!;
		if (ch === "\\" && quote !== "'" && i + 1 < segment.length) {
			word += segment[++i];
			started = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else word += ch;
			started = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started) words.push(word);
			word = "";
			started = false;
		} else {
			word += ch;
			started = true;
		}
	}
	if (quote) return ["eval"]; // 无法可靠分析的语法需确认
	if (started) words.push(word);
	return words;
}

/** 剥离 wrapper 时同时消费选项的操作数，避免把 -n 1 中的 1 当命令。 */
function headWord(segment: string): string {
	let words = shellWords(segment.trim().replace(/^[({\s]+/, ""));
	while (words.length > 1 && /^\w+=/.test(words[0]!)) words.shift();
	const operands = new Set([
		"-n",
		"--adjustment",
		"-u",
		"--unset",
		"-C",
		"--chdir",
		"-I",
		"-L",
		"-P",
		"-s",
		"--max-args",
		"--replace",
		"--max-lines",
		"--max-procs",
		"--max-chars",
	]);
	while (words.length > 1 && WRAPPERS.has(words[0]!.split("/").pop()!)) {
		const wrapper = words.shift()!.split("/").pop()!;
		while (words.length > 1) {
			const option = words[0]!;
			if (/^\w+=/.test(option)) {
				words.shift();
				continue;
			}
			if (option === "--") {
				words.shift();
				break;
			}
			if (!/^[-+]/.test(option)) break;
			// env -S 的参数自身是命令串，不能当普通 wrapper 参数放行。
			if (wrapper === "env" && (option.startsWith("-S") || option.startsWith("--split-string"))) return "eval";
			words.shift();
			if (operands.has(option)) words.shift();
		}
	}
	return words[0] ?? "";
}

/** 判断整条 bash 命令是否高敏（任一段高敏即高敏）。 */
export function isHighRiskBash(command: string): boolean {
	if (!command.trim()) return false;
	// 单引号内容是纯字面量（无展开）：剥掉再匹配，避免 'a && rm b' 这类文案误报；
	// 双引号内 $()/反引号仍会展开执行，保留参与匹配。
	const scan = command.replace(/'[^']*'/g, "''");
	if (RISKY_PATTERNS.some((re) => re.test(scan))) return true;
	for (const segment of splitSegments(command)) {
		const head = headWord(segment);
		if (!head) continue;
		// shell 解释入口带 -c / source 任意文件：无法静态分析执行体 → 高敏
		const base = head.split("/").pop() ?? head;
		if (/[$*?\[]/.test(head)) return true;
		if (/^(ba|z|fi|da|k)?sh$/.test(base) || head === "source" || head === ".") {
			return true;
		}
		if (
			/^(git|npm|pnpm|yarn|cargo|find)$/.test(base) &&
			RISKY_PATTERNS.some((re) => re.test(shellWords(segment).join(" ")))
		)
			return true;
		if (RISKY_HEAD.has(head) || RISKY_HEAD.has(base)) return true;
	}
	return false;
}

/** A positive read-only classification for workbench auto mode; unknown syntax asks. */
export function isReadOnlyWorkbenchCommand(command: string): boolean {
  if (!command.trim() || /[;&|<>$`\\\n\r(){}]/.test(command)) return false;
  const words=shellWords(command.trim()), head=words[0]??"";
  const base=head.replace(/^\/(?:usr\/bin|bin)\//, "");
  if(!["pwd","ls","cat","head","tail","wc","stat","du","df","rg","grep","find"].includes(base)) return false;
  if(base==="rg" && words.some(w=>/^--(?:pre|hostname-bin)(?:=|$)/.test(w)))return false;
  if(base==="find" && words.some(w=>/^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(w)))return false;
  return true;
}
