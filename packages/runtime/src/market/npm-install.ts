import { constants, existsSync, writeFileSync } from "node:fs";
import { cp, mkdir, readdir, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { installDirectory } from "./directory-install.js";
import { npmCancelRunner } from "./npm-cancel-runner.js";

async function internalLinks(root: string, directory = root): Promise<Array<{ path: string; destination: string }>> {
	const links: Array<{ path: string; destination: string }> = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) links.push(...await internalLinks(root, path));
		else if (entry.isSymbolicLink()) {
			const destination = await realpath(path);
			if (!destination.startsWith(`${resolve(root)}${sep}`)) {
				throw new Error("共享 npm 目录包含外部链接依赖，无法安全回滚，请先移除该链接。");
			}
			if (isAbsolute(await readlink(path))) links.push({ path: relative(root, path), destination: relative(root, destination) });
		}
	}
	return links;
}

/** Keep all shared npm dependencies untouched until the installer succeeds. */
export async function installNpmDirectory(options: {
	agentDir: string;
	cwd: string;
	source: string;
	sourceDirectory?: string;
	settings: Parameters<typeof SettingsManager.inMemory>[0];
	progress?: Parameters<DefaultPackageManager["setProgressCallback"]>[0];
	signal?: AbortSignal;
}): Promise<void> {
	if (!options.source.startsWith("npm:")) throw new Error("仅支持 npm 安装源。");
	const target = join(options.agentDir, "npm");
	const sourceDirectory = options.sourceDirectory ?? target;
	await installDirectory(target, async (staging) => {
		const agentDir = join(dirname(staging), "agent");
		const npmDir = join(agentDir, "npm");
		await mkdir(agentDir);
		if (existsSync(sourceDirectory)) {
			const links = await internalLinks(await realpath(sourceDirectory));
			// CoW where supported, otherwise a regular copy. Never hardlink mutable files.
			await cp(sourceDirectory, npmDir, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
			for (const link of links) {
				const path = join(npmDir, link.path);
				await rm(path);
				await symlink(relative(dirname(path), join(npmDir, link.destination)), path);
			}
		}
		const pm = new DefaultPackageManager({
			cwd: options.cwd, agentDir,
			settingsManager: SettingsManager.inMemory(options.settings),
		});
		pm.setProgressCallback(options.progress);
		options.signal?.throwIfAborted();
		const marker = join(agentDir, "cancelled");
		const abort = () => { writeFileSync(marker, "cancel"); };
		let installer = pm;
		if (options.signal) {
			const launcher = join(agentDir, "npm-launcher.cjs");
			writeFileSync(launcher, npmCancelRunner);
			const configured = options.settings?.npmCommand;
			const runtime = process.platform === "win32" ? ["node"] : ["/usr/bin/env", "ELECTRON_RUN_AS_NODE=1", process.execPath];
			installer = new DefaultPackageManager({ cwd: options.cwd, agentDir, settingsManager: SettingsManager.inMemory({
				...options.settings, npmCommand: [...runtime, launcher, marker, "--", ...(configured?.length ? configured : ["npm"])],
			}) });
			installer.setProgressCallback(options.progress);
			options.signal.addEventListener("abort", abort, { once: true });
		}
		try { await installer.install(options.source); }
		finally { options.signal?.removeEventListener("abort", abort); }
		options.signal?.throwIfAborted();
		await rm(staging, { recursive: true });
		await rename(npmDir, staging);
	}, options.signal);
}
