/** Small Node launcher used only for cancellable package installation, never for agents. */
export const npmCancelRunner = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [marker, separator, command, ...args] = process.argv.slice(2);
if (separator !== '--' || !command) process.exit(2);
if (fs.existsSync(marker)) process.exit(1);
const child = spawn(command, args, { stdio: 'inherit', detached: process.platform !== 'win32' });
const parent = process.ppid;
let closed = false, cancelling = false, killed = false, status = 1;
const kill = (signal) => {
 try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
};
const finish = () => { if (closed && (!cancelling || killed)) { clearInterval(poll); process.exit(cancelling ? 1 : status); } };
const cancel = () => {
 if (cancelling) return;
 cancelling = true; kill('SIGTERM');
 setTimeout(() => { kill('SIGKILL'); killed = true; finish(); }, 500);
};
const poll = setInterval(() => { if (fs.existsSync(marker) || process.ppid !== parent) cancel(); }, 40);
child.on('error', () => { status = 1; });
child.on('close', code => { closed = true; status = code ?? 1; finish(); });
process.on('SIGTERM', cancel);
process.on('SIGINT', cancel);
`;
