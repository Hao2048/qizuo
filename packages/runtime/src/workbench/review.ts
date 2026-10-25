import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, fstatSync, constants } from "node:fs";
import { manifest, destinationManifest, owns, safePath, type Manifest } from "./workspace.js";
/** Inspect only; both application and file inspection recheck the same content receipt. */
export function reviewWorkspace(
  root: string,
  destination: string,
  base: Manifest,
  owned: string[],
) {
  base = Object.assign(Object.create(null), base);
  const current = manifest(root,true),
    dest = destinationManifest(destination,[...Object.keys(base),...Object.keys(current)]);
  const paths = [...new Set([...Object.keys(base), ...Object.keys(current)])]
    .filter((p) => base[p] !== current[p])
    .sort();
  const files = paths.map((path) => ({
    path,
    kind: !base[path] ? "added" : !current[path] ? "deleted" : "modified",
    conflict:
      !owns(path, owned) ||
      (dest[path] !== base[path] && dest[path] !== current[path]),
    reason: !owns(path, owned)
      ? "修改超出角色职责"
      : dest[path] !== base[path] && dest[path] !== current[path]
        ? "项目文件已被其他操作修改"
        : null,
  }));
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        paths.map((p) => [
          p,
          base[p] ?? null,
          current[p] ?? null,
          dest[p] ?? null,
          owns(p, owned),
        ]),
      ),
    )
    .digest("hex");
  return { files, hash, current, dest };
}
export function reviewText(root: string, path: string, present: boolean) {
  if (!present) return { text: "", binary: false, truncated: false, bytes: 0 };
  const fd = openSync(
    safePath(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("只能查看普通文件");
    const buffer = Buffer.alloc(Math.min(stat.size, 32768));
    const count = readSync(fd, buffer, 0, buffer.length, 0),
      data = buffer.subarray(0, count);
    let text = "",
      binary = data.includes(0);
    try {
      if (!binary)
        text = new TextDecoder("utf-8", { fatal: true }).decode(data, {
          stream: stat.size > count,
        });
    } catch {
      binary = true;
    }
    return {
      text: binary ? "" : text,
      binary,
      truncated: stat.size > count,
      bytes: stat.size,
    };
  } finally {
    closeSync(fd);
  }
}

/** Raster-only, decoded preview. No SVG, HTML, scripts, URLs or filesystem paths reach the renderer. */
export async function reviewImage(root: string, path: string) {
  const fd = openSync(
    safePath(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let data: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4.5 * 1024 * 1024)
      throw Error("图片必须是4.5MB以内的普通文件");
    data = Buffer.alloc(stat.size);
    let n = 0;
    while (n < data.length) {
      const size = readSync(fd, data, n, data.length - n, n);
      if (!size) throw Error("图片读取不完整");
      n += size;
    }
  } finally {
    closeSync(fd);
  }
  const mime = data
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : data[0] === 255 && data[1] === 216 && data[2] === 255
      ? "image/jpeg"
      : /^GIF8[79]a$/.test(data.subarray(0, 6).toString())
        ? "image/gif"
        : data.subarray(0, 4).toString() === "RIFF" &&
            data.subarray(8, 12).toString() === "WEBP"
          ? "image/webp"
          : null;
  if (!mime) throw Error("仅预览 PNG、JPEG、GIF、WebP 图片");
  const { resizeImage } = await import("@earendil-works/pi-coding-agent");
  const result = await resizeImage(data, mime);
  if (!result) throw Error("图片无法解码");
  return { data: result.data, mimeType: result.mimeType };
}
