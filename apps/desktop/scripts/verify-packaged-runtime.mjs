import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** Exercise dynamic SDK/auth imports and native tools in the actual archive, without user data or network. */
export function verifyPackagedRuntime(app) {
  const resources = join(app, "Contents/Resources");
  const code = `
    const {createRequire}=await import('node:module');
    const {pathToFileURL}=await import('node:url');
    const root=process.argv[1];
    const require=createRequire(root+'/package.json');
    const Sqlite=require('better-sqlite3');
    const db=new Sqlite(':memory:');
    if(db.prepare('SELECT 42 AS n').get().n!==42)throw Error('SQLite check failed');
    db.close();
    for(const name of ['index.js','extensions/mcp/cli.js','extensions/mcp/oauth.js',
      'core/auth-storage.js','extensions/mcp/config.js','extensions/mcp/runtime.js','config.js']) {
      await import(pathToFileURL(root+'/node_modules/@earendil-works/pi-coding-agent/dist/'+name).href);
    }
    const esbuild=require('esbuild');
    delete process.env.ESBUILD_BINARY_PATH;
    delete process.env.ESBUILD_WORKER_THREADS;
    try {
      if(!esbuild.transformSync('const n: number=42',{loader:'ts'}).code.includes('42'))throw Error('Extension compiler check failed');
      esbuild.stop();
      if(!(await esbuild.transform('const n: number=43',{loader:'ts'})).code.includes('43'))throw Error('Async extension compiler check failed');
    } finally { esbuild.stop(); }
  `;
  execFileSync(join(app, "Contents/MacOS/栖作"), ["--input-type=module", "-e", code, join(resources, "app.asar")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ESBUILD_WORKER_THREADS: "0",
      ESBUILD_BINARY_PATH: join(resources, "app.asar.unpacked/node_modules/@esbuild", `${process.platform}-${process.arch}`, "bin/esbuild") },
    timeout: 60_000,
    stdio: "pipe",
  });
}
