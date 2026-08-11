/// <reference types="node" />

import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  BrowserFileAttachmentStore,
  DEFAULT_FILE_ATTACHMENT_TTL_MS,
} from "./browserFileAttachmentStore";
import { sessionFileAttachmentKey, type LocalFileAttachment } from "./sessionFileAttachments";

const { Blob: NodeBlob } = process.getBuiltinModule("buffer") as {
  Blob: typeof Blob;
};

function file(name: string, size: number, mediaType = "application/octet-stream"): LocalFileAttachment {
  return {
    blob: new NodeBlob([new Uint8Array(size)], { type: mediaType }) as unknown as Blob,
    mediaType,
    name,
    size,
  };
}

function key(turnId: string): string {
  return sessionFileAttachmentKey("thread-test", turnId);
}

describe("BrowserFileAttachmentStore", () => {
  it("preserves ordered names, media types, sizes, and blobs across instances", async () => {
    const indexedDB = new FakeIDBFactory();
    const options = { indexedDB, dbName: "file-persistence", now: () => 100 };
    const first = new BrowserFileAttachmentStore(options);
    await first.remember(key("turn-one"), [
      file("report.pdf", 3, "application/pdf"),
      file("notes.txt", 4, "text/plain"),
    ]);
    first.close();

    const second = new BrowserFileAttachmentStore({ ...options, now: () => 101 });
    const loaded = await second.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].files.map((entry) => ({
      name: entry.name,
      mediaType: entry.mediaType,
      size: entry.size,
      blobSize: entry.blob.size,
    }))).toEqual([
      { name: "report.pdf", mediaType: "application/pdf", size: 3, blobSize: 3 },
      { name: "notes.txt", mediaType: "text/plain", size: 4, blobSize: 4 },
    ]);
    second.close();
  });

  it("evicts oldest whole groups for count and byte budgets", async () => {
    const indexedDB = new FakeIDBFactory();
    let now = 1;
    const store = new BrowserFileAttachmentStore({
      indexedDB,
      dbName: "file-eviction",
      maxFiles: 2,
      maxBytes: 5,
      now: () => now,
    });
    await store.remember(key("oldest"), [file("one.bin", 2), file("two.bin", 2)]);
    now = 2;
    await store.remember(key("newest"), [file("three.bin", 3)]);

    expect((await store.loadAll()).map((entry) => entry.key)).toEqual([key("newest")]);
    store.close();
  });

  it("removes expired and thread-scoped records", async () => {
    const indexedDB = new FakeIDBFactory();
    let now = 1;
    const store = new BrowserFileAttachmentStore({
      indexedDB,
      dbName: "file-lifecycle",
      now: () => now,
    });
    await store.remember(key("expires"), [file("expires.txt", 1)]);
    const retainedKey = sessionFileAttachmentKey("thread-retained", "turn-one");
    await store.remember(retainedKey, [file("retained.txt", 1)]);
    await store.removeThread("thread-test");
    expect((await store.loadAll()).map((entry) => entry.key)).toEqual([retainedKey]);

    now += DEFAULT_FILE_ATTACHMENT_TTL_MS;
    expect(await store.loadAll()).toEqual([]);
    store.close();
  });

  it("degrades when IndexedDB is unavailable", async () => {
    const store = new BrowserFileAttachmentStore({ indexedDB: null });
    await expect(store.loadAll()).rejects.toThrow("IndexedDB is unavailable");
    store.close();
  });
});
