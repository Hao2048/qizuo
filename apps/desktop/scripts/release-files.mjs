import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
const binary = "mac-arm64/栖作.app/Contents/MacOS/栖作";
export function pruneOldReleases(root, keep) {
  root = realpathSync(root);
  keep = resolve(keep);
  if (lstatSync(keep).isSymbolicLink()) throw Error("不能保留符号链接版本");
  keep = realpathSync(keep);
  if (
    dirname(keep) !== root ||
    lstatSync(keep).isSymbolicLink() ||
    !existsSync(join(keep, binary))
  )
    throw Error("拒绝清理：保留版本不在打包目录或缺少软件");
  let removed = 0;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (path === keep) continue;
    rmSync(path, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
export function promoteRelease(root, candidate) {
  root = realpathSync(root);
  candidate = resolve(candidate);
  if (lstatSync(candidate).isSymbolicLink())
    throw Error("不能发布符号链接版本");
  candidate = realpathSync(candidate);
  if (
    dirname(candidate) !== root ||
    lstatSync(candidate).isSymbolicLink() ||
    !existsSync(join(candidate, binary))
  )
    throw Error("新包无效，旧包保留");
  const latest = join(root, "latest"),
    previous = join(root, ".previous-" + Date.now());
  if (candidate === latest) throw Error("新包必须先在临时目录验证");
  const hasPrevious = existsSync(latest);
  if (hasPrevious) renameSync(latest, previous);
  try {
    renameSync(candidate, latest);
  } catch (e) {
    if (hasPrevious) renameSync(previous, latest);
    throw e;
  }
  return { latest, removed: pruneOldReleases(root, latest) };
}
