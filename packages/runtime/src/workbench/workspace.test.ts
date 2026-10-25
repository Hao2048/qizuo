import { afterEach, beforeEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneWorkspace,
  applyWorkspace,
  safePath,
  validOwnedPaths,
} from "./workspace.js";
let dir: string, source: string, worker: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pih-workspace-"));
  source = join(dir, "source");
  worker = join(dir, "worker");
  mkdirSync(source);
  writeFileSync(join(source, "a.txt"), "base");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
it("keeps writes private until application and applies only owned changes", () => {
  const base = cloneWorkspace(source, worker);
  writeFileSync(join(worker, "a.txt"), "new");
  expect(readFileSync(join(source, "a.txt"), "utf8")).toBe("base");
  expect(applyWorkspace(worker, source, base, ["a.txt"])).toEqual(["a.txt"]);
  expect(readFileSync(join(source, "a.txt"), "utf8")).toBe("new");
  expect(applyWorkspace(worker, source, base, ["a.txt"])).toEqual(["a.txt"]);
});
it("preflights every file and refuses to overwrite concurrent edits", () => {
  const base = cloneWorkspace(source, worker);
  writeFileSync(join(worker, "a.txt"), "role");
  writeFileSync(join(worker, "z.txt"), "new");
  writeFileSync(join(source, "z.txt"), "user");
  expect(() =>
    applyWorkspace(worker, source, base, ["a.txt", "z.txt"]),
  ).toThrow("冲突");
  expect(readFileSync(join(source, "a.txt"), "utf8")).toBe("base");
  expect(readFileSync(join(source, "z.txt"), "utf8")).toBe("user");
});
it("rejects traversal, reserved ownership and dangling symlinks", () => {
  expect(() => validOwnedPaths(["../secret"])).toThrow();
  expect(() => validOwnedPaths(["."])).toThrow();
  expect(() => validOwnedPaths([".git/config"])).toThrow();
  symlinkSync(join(dir, "missing"), join(source, "link"));
  expect(() => safePath(source, "link/secret")).toThrow("符号链接");
  expect(() => cloneWorkspace(source, worker)).toThrow("符号链接");
  expect(existsSync(worker)).toBe(false);
});
it("refuses out-of-scope changes before applying in-scope changes", () => {
  const base = cloneWorkspace(source, worker);
  writeFileSync(join(worker, "a.txt"), "new");
  writeFileSync(join(worker, "other.txt"), "bad");
  expect(() => applyWorkspace(worker, source, base, ["a.txt"])).toThrow(
    "职责外",
  );
  expect(readFileSync(join(source, "a.txt"), "utf8")).toBe("base");
});
it('keeps source build caches out of the clone while reviewing and applying only authorized generated output paths',()=>{
 mkdirSync(join(source,'dist'));writeFileSync(join(source,'dist/user-cache.txt'),'keep');
 const base=cloneWorkspace(source,worker);expect(existsSync(join(worker,'dist'))).toBe(false);
 mkdirSync(join(worker,'dist'));writeFileSync(join(worker,'dist/index.html'),'<h1>generated</h1>');
 expect(()=>applyWorkspace(worker,source,base,['a.txt'])).toThrow('职责外');
 expect(validOwnedPaths(['dist/'])).toEqual(['dist']);expect(()=>validOwnedPaths(['node_modules/'])).toThrow('保留目录');
 expect(applyWorkspace(worker,source,base,['dist'])).toEqual(['dist/index.html']);
 expect(readFileSync(join(source,'dist/user-cache.txt'),'utf8')).toBe('keep');
 writeFileSync(join(source,'dist/index.html'),'user edit');expect(()=>applyWorkspace(worker,source,base,['dist'])).toThrow('冲突');
});
