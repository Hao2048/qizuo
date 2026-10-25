import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * - main：ESM 输出（package type: module）。workspace 包打进 bundle；
 *   pi SDK / 原生模块保持 external（运行时从 node_modules 加载）。
 *   electron-vite 5 用 build.externalizeDeps（旧 externalizeDepsPlugin 已废弃，
 *   且其 mergeConfig 会吞掉函数式 rollupOptions.external——不要混用）。
 * - preload：sandbox 要求 CJS，显式输出 .cjs
 * - renderer：标准 Vite + React
 */
export default defineConfig({
	main: {
		build: {
			outDir: "out/main",
			lib: { entry: "src/main/index.ts" },
			externalizeDeps: {
				exclude: ["@pi-harness/runtime", "@pi-harness/contracts", "@pi-harness/shared"],
			},
			rollupOptions: {
				external: ["better-sqlite3", /^@earendil-works\//, /^node:/],
			},
		},
	},
	preload: {
		build: {
			outDir: "out/preload",
			lib: { entry: "src/preload/index.ts" },
			rollupOptions: {
				output: { format: "cjs", entryFileNames: "[name].cjs", chunkFileNames: "[name].cjs" },
			},
		},
	},
	renderer: {
		root: "src/renderer",
		plugins: [react()],
		build: { outDir: "out/renderer" },
	},
});
