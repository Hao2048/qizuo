import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  renameSync,
  openSync, readSync, closeSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
export type Manifest = Record<string, string>;
const excluded = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "release",
  "coverage",
  ".DS_Store",
]);
const generated = new Set(["dist", "out", "release"]);
export function safePath(root: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.split(/[\\/]/).some((part) => part === ".." || part === "")
  )
    throw new Error("路径必须位于角色工作目录内");
  const target = resolve(root, path),
    rel = relative(resolve(root), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("路径越界");
  let current = resolve(root);
  for (const part of ["", ...rel.split("/")]) {
    current = part ? join(current, part) : current;
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("工作路径不能包含符号链接");
  }
  return target;
}
export function manifest(root: string, includeGenerated = false): Manifest {
  const result: Manifest = Object.create(null);
  let bytes = 0,
    count = 0;
  const walk = (dir: string, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (excluded.has(entry.name) && !(includeGenerated && generated.has(entry.name))) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name,
        file = safePath(root, path);
      if (entry.isSymbolicLink())
        throw new Error(`项目包含符号链接，不能隔离复制：${path}`);
      if (entry.isDirectory()) {
        walk(file, path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`不支持的文件：${path}`);
      const stat = lstatSync(file);
      bytes += stat.size;
      if (++count > 5000 || bytes > 100 * 1024 * 1024)
        throw new Error("工作目录超过隔离复制限额，请选择具体项目目录");
      result[path] = createHash("sha256")
        .update(readFileSync(file))
        .digest("hex");
    }
  };
  if (existsSync(root)) walk(root);
  return result;
}
export function cloneWorkspace(source: string, target: string): Manifest {
  const nested = relative(resolve(source), resolve(target));
  if (!nested.startsWith("..") && !isAbsolute(nested))
    throw new Error("隔离目录不能放在源项目内");
  if (existsSync(target)) throw new Error("角色目录已存在，不能覆盖历史成果");
  const files = manifest(source);
  mkdirSync(target, { recursive: true });
  try {
    for (const path of Object.keys(files)) {
      const out = safePath(target, path);
      mkdirSync(dirname(out), { recursive: true });
      copyFileSync(safePath(source, path), out);
    }
    if (JSON.stringify(manifest(source)) !== JSON.stringify(files))
      throw new Error("复制时源文件发生变化，请重试");
    return files;
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
/** Inspect destination versions only for tracked paths; unrelated build caches stay excluded. */
export function destinationManifest(root:string, paths:string[]):Manifest {
  const result:Manifest=Object.create(null);
  for(const path of new Set(paths)){
    const file=safePath(root,path),stat=lstatSync(file,{throwIfNoEntry:false});
    if(!stat)continue;
    if(!stat.isFile()){result[path]="non-file";continue;}
    const fd=openSync(file,"r"),hash=createHash("sha256"),buffer=Buffer.alloc(65536);
    try{let count:number;while((count=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));result[path]=hash.digest("hex");}finally{closeSync(fd);}
  }
  return result;
}
export function validOwnedPaths(paths: string[]): string[] {
  if (!paths.length || paths.length > 64)
    throw new Error("角色需要明确负责的文件或目录");
  return [
    ...new Set(
      paths.map((path) => {
        const value = path.replace(/\/$/, "");
        if (value.split("/").some((part) => part === "." || (excluded.has(part) && !generated.has(part))))
          throw new Error("职责路径包含保留目录");
        safePath("/pih-ownership", value);
        return value;
      }),
    ),
  ];
}
export function owns(path: string, owned: string[]): boolean {
  return owned.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
/** Preflight all changes before touching the destination; never overwrite another version. */
export function applyWorkspace(
  root: string,
  destination: string,
  base: Manifest,
  owned: string[],
): string[] {
  base = Object.assign(Object.create(null), base);
  const current = manifest(root, true),
    dest = destinationManifest(destination,[...Object.keys(base),...Object.keys(current)]);
  const changed = [
    ...new Set([...Object.keys(base), ...Object.keys(current)]),
  ].filter((path) => base[path] !== current[path]);
  for (const path of changed) {
    safePath(destination, path);
    if (!owns(path, owned)) throw new Error(`角色修改了职责外文件：${path}`);
    if (dest[path] !== base[path] && dest[path] !== current[path])
      throw new Error(`目标已有其他修改，请先解决冲突：${path}`);
  }
  const backups = new Map<string, Buffer | null>();
  try {
    for (const path of changed) {
      const out = safePath(destination, path);
      backups.set(path, existsSync(out) ? readFileSync(out) : null);
      if (!(path in current)) {
        rmSync(out, { force: true });
        continue;
      }
      mkdirSync(dirname(out), { recursive: true });
      const temp = `${out}.pih-write-${randomUUID()}`;
      try {
        writeFileSync(temp, readFileSync(safePath(root, path)), {
          flag: "wx",
          mode: lstatSync(safePath(root, path)).mode,
        });
        renameSync(temp, out);
      } finally {
        rmSync(temp, { force: true });
      }
    }
  } catch (error) {
    for (const [path, content] of [...backups].reverse()) {
      const out = safePath(destination, path);
      if (content === null) rmSync(out, { force: true });
      else writeFileSync(out, content);
    }
    throw error;
  }
  return changed;
}
