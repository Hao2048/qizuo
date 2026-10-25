import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "jsdom",
    setupFiles: ["./src/renderer/test-setup.ts"],
		include: ["src/renderer/**/*.test.{ts,tsx}", "src/main/**/*.test.ts"],
	},
	esbuild: { jsx: "automatic" },
});
