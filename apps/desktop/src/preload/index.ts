/**
 * Preload：sandbox 环境（CJS），只暴露最小类型化桥。
 * 渲染进程拿不到 Node 能力，凭证等主进程数据不可能进入渲染层。
 */
import { contextBridge, ipcRenderer } from "electron";

const draftFlushHandlers = new Set<()=>Promise<void>>();
ipcRenderer.on("pih:draft-flush", async (_event, token: string) => {
  try { await Promise.all([...draftFlushHandlers].map(fn=>fn())); ipcRenderer.send("pih:draft-flushed",token,true); }
  catch { ipcRenderer.send("pih:draft-flushed",token,false); }
});
const bridge = {
  onDraftFlush: (callback:()=>Promise<void>) => { draftFlushHandlers.add(callback); return ()=>{draftFlushHandlers.delete(callback);}; },
	invoke: (name: string, payload?: unknown): Promise<unknown> =>
		ipcRenderer.invoke("pih:invoke", name, payload),
	onEvent: (callback: (event: unknown) => void): (() => void) => {
		const listener = (_e: unknown, event: unknown) => callback(event);
		ipcRenderer.on("pih:event", listener);
		return () => {
			ipcRenderer.removeListener("pih:event", listener);
		};
	},
	platform: process.platform,
	versions: {
		electron: process.versions.electron ?? "",
		chrome: process.versions.chrome ?? "",
	},
};

contextBridge.exposeInMainWorld("pih", bridge);

export type PiHBridge = typeof bridge;
