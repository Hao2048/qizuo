import { it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cloneWorkspace } from "./workspace.js";
import { reviewWorkspace, reviewText } from "./review.js";
it("compares additions, edits and deletions without writing, and identifies concurrent changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pih-review-")),
    source = join(dir, "source"),
    root = join(dir, "role");
  mkdirSync(source);
  try {
    writeFileSync(join(source, "edit.txt"), "before");
    writeFileSync(join(source, "delete.txt"), "remove");
    const base = cloneWorkspace(source, root);
    writeFileSync(join(root, "edit.txt"), "after");
    unlinkSync(join(root, "delete.txt"));
    writeFileSync(join(root, "new.txt"), "new");
    const first = reviewWorkspace(root, source, base, [
      "edit.txt",
      "delete.txt",
      "new.txt",
    ]);
    expect(first.files.map((f) => [f.path, f.kind, f.conflict])).toEqual([
      ["delete.txt", "deleted", false],
      ["edit.txt", "modified", false],
      ["new.txt", "added", false],
    ]);
    expect(reviewText(source, "edit.txt", true).text).toBe("before");
    expect(reviewText(root, "edit.txt", true).text).toBe("after");
    expect(reviewText(root, "delete.txt", false).bytes).toBe(0);
    writeFileSync(join(source, "edit.txt"), "manual");
    const next = reviewWorkspace(root, source, base, [
      "edit.txt",
      "delete.txt",
      "new.txt",
    ]);
    expect(next.hash).not.toBe(first.hash);
    expect(next.files.find((f) => f.path === "edit.txt")?.conflict).toBe(true);
    expect(
      reviewWorkspace(root, source, base, ["edit.txt"]).files.find(
        (f) => f.path === "new.txt",
      )?.reason,
    ).toContain("职责");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("limits large previews, distinguishes binary and UTF-8, rejects symlinks and traversal", () => {
  const dir = mkdtempSync(join(tmpdir(), "pih-review-text-"));
  try {
    writeFileSync(join(dir, "large"), "中".repeat(40000));
    const large = reviewText(dir, "large", true);
    expect(large.text.length).toBeLessThan(12000);
    expect(large.truncated).toBe(true);
    expect(large.binary).toBe(false);
    writeFileSync(join(dir, "binary"), Buffer.from([0, 1, 2]));
    expect(reviewText(dir, "binary", true).binary).toBe(true);
    symlinkSync(join(dir, "binary"), join(dir, "link"));
    expect(() => reviewText(dir, "link", true)).toThrow();
    expect(() => reviewText(dir, "../outside", true)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("raster preview rejects executable formats, symlinks, oversized files and broken images", async () => {
  const { reviewImage } = await import("./review.js"),
    dir = mkdtempSync(join(tmpdir(), "pih-raster-"));
  try {
    writeFileSync(join(dir, "large.png"), Buffer.alloc(5 * 1024 * 1024));
    await expect(reviewImage(dir, "large.png")).rejects.toThrow("4.5MB");
    writeFileSync(join(dir, "fake.png"), "<html><script>bad()</script></html>");
    await expect(reviewImage(dir, "fake.png")).rejects.toThrow("仅预览");
    symlinkSync(join(dir, "fake.png"), join(dir, "link.png"));
    await expect(reviewImage(dir, "link.png")).rejects.toThrow();
    await expect(reviewImage(dir, "../outside.png")).rejects.toThrow();
    writeFileSync(
      join(dir, "broken.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await expect(reviewImage(dir, "broken.png")).rejects.toThrow("解码");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
