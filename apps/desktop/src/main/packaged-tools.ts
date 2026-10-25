import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

/** spawn cannot execute a virtual path inside app.asar. Set this before loading extensions. */
export function configurePackagedTools(
  resourcesPath: string,
  packaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
  load: () => unknown = () => createRequire(import.meta.url)("esbuild"),
): void {
  if (!packaged || env.ESBUILD_BINARY_PATH) return;
  const binary = join(resourcesPath, "app.asar.unpacked/node_modules/@esbuild",
    `${process.platform}-${process.arch}`, "bin", "esbuild");
  if (!existsSync(binary)) return;
  // esbuild captures this value at module initialization. Do not leak it to user
  // project commands, which may need a different version of the executable.
  const workers = env.ESBUILD_WORKER_THREADS;
  env.ESBUILD_BINARY_PATH = binary;
  // Lazy sync workers would otherwise read the restored environment later.
  // The SDK's async compiler still uses its persistent native service.
  env.ESBUILD_WORKER_THREADS = "0";
  try { load(); } finally {
    delete env.ESBUILD_BINARY_PATH;
    if (workers === undefined) delete env.ESBUILD_WORKER_THREADS;
    else env.ESBUILD_WORKER_THREADS = workers;
  }
}
