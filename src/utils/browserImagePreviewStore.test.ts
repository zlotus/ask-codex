/// <reference types="node" />

import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
} from "./attachments";
import {
  BrowserImagePreviewStore,
  DEFAULT_IMAGE_PREVIEW_TTL_MS,
} from "./browserImagePreviewStore";
import { sessionImagePreviewKey } from "./sessionImagePreviews";

function image(size: number, type = "image/png"): Blob {
  return new NodeBlob([new Uint8Array(size)], { type }) as unknown as Blob;
}

function previewKey(id: string): string {
  return sessionImagePreviewKey("thread-test", id);
}

function storeOptions(
  indexedDB: IDBFactory,
  dbName: string,
  now: () => number,
  extra: Partial<ConstructorParameters<typeof BrowserImagePreviewStore>[0]> = {},
) {
  return { indexedDB, dbName, now, ...extra };
}

function openDatabase(indexedDB: IDBFactory, dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function deleteDatabase(indexedDB: IDBFactory, dbName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("database deletion was blocked"));
  });
}

describe("BrowserImagePreviewStore", () => {
  it("preserves ordered blobs across instances without persisting File names", async () => {
    const indexedDB = new FakeIDBFactory();
    const dbName = "ordered-blobs";
    const first = new BrowserImagePreviewStore(storeOptions(indexedDB, dbName, () => 100));
    const namedFile = new NodeFile(
      [new Uint8Array(1)],
      "private-name.png",
      { type: "image/png" },
    );

    await first.remember(previewKey("thread-one"), [
      namedFile as unknown as Blob,
      image(2, "image/jpeg"),
      image(3, "image/webp"),
    ]);
    first.close();

    const second = new BrowserImagePreviewStore(storeOptions(indexedDB, dbName, () => 101));
    const loaded = await second.loadAll();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].key).toBe(previewKey("thread-one"));
    expect(loaded[0].storedAt).toBe(100);
    expect(loaded[0].blobs.map((blob) => [blob.size, blob.type])).toEqual([
      [1, "image/png"],
      [2, "image/jpeg"],
      [3, "image/webp"],
    ]);
    expect(loaded[0].blobs[0]).not.toBeInstanceOf(NodeFile);
    expect("name" in loaded[0].blobs[0]).toBe(false);
    second.close();
  });

  it("atomically replaces a group and refreshes its FIFO position", async () => {
    const indexedDB = new FakeIDBFactory();
    let now = 1;
    const store = new BrowserImagePreviewStore(storeOptions(
      indexedDB,
      "replace",
      () => now,
      { maxImages: 2 },
    ));

    await store.remember(previewKey("first"), [image(1), image(2)]);
    now = 2;
    await store.remember(previewKey("first"), [image(3)]);
    now = 3;
    await store.remember(previewKey("second"), [image(4)]);

    expect((await store.loadAll()).map((entry) => ({
      key: entry.key,
      sizes: entry.blobs.map((blob) => blob.size),
      storedAt: entry.storedAt,
    }))).toEqual([
      { key: previewKey("first"), sizes: [3], storedAt: 2 },
      { key: previewKey("second"), sizes: [4], storedAt: 3 },
    ]);
    store.close();
  });

  it("evicts the oldest whole groups when the image-count budget is exceeded", async () => {
    const indexedDB = new FakeIDBFactory();
    let now = 1;
    const store = new BrowserImagePreviewStore(storeOptions(
      indexedDB,
      "count-eviction",
      () => now,
      { maxImages: 3 },
    ));

    await store.remember(previewKey("oldest"), [image(1), image(1)]);
    now = 2;
    await store.remember(previewKey("newest"), [image(1), image(1)]);

    expect((await store.loadAll()).map((entry) => entry.key)).toEqual([previewKey("newest")]);
    store.close();
  });

  it("evicts the oldest whole groups when the byte budget is exceeded", async () => {
    const indexedDB = new FakeIDBFactory();
    let now = 1;
    const store = new BrowserImagePreviewStore(storeOptions(
      indexedDB,
      "byte-eviction",
      () => now,
      { maxBytes: 5 },
    ));

    await store.remember(previewKey("oldest"), [image(3)]);
    now = 2;
    await store.remember(previewKey("newest"), [image(3)]);

    expect((await store.loadAll()).map((entry) => entry.key)).toEqual([previewKey("newest")]);
    store.close();
  });

  it("preserves FIFO write order when groups share the same timestamp", async () => {
    const indexedDB = new FakeIDBFactory();
    const store = new BrowserImagePreviewStore(storeOptions(
      indexedDB,
      "same-timestamp",
      () => 1,
      { maxImages: 1 },
    ));

    await store.remember(previewKey("z-oldest"), [image(1)]);
    await store.remember(previewKey("a-newest"), [image(1)]);

    expect((await store.loadAll()).map((entry) => entry.key))
      .toEqual([previewKey("a-newest")]);
    store.close();
  });

  it("uses a 30-day TTL and deletes expired groups during loadAll", async () => {
    const indexedDB = new FakeIDBFactory();
    let now = 0;
    const first = new BrowserImagePreviewStore(storeOptions(indexedDB, "ttl", () => now));
    await first.remember(previewKey("expired"), [image(1)]);
    first.close();

    now = DEFAULT_IMAGE_PREVIEW_TTL_MS - 1;
    const beforeExpiry = new BrowserImagePreviewStore(storeOptions(indexedDB, "ttl", () => now));
    expect((await beforeExpiry.loadAll()).map((entry) => entry.key)).toEqual([previewKey("expired")]);
    beforeExpiry.close();

    now = DEFAULT_IMAGE_PREVIEW_TTL_MS;
    const atExpiry = new BrowserImagePreviewStore(storeOptions(indexedDB, "ttl", () => now));
    expect(await atExpiry.loadAll()).toEqual([]);
    atExpiry.close();

    const afterCleanup = new BrowserImagePreviewStore(storeOptions(indexedDB, "ttl", () => now));
    expect(await afterCleanup.loadAll()).toEqual([]);
    afterCleanup.close();
  });

  it("rejects invalid new groups and removes corrupt stored groups before returning", async () => {
    const indexedDB = new FakeIDBFactory();
    const dbName = "validation";
    const store = new BrowserImagePreviewStore(storeOptions(indexedDB, dbName, () => 10));

    await expect(store.remember("not-a-preview-key", [image(1)]))
      .rejects.toThrow("canonical thread and turn ids");
    await expect(store.remember(previewKey("empty"), [])).rejects.toThrow("1-4");
    await expect(store.remember(
      previewKey("too-many"),
      Array.from({ length: MAX_IMAGES_PER_TURN + 1 }, () => image(1)),
    )).rejects.toThrow("1-4");
    await expect(store.remember(previewKey("empty-blob"), [image(0)])).rejects.toThrow("1-4");
    await expect(store.remember(previewKey("oversized"), [image(MAX_IMAGE_BYTES + 1)]))
      .rejects.toThrow("1-4");
    await expect(store.remember(previewKey("unsupported"), [image(1, "image/gif")]))
      .rejects.toThrow("1-4");

    const validKey = previewKey("valid");
    await store.remember(validKey, [image(1)]);
    const database = await openDatabase(indexedDB, dbName);
    const transaction = database.transaction("previewGroups", "readwrite");
    transaction.objectStore("previewGroups").put({
      key: previewKey("extra-metadata"),
      blobs: [image(1, "image/gif")],
      storedAt: 9,
      writeOrder: 1,
      path: "/private/image.gif",
    });
    transaction.objectStore("previewGroups").put({
      key: previewKey("named-file"),
      blobs: [new NodeFile([new Uint8Array(1)], "secret.png", { type: "image/png" })],
      storedAt: 9,
      writeOrder: 2,
    });
    transaction.objectStore("previewGroups").put({
      key: "not-a-preview-key",
      blobs: [image(1)],
      storedAt: 9,
      writeOrder: 3,
    });
    await transactionDone(transaction);
    database.close();

    expect((await store.loadAll()).map((entry) => entry.key)).toEqual([validKey]);
    const reopened = await openDatabase(indexedDB, dbName);
    const read = reopened.transaction("previewGroups", "readonly").objectStore("previewGroups").getAllKeys();
    const remainingKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    expect(remainingKeys).toEqual([validKey]);
    reopened.close();
    store.close();
  });

  it("rejects operations clearly when IndexedDB is unavailable", async () => {
    const store = new BrowserImagePreviewStore({ indexedDB: null });

    await expect(store.remember(previewKey("key"), [image(1)]))
      .rejects.toThrow("IndexedDB is not available");
    await expect(store.loadAll()).rejects.toThrow("IndexedDB is not available");
    store.close();
  });

  it("closes its connection and rejects subsequent operations", async () => {
    const indexedDB = new FakeIDBFactory();
    const dbName = "closed";
    const store = new BrowserImagePreviewStore(storeOptions(indexedDB, dbName, () => 1));
    await store.remember(previewKey("key"), [image(1)]);

    store.close();

    await expect(store.remember(previewKey("other"), [image(1)]))
      .rejects.toThrow("store is closed");
    await expect(store.loadAll()).rejects.toThrow("store is closed");
    await expect(deleteDatabase(indexedDB, dbName)).resolves.toBeUndefined();
  });
});
