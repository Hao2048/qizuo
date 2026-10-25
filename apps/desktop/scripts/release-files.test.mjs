import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promoteRelease, pruneOldReleases } from "./release-files.mjs";
const app = (dir) => {
  const f = join(dir, "mac-arm64/栖作.app/Contents/MacOS");
  mkdirSync(f, { recursive: true });
  writeFileSync(join(f, "栖作"), "fixture");
};
test("only promotes a valid candidate and then removes old app/archive output", () => {
  const root = mkdtempSync(join(tmpdir(), "pih-release-test-"));
  try {
    app(join(root, "latest"));
    app(join(root, ".candidate"));
    mkdirSync(join(root, "old"));
    writeFileSync(join(root, "old.dmg"), "old");
    const result = promoteRelease(root, join(root, ".candidate"));
    assert.equal(result.removed, 3);
    assert.equal(
      existsSync(
        join(root, "latest/mac-arm64/栖作.app/Contents/MacOS/栖作"),
      ),
      true,
    );
    assert.equal(existsSync(join(root, "old.dmg")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("an invalid or external candidate never removes the current usable version", () => {
  const root = mkdtempSync(join(tmpdir(), "pih-release-test-")),
    outside = mkdtempSync(join(tmpdir(), "pih-release-keep-"));
  try {
    app(join(root, "latest"));
    mkdirSync(join(root, ".bad"));
    app(outside);
    assert.throws(() => promoteRelease(root, join(root, ".bad")));
    assert.throws(() => pruneOldReleases(root, outside));
    symlinkSync(outside, join(root, "link"));
    assert.throws(() => promoteRelease(root, join(root, "link")));
    assert.equal(
      existsSync(
        join(root, "latest/mac-arm64/栖作.app/Contents/MacOS/栖作"),
      ),
      true,
    );
    assert.equal(
      existsSync(
        join(outside, "mac-arm64/栖作.app/Contents/MacOS/栖作"),
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
