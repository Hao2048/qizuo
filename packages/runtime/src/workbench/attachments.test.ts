import { beforeEach, afterEach, it, expect } from "vitest";
import { HarnessDatabase } from "../db/database.js";
import { WorkbenchAttachments } from "./attachments.js";
let db: HarnessDatabase, store: WorkbenchAttachments;
const data = (s: string) => Buffer.from(s).toString("base64");
const add = (id = "one", value = "hello") =>
  store.add({
    id,
    name: "notes.md",
    kind: "text",
    mimeType: "text/markdown",
    data: data(value),
  });
beforeEach(() => {
  db = HarnessDatabase.memory();
  store = new WorkbenchAttachments(db);
  for (const id of ["one", "two"])
    db.prepare("INSERT INTO workbenches VALUES(?,?,1,1)").run(id, "{}");
});
afterEach(() => db.close());
it("rejects cross-task reads, sends and removal; clears cancelled and abandoned uploads", async () => {
  const file = await add();
  expect(() => store.read("two", file.id)).toThrow("不属于");
  expect(() => store.bind("two", "r", [file.id])).toThrow("不属于");
  expect(() => store.discard("two", file.id)).toThrow("不属于");
  expect(store.read("one", file.id).data).toBe(data("hello"));
  store.discard("one", file.id);
  expect(() => store.read("one", file.id)).toThrow();
  const sent = await add();
  store.bind("one", "r", [sent.id]);
  await add();
  store.clearAbandoned();
  expect(
    db.prepare("SELECT COUNT(*) n FROM workbench_attachments").get(),
  ).toEqual({ n: 1 });
  expect(store.read("one", sent.id).data).toBe(data("hello"));
  store.discard("one", sent.id);
  expect(store.read("one", sent.id).data).toBe(data("hello"));
  store.bind("one", "retry", [sent.id]);
  db.prepare("DELETE FROM workbenches WHERE id=?").run("one");
  expect(
    db.prepare("SELECT COUNT(*) n FROM workbench_attachments").get(),
  ).toEqual({ n: 0 });
});
it("validates UTF-8, file types, signatures, filenames and size at the backend", async () => {
  for (const patch of [
    { name: "../secret" },
    { data: "!!!=" },
    { data: Buffer.from([0xff]).toString("base64") },
    { data: data("a\0b") },
    { name: "fake.pdf" },
    { data: data("a".repeat(65537)) },
  ])
    await expect(
      store.add({
        id: "one",
        name: "n.txt",
        kind: "text",
        mimeType: "text/plain",
        data: data("ok"),
        ...patch,
      }),
    ).rejects.toThrow();
  await expect(
    store.add({
      id: "one",
      name: "fake.png",
      kind: "image",
      mimeType: "image/png",
      data: data("not a png"),
    }),
  ).rejects.toThrow("格式不匹配");
  await expect(
    store.add({
      id: "one",
      name: "x.svg",
      kind: "image",
      mimeType: "image/svg+xml",
      data: data("<svg/>"),
    }),
  ).rejects.toThrow();
  await expect(
    store.add({
      id: "one",
      name: "broken.png",
      kind: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGksAAAAASUVORK5CYII=",
    }),
  ).rejects.toThrow("无法解码");
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";
  expect(
    (
      await store.add({
        id: "one",
        name: "x.png",
        kind: "image",
        mimeType: "image/png",
        data: png,
      })
    ).kind,
  ).toBe("image");
});
it("caps request and task storage without partially binding invalid batches", async () => {
  const files = await Promise.all(Array.from({ length: 7 }, () => add()));
  expect(() =>
    store.bind(
      "one",
      "r",
      files.map((f) => f.id),
    ),
  ).toThrow("6");
  expect(() => store.bind("one", "r", [files[0]!.id, files[0]!.id])).toThrow();
  const large = await Promise.all(
    Array.from({ length: 3 }, () => add("one", "a".repeat(65536))),
  );
  expect(() =>
    store.bind(
      "one",
      "r",
      large.map((f) => f.id),
    ),
  ).toThrow("128");
  expect(
    db
      .prepare(
        "SELECT COUNT(*) n FROM workbench_attachments WHERE request_id IS NOT NULL",
      )
      .get(),
  ).toEqual({ n: 0 });
  for (let i = 10; i < 64; i++) await add();
  await expect(add()).rejects.toThrow("存储上限");
});
