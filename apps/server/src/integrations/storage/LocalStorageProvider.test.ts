import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStorageProvider } from "./LocalStorageProvider";

let dir: string;
let store: LocalStorageProvider;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "alvip-storage-"));
  store = new LocalStorageProvider(dir);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalStorageProvider", () => {
  it("round-trips bytes and leaves no temp files", async () => {
    await store.put("locations/abc/img-1", Buffer.from("hello"), "image/jpeg");
    expect((await store.get("locations/abc/img-1"))?.toString()).toBe("hello");
    expect(await readdir(path.join(dir, "locations", "abc"))).toEqual(["img-1"]);
  });

  it("returns null for missing objects and deletes idempotently", async () => {
    expect(await store.get("locations/abc/nope")).toBeNull();
    await store.delete("locations/abc/img-1");
    await store.delete("locations/abc/img-1");
    expect(await store.get("locations/abc/img-1")).toBeNull();
  });

  it.each(["../escape", "locations/../../etc", "/abs/path", "a//b", "a/b/", "a\\b", ""])(
    "rejects unsafe key %j",
    async (key) => {
      await expect(store.put(key, Buffer.from("x"), "x")).rejects.toThrow(/Invalid storage key/);
    },
  );
});
