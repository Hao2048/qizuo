/**
 * Pi Harness 主进程：窗口、生命周期、IPC 装配。
 * 核心逻辑在 @pi-harness/runtime 的 HarnessCore，这里只做 Electron 适配。
 *
 * 冒烟模式：--pih-smoke 启动 → 渲染进程自检 → smoke:report 命令回传 →
 * 主进程把结果写 PIH_SMOKE_OUT 指向的文件并退出（0 成功 / 1 失败）。
 */
import { app, BrowserWindow, nativeTheme, dialog, ipcMain, Notification, safeStorage, shell, Menu } from "electron";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commandSchemas, type CommandInput } from "@pi-harness/contracts";
import { BackupService, createHarnessCore, type HarnessCore } from "@pi-harness/runtime";
import { configurePackagedTools } from "./packaged-tools.js";

configurePackagedTools(process.resourcesPath, app.isPackaged);

const appDir = pathDir(import.meta.url);
const isSmoke = process.argv.includes("--pih-smoke");
const enableFaux = process.env["PIH_ENABLE_FAUX"] === "1";

/**
 * GUI（Finder/Dock）启动的进程 PATH 只有系统四目录，找不到 node/npm——
 * 市场安装（pi 包经 npm 落盘）会全部 ENOENT 失败。
 * 依次尝试：交互式登录 shell 的 PATH（含 .zshrc 注入的 nvm/volta 等）→ 登录 shell → 常见目录直探。
 */
function ensureNpmOnPath(): void {
	if (process.platform === "win32") return;
	const probe = (): boolean => !spawnSync("npm", ["--version"], { timeout: 15_000 }).error;
	if (probe()) return;
	const marker = "__PIH_PATH__";
	const shellAttempts: Array<[string, string[]]> = [
		["/bin/zsh", ["-ilc", `echo ${marker}$PATH`]],
		["/bin/zsh", ["-lc", `echo ${marker}$PATH`]],
		["/bin/bash", ["-lc", `echo ${marker}$PATH`]],
	];
	for (const [bin, args] of shellAttempts) {
		try {
			const r = spawnSync(bin, args, { timeout: 15_000, encoding: "utf8" });
			const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith(marker));
			if (line?.slice(marker.length).trim()) {
				process.env["PATH"] = `${process.env["PATH"] ?? ""}:${line.slice(marker.length).trim()}`;
				if (probe()) {
					console.log("[pih] 已并入 shell PATH（npm 可用）");
					return;
				}
			}
		} catch {
			/* 尝试下一种方式 */
		}
	}
	// 兜底：直接探测常见 node/npm 安装目录
	const candidates = [
		join(homedir(), ".local/bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(homedir(), ".volta/bin"),
		join(homedir(), ".fnm"),
	];
	let nvm: string | null = null;
	try {
		const versions = readdirSync(join(homedir(), ".nvm/versions/node"));
		const latest = versions.sort().pop();
		if (latest) nvm = join(homedir(), ".nvm/versions/node", latest, "bin");
	} catch {
		/* 无 nvm */
	}
	if (nvm) candidates.push(nvm);
	for (const dir of candidates) {
		if (existsSync(join(dir, "npm"))) {
			process.env["PATH"] = `${process.env["PATH"] ?? ""}:${dir}`;
			console.log(`[pih] 已追加 npm 目录：${dir}`);
			return;
		}
	}
	console.log("[pih] 未找到 npm——市场安装可能失败，请确认 node/npm 已安装");
}
ensureNpmOnPath();

// 早期失败兜底：任何未捕获异常都要让进程退出，避免悬挂
process.on("uncaughtException", (err) => {
	console.error("[pih] 未捕获异常:", err);
	app.exit(1);
});

let core: HarnessCore | null = null;
let mainWindow: BrowserWindow | null = null;
let smokeGuard: ReturnType<typeof setTimeout> | null = null;
let smokeDone = false;

function pathDir(url: string): string {
	return join(fileURLToPath(url), "..");
}

// PIH_DATA_DIR 指定时隔离整套 userData（含单实例锁与 Chromium 缓存），使开发/自动化实例可与正式实例共存
// Display branding changes independently of data, bundle and keychain identity.
// Packaged legacy releases used this internal name for safeStorage; keep it stable.
if(app.isPackaged)app.setName("Pi Harness");
const legacyScopedData=join(app.getPath("appData"),"@pi-harness","desktop");
const legacyPackagedData=join(app.getPath("appData"),"Pi Harness");
app.setPath("userData",process.env["PIH_DATA_DIR"]??(
  existsSync(join(legacyScopedData,"data","harness.db"))?legacyScopedData:
  existsSync(join(legacyPackagedData,"data","harness.db"))?legacyPackagedData:legacyScopedData
));

// 冒烟模式使用独立数据目录，绕过单实例锁（可与用户正在使用的正式实例共存）
if (!isSmoke && !app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => mainWindow?.focus());

	app.whenReady().then(bootstrap).catch((err) => {
		console.error("[pih] 启动失败:", err);
		app.exit(1);
	});

	// 需求：关闭全部窗口即退出应用（macOS 亦然）
	app.on("window-all-closed", () => {
		app.quit();
	});
}

async function bootstrap(): Promise<void> {
 if (!app.isPackaged && process.platform === "darwin") app.dock?.setIcon(join(appDir, "../../build/icon.png"));
	const dataDir =
		process.env["PIH_DATA_DIR"] ??
		(isSmoke
			? join(app.getPath("temp"), `pih-smoke-data-${Date.now()}`)
			: join(app.getPath("userData"), "data"));

	// 启动时执行待恢复备份（核心初始化前；恢复不覆盖凭证）
	const restored = BackupService.executePendingRestore(dataDir);
	if (restored) {
		console.log("[pih] 已从备份恢复数据（凭证保留）");
	}

	// M7：凭证加密（macOS Keychain；不可用时如实回退明文）
	const cipher = safeStorage.isEncryptionAvailable()
		? {
				encrypt: (plain: string): string =>
					JSON.stringify({ pihEnc: "v1", data: safeStorage.encryptString(plain).toString("base64") }),
				decrypt: (stored: string): string => {
					const parsed = JSON.parse(stored) as { pihEnc?: string; data?: string };
					if (parsed?.pihEnc !== "v1" || !parsed.data) throw new Error("非本机加密格式");
					return safeStorage.decryptString(Buffer.from(parsed.data, "base64"));
				},
				isEncrypted: (stored: string): boolean => {
					try {
						return (JSON.parse(stored) as { pihEnc?: string })?.pihEnc === "v1";
					} catch {
						return false;
					}
				},
			}
		: null;
	if (!cipher) console.warn("[pih] safeStorage 不可用，凭证以明文存储");
  // Resolve the existing macOS keychain key before changing the display name.
  // userData and appId remain pinned; no credential file is rewritten.
  if(process.platform==="darwin"&&cipher)safeStorage.encryptString("");
  app.setName("栖作");

	core = await createHarnessCore({
		dataDir,
		appVersion: app.getVersion(),
		enableFaux,
		credentialCipher: cipher,
        onPluginAuthorized: () => {
            const window = BrowserWindow.getAllWindows()[0];
            if (!window || window.isDestroyed()) return;
            if (window.isMinimized()) window.restore();
            window.show(); window.focus(); app.focus({ steal: true });
        },
        openWorkbenchPreview: async url => {
            const target=new URL(url);
            if(target.protocol!=="http:"||target.hostname!=="127.0.0.1"||!target.port)throw Error("无效的本地成果预览地址");
            await shell.openExternal(url);
        },
        revealWorkbenchFile: path => shell.showItemInFolder(path),
        openWorkbenchDocument: async path => {
            if(process.platform==="darwin"){
                const window=BrowserWindow.getFocusedWindow()??BrowserWindow.getAllWindows()[0];
                if(!window||window.isDestroyed())throw Error("当前没有可用于系统预览的窗口");
                if(window.isMinimized())window.restore();
                window.show();window.focus();app.focus({steal:true});
                window.previewFile(path);
            }else {const error=await shell.openPath(path);if(error)throw Error(error);}
        },
		openExternal: (url) => {
			// OAuth 回调与令牌页统一只放行 https，防任意协议（file:/javascript: 等）
			if (!/^https:\/\//.test(url)) return;
			void shell.openExternal(url);
		},
	});

	ipcMain.handle("pih:invoke", (event, name: string, payload: unknown) => {
		// sender 校验：只接受来自本应用窗口的调用，拒绝其他 frame/iframe 伪造
		if (!BrowserWindow.getAllWindows().some((w) => w.webContents === event.sender)) {
			return { ok: false, error: { code: "handler_error", message: "非法调用来源" } };
		}
		if (!core) return { ok: false, error: { code: "handler_error", message: "核心未初始化" } };
		return core.router.invoke(name, payload);
	});
	core.router.onEvent((ev) => {
		for (const w of BrowserWindow.getAllWindows()) w.webContents.send("pih:event", ev);
	});

	// 系统目录选择对话框（只在主进程）
	core.router.register("project:pickFolder", {
		input: commandSchemas["project:pickFolder"].input,
		output: commandSchemas["project:pickFolder"].output,
		handler: async () => {
			const win = BrowserWindow.getAllWindows()[0];
			const result = win
				? await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] })
				: await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
			return { dir: result.canceled ? null : (result.filePaths[0] ?? null) };
		},
	});

	registerMainOnlyCommands(dataDir);
	setupNotifications();

	registerSmokeReport();

  app.setAboutPanelOptions({applicationName:"栖作 Qizuo",applicationVersion:app.getVersion()});
  if(process.platform==="darwin")Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:"栖作",submenu:[{role:"about",label:"关于栖作"},{type:"separator"},{role:"services"},{type:"separator"},{role:"hide",label:"隐藏栖作"},{role:"hideOthers"},{role:"unhide"},{type:"separator"},{role:"quit",label:"退出栖作"}]},
    {role:"fileMenu"},{role:"editMenu"},{role:"viewMenu"},{role:"windowMenu"},
  ]));
	mainWindow = createWindow();

	if (isSmoke) {
		smokeGuard = setTimeout(() => {
			finishSmoke({ ok: false, reason: "超时：45 秒内未收到渲染进程自检报告" });
		}, 45_000);
		mainWindow.webContents.on("render-process-gone", (_e, details) => {
			finishSmoke({ ok: false, reason: `渲染进程异常退出: ${details.reason}` });
		});
	}

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
	});
}

function createWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 920,
		minHeight: 700,
		titleBarStyle: "hiddenInset",
		trafficLightPosition: { x: 16, y: 18 },
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#f9f9fa",
		show: false,
		webPreferences: {
			preload: join(appDir, "../preload/index.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
		},
	});

	const updateWindowTheme = () => win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#f9f9fa");
 let closeAllowed=false, closeSaving=false;
 win.on("close", event=>{
   if(isSmoke||quitting||closeAllowed)return;
   event.preventDefault();
   if(closeSaving)return;
   closeSaving=true;
   void flushWindowDrafts(win).then(ok=>{
     closeSaving=false;
     if(ok&&!win.isDestroyed()){closeAllowed=true;win.close();}
     else if(!win.isDestroyed())void dialog.showMessageBox(win,{type:"error",message:"草稿未能保存，已保留当前窗口",detail:"请检查草稿保存提示并重试，避免丢失未发送内容。"});
   });
 });
 nativeTheme.on("updated", updateWindowTheme);
 win.once("ready-to-show", () => win.show());
	win.on("closed", () => {
 nativeTheme.off("updated", updateWindowTheme);
		if (mainWindow === win) mainWindow = null;
	});

	const devUrl = process.env["ELECTRON_RENDERER_URL"];
	if (devUrl) {
		const url = new URL(devUrl);
		if (isSmoke) url.searchParams.set("smoke", "1");
		void win.loadURL(url.toString());
	} else {
		const options = isSmoke ? { query: { smoke: "1" } } : undefined;
		void win.loadFile(join(appDir, "../renderer/index.html"), options);
	}

	// 安全基线：阻止意外导航与新窗口（精确匹配本应用源，不做前缀放行——file:// 前缀会放行任意本地文件页）
	const appOrigin = devUrl ?? pathToFileURL(join(appDir, "../renderer/index.html")).href;
	const isAppUrl = (u: string): boolean => {
		try {
			const parsed = new URL(u);
			if (devUrl) return parsed.origin === new URL(devUrl).origin;
			return parsed.protocol === "file:" && parsed.href === appOrigin;
		} catch {
			return false;
		}
	};
	win.webContents.on("will-navigate", (event, url) => {
		if (!isAppUrl(url)) event.preventDefault();
	});
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

	return win;
}

/** 需要 Electron 能力（对话框/文件系统/通知）的命令。 */
let quitting=false;
function flushWindowDrafts(win:BrowserWindow):Promise<boolean> {
  if(isSmoke||win.isDestroyed())return Promise.resolve(true);
  return new Promise(resolve=>{
    const token=randomUUID();
    const done=(ok:boolean)=>{clearTimeout(timer);ipcMain.removeListener("pih:draft-flushed",listener);resolve(ok);};
    const listener=(event:Electron.IpcMainEvent, received:string, ok:boolean)=>{if(received===token&&event.sender===win.webContents)done(ok===true);};
    const timer=setTimeout(()=>done(false),8000);
    ipcMain.on("pih:draft-flushed",listener);
    win.webContents.send("pih:draft-flush",token);
  });
}
app.on("before-quit", event => {
    if(quitting || !core)return;
    event.preventDefault();
    quitting=true;
    void (async()=>{
      const windows=BrowserWindow.getAllWindows();
      if(!(await Promise.all(windows.map(flushWindowDrafts))).every(Boolean)) {
        quitting=false;
        if(windows[0]&&!windows[0].isDestroyed())await dialog.showMessageBox(windows[0],{type:"error",message:"草稿未能保存，暂未退出",detail:"请检查保存提示并重试退出。"});
        return;
      }
      let timer:ReturnType<typeof setTimeout>|undefined;
      await Promise.race([core!.shutdown(),new Promise<void>(resolve=>{timer=setTimeout(resolve,8000);})]).catch(()=>{});
      clearTimeout(timer);core?.dispose();app.quit();
    })();
});

function registerMainOnlyCommands(dataDir: string): void {
	const reg = (name: keyof typeof commandSchemas, handler: (input: never) => unknown) => {
		core?.router.register(name as string, {
			input: commandSchemas[name].input,
			output: commandSchemas[name].output,
			handler: handler as (input: unknown) => unknown,
		});
	};

	reg("market:pickLocal", async () => {
		const win = BrowserWindow.getAllWindows()[0];
		const result = win
			? await dialog.showOpenDialog(win, { properties: ["openDirectory"] })
			: await dialog.showOpenDialog({ properties: ["openDirectory"] });
		return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
	});

	reg("export:transcript", async (input: never) => {
		const { taskId, format } = input as CommandInput<"export:transcript">;
		if (!core) return { ok: false, path: null };
		const fmt = format ?? "markdown";
		const { task, transcript } = await core.tasks.getTask(taskId);

		let content: string;
		let ext: string;
		if (fmt === "json") {
			content = JSON.stringify({ task, transcript, exportedAt: new Date().toISOString() }, null, 2);
			ext = "json";
		} else if (fmt === "html") {
			const esc = (t: string): string =>
				t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
			const body = transcript
				.map((m) => {
					const who = m.roleName ? `${esc(m.roleName)}` : m.role === "user" ? "用户" : "助手";
					if (m.role === "toolResult") {
						return `<div class="tr ${m.isError ? "err" : ""}">⚙ ${esc(m.toolName ?? "")} ${m.isError ? "失败" : "完成"}</div>`;
					}
					return `<div class="msg ${m.role}"><div class="who">${who}${m.kind === "final" ? " · 定稿" : ""}</div><pre>${esc(m.text ?? "")}</pre></div>`;
				})
				.join("\n");
			content = `<!doctype html><meta charset="utf-8"><title>${esc(task.title)}</title><style>body{font:14px/1.7 -apple-system,PingFang SC,sans-serif;max-width:860px;margin:24px auto;color:#24282f}.msg{border:1px solid #e2e4e9;border-radius:10px;padding:10px 14px;margin:10px 0;white-space:pre-wrap}.who{font-size:12px;color:#0066d9;margin-bottom:6px}.user .who{color:#1e9e5a}.tr{font-size:12px;color:#677180}.tr.err{color:#d5423e}pre{margin:0;white-space:pre-wrap;font:inherit}</style><h1>${esc(task.title)}</h1><p style="color:#677180">状态 ${task.status} · 模式 ${task.mode}${task.model ? ` · ${esc(task.model.provider)}/${esc(task.model.modelId)}` : ""}</p>${body}`;
			ext = "html";
		} else {
			const lines: string[] = [`# ${task.title}`, "", `- 状态：${task.status} · 模式：${task.mode}`, ""];
			if (task.model) lines.push(`- 模型：${task.model.provider}/${task.model.modelId}`, "");
			for (const m of transcript) {
				if (m.role === "user") {
					lines.push("## 🧑 用户", "", m.text ?? "", "");
				} else if (m.role === "assistant") {
					const who = m.roleName ? `🤖 ${m.roleName}` : "🤖 助手";
					lines.push(`## ${who}${m.kind === "final" ? "（定稿）" : ""}`, "", m.text ?? "", "");
				} else {
					lines.push(`> 工具 ${m.toolName} ${m.isError ? "失败" : "完成"}`, "");
				}
			}
			content = lines.join("\n");
			ext = "md";
		}

		const win = BrowserWindow.getAllWindows()[0];
		const filters = [
			{ name: ext.toUpperCase(), extensions: [ext] },
		];
		const result = await (win
			? dialog.showSaveDialog(win as never, { defaultPath: `${task.title}.${ext}`, filters })
			: dialog.showSaveDialog({ defaultPath: `${task.title}.${ext}`, filters }));
		if (result.canceled || !result.filePath) return { ok: false, path: null };
		writeFileSync(result.filePath, content, "utf8");
		return { ok: true, path: result.filePath };
	});

	reg("diag:export", async () => {
		if (!core) return { ok: false, path: null };
		const outDir = join(tmpdir(), `pih-diag-${Date.now()}`);
		mkdirSync(outDir, { recursive: true });
		// 日志 + 元信息（无凭证：日志本身有脱敏层）
		if (existsSync(core.logsDir)) cpSync(core.logsDir, join(outDir, "logs"), { recursive: true });
		const diag = {
			appVersion: core.appVersion,
			schemaVersion: core.db.version,
			dataDir: core.dataDir,
			platform: process.platform,
			electron: process.versions.electron,
			node: process.versions.node,
			commands: core.router.names(),
			settings: core.tasks.getSettings(),
			exportedAt: new Date().toISOString(),
		};
		writeFileSync(join(outDir, "meta.json"), JSON.stringify(diag, null, 2), "utf8");
		shell.showItemInFolder(join(outDir, "meta.json"));
		return { ok: true, path: outDir };
	});

	reg("app:restart", () => {
		setTimeout(() => {
			app.relaunch();
			app.exit(0);
		}, 200);
		return { ok: true };
	});
}

/** 系统通知：任务完成/待审批/推荐（窗口未聚焦时）。 */
function setupNotifications(): void {
	if (!core) return;
	core.router.onEvent((event) => {
		const type = event.type;
		const payload = event.payload as Record<string, unknown>;
		const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused());
		if (focused || !Notification.isSupported()) return;
		if (type === "task:state" && (payload["status"] === "done" || payload["status"] === "waiting_approval")) {
			const title = payload["status"] === "done" ? "任务完成" : "等待你的审批";
			new Notification({ title, body: String(payload["detail"] ?? "栖作 Qizuo") }).show();
		} else if (type === "task:recommend") {
			new Notification({ title: "角色推荐", body: `是否添加 ${String(payload["roleName"])}？30 秒内决定` }).show();
		}
	});
}

function registerSmokeReport(): void {
	const schemas = commandSchemas["smoke:report"];
	core?.router.register("smoke:report", {
		input: schemas.input,
		output: schemas.output,
		handler: (raw) => {
			const input = raw as CommandInput<"smoke:report">;
			const fauxOk = input.faux ? input.faux.ok === true : true;
			const ok =
				input.rendererBoot &&
				(input.health?.ok ?? false) &&
				input.ping === true &&
				fauxOk &&
				!input.error;
			finishSmoke({
				ok,
				rendererBoot: input.rendererBoot,
				ping: input.ping ?? false,
				faux: input.faux ?? null,
				health: input.health ?? null,
				error: input.error ?? null,
			});
			return { received: true };
		},
	});
}

function finishSmoke(result: Record<string, unknown>): void {
	if (smokeDone) return;
	smokeDone = true;
	if (smokeGuard) clearTimeout(smokeGuard);
	const out = process.env["PIH_SMOKE_OUT"];
	if (out) {
		try {
			writeFileSync(out, JSON.stringify({ ...result, ts: Date.now() }, null, 2), "utf8");
		} catch (err) {
			console.error("[pih] 写冒烟结果失败:", err);
		}
	}
	const code = result.ok === true ? 0 : 1;
	setTimeout(() => app.exit(code), 150);
}
