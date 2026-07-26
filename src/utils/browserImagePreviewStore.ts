import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_TURN,
  SUPPORTED_IMAGE_TYPES,
} from "./attachments";
import {
  isSessionImagePreviewKey,
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_IMAGE_PREVIEW_COUNT,
  sessionImagePreviewThreadId,
} from "./sessionImagePreviews";

const DATABASE_VERSION = 1;
const STORE_NAME = "previewGroups";
const DAY_MS = 24 * 60 * 60 * 1_000;
const SUPPORTED_IMAGE_TYPE_SET = new Set<string>(SUPPORTED_IMAGE_TYPES);

export const DEFAULT_IMAGE_PREVIEW_TTL_MS = 30 * DAY_MS;

export interface BrowserImagePreviewEntry {
  key: string;
  blobs: readonly Blob[];
  storedAt: number;
}

export interface BrowserImagePreviewStoreOptions {
  indexedDB?: IDBFactory | null;
  dbName?: string;
  now?: () => number;
  maxImages?: number;
  maxBytes?: number;
  ttlMs?: number;
}

interface StoredPreviewGroup {
  key: string;
  blobs: Blob[];
  storedAt: number;
  writeOrder: number;
}

interface RawStoredRecord {
  primaryKey: IDBValidKey;
  value: unknown;
}

function defaultIndexedDB(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedImageBlob(value: unknown, allowFile: boolean): value is Blob {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Blob;
  const objectTag = Object.prototype.toString.call(value);
  const hasFileBrand = (typeof File !== "undefined" && value instanceof File) ||
    objectTag === "[object File]";
  const hasBlobBrand = (typeof Blob !== "undefined" && value instanceof Blob) ||
    objectTag === "[object Blob]" ||
    hasFileBrand;
  return hasBlobBrand &&
    (allowFile || !hasFileBrand) &&
    typeof candidate.slice === "function" &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size >= 1 &&
    candidate.size <= MAX_IMAGE_BYTES &&
    SUPPORTED_IMAGE_TYPE_SET.has(candidate.type);
}

function parseStoredGroup(value: unknown): StoredPreviewGroup | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    !keys.includes("key") ||
    !keys.includes("blobs") ||
    !keys.includes("storedAt") ||
    !keys.includes("writeOrder") ||
    typeof value.key !== "string" ||
    !isSessionImagePreviewKey(value.key) ||
    !Array.isArray(value.blobs) ||
    value.blobs.length < 1 ||
    value.blobs.length > MAX_IMAGES_PER_TURN ||
    !value.blobs.every((blob) => isSupportedImageBlob(blob, false)) ||
    typeof value.storedAt !== "number" ||
    !Number.isFinite(value.storedAt) ||
    value.storedAt < 0 ||
    !Number.isSafeInteger(value.writeOrder) ||
    (value.writeOrder as number) < 0
  ) {
    return null;
  }
  return {
    key: value.key,
    blobs: value.blobs,
    storedAt: value.storedAt,
    writeOrder: value.writeOrder as number,
  };
}

function byteSize(group: StoredPreviewGroup): number {
  return group.blobs.reduce((total, blob) => total + blob.size, 0);
}

function compareOldestFirst(first: StoredPreviewGroup, second: StoredPreviewGroup): number {
  return first.writeOrder - second.writeOrder ||
    first.storedAt - second.storedAt ||
    first.key.localeCompare(second.key);
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function unavailableError(): Error {
  return new Error("IndexedDB is not available for browser image previews");
}

function closedError(): Error {
  return new Error("Browser image preview store is closed");
}

export class BrowserImagePreviewStore {
  readonly #indexedDB: IDBFactory | null;
  readonly #dbName: string;
  readonly #now: () => number;
  readonly #maxImages: number;
  readonly #maxBytes: number;
  readonly #ttlMs: number;
  #database: IDBDatabase | null = null;
  #opening: Promise<IDBDatabase> | null = null;
  #closed = false;

  constructor(options: BrowserImagePreviewStoreOptions = {}) {
    this.#indexedDB = Object.prototype.hasOwnProperty.call(options, "indexedDB")
      ? options.indexedDB ?? null
      : defaultIndexedDB();
    this.#dbName = options.dbName ?? "ask-codex-image-previews";
    this.#now = options.now ?? Date.now;
    this.#maxImages = requireNonNegativeInteger(
      options.maxImages ?? MAX_IMAGE_PREVIEW_COUNT,
      "maxImages",
    );
    this.#maxBytes = requireNonNegativeInteger(
      options.maxBytes ?? MAX_IMAGE_PREVIEW_BYTES,
      "maxBytes",
    );
    this.#ttlMs = requireNonNegativeInteger(
      options.ttlMs ?? DEFAULT_IMAGE_PREVIEW_TTL_MS,
      "ttlMs",
    );
    if (!this.#dbName) throw new TypeError("dbName must not be empty");
  }

  async remember(key: string, blobs: readonly Blob[]): Promise<void> {
    if (!isSessionImagePreviewKey(key)) {
      throw new TypeError("Image preview key must contain canonical thread and turn ids");
    }
    if (
      blobs.length < 1 ||
      blobs.length > MAX_IMAGES_PER_TURN ||
      !blobs.every((blob) => isSupportedImageBlob(blob, true))
    ) {
      throw new TypeError(
        `Image previews require 1-${MAX_IMAGES_PER_TURN} supported PNG, JPEG, or WebP blobs of at most ${MAX_IMAGE_BYTES} bytes each`,
      );
    }

    const storedAt = this.#readNow();
    // File is a Blob subclass; slicing prevents filenames from entering persistent storage.
    const storedBlobs = blobs.map((blob) => blob.slice(0, blob.size, blob.type));

    await this.#mutate((objectStore, rawRecords) => {
      const groups = this.#cleanAndCollect(objectStore, rawRecords, storedAt)
        .filter((candidate) => candidate.key !== key)
        .sort(compareOldestFirst);
      objectStore.delete(key);
      let writeOrder = (groups.at(-1)?.writeOrder ?? -1) + 1;
      if (!Number.isSafeInteger(writeOrder)) {
        groups.forEach((candidate, index) => {
          candidate.writeOrder = index;
          objectStore.put(candidate);
        });
        writeOrder = groups.length;
      }
      const group: StoredPreviewGroup = {
        key,
        blobs: storedBlobs,
        storedAt,
        writeOrder,
      };
      groups.push(group);
      const retained = this.#evictToBudget(objectStore, groups);
      if (retained.some((candidate) => candidate.key === key)) objectStore.put(group);
    });
  }

  async loadAll(): Promise<BrowserImagePreviewEntry[]> {
    const now = this.#readNow();
    return this.#mutate((objectStore, rawRecords) => {
      const groups = this.#cleanAndCollect(objectStore, rawRecords, now)
        .sort(compareOldestFirst);
      const retained = this.#evictToBudget(objectStore, groups);
      return retained.map((group) => ({
        key: group.key,
        blobs: [...group.blobs],
        storedAt: group.storedAt,
      }));
    });
  }

  async removeThread(threadId: string): Promise<void> {
    if (!threadId) throw new TypeError("threadId must not be empty");
    const now = this.#readNow();
    await this.#mutate((objectStore, rawRecords) => {
      const groups = this.#cleanAndCollect(objectStore, rawRecords, now);
      for (const group of groups) {
        if (sessionImagePreviewThreadId(group.key) === threadId) {
          objectStore.delete(group.key);
        }
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database?.close();
    this.#database = null;
  }

  #readNow(): number {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError("now must return a non-negative finite timestamp");
    }
    return value;
  }

  #cleanAndCollect(
    objectStore: IDBObjectStore,
    rawRecords: readonly RawStoredRecord[],
    now: number,
  ): StoredPreviewGroup[] {
    const groups: StoredPreviewGroup[] = [];
    for (const rawRecord of rawRecords) {
      const group = parseStoredGroup(rawRecord.value);
      if (
        !group ||
        group.key !== rawRecord.primaryKey ||
        now - group.storedAt >= this.#ttlMs
      ) {
        objectStore.delete(rawRecord.primaryKey);
        continue;
      }
      groups.push(group);
    }
    return groups;
  }

  #evictToBudget(
    objectStore: IDBObjectStore,
    sortedGroups: readonly StoredPreviewGroup[],
  ): StoredPreviewGroup[] {
    const retained = [...sortedGroups];
    let imageCount = retained.reduce((total, group) => total + group.blobs.length, 0);
    let bytes = retained.reduce((total, group) => total + byteSize(group), 0);
    while (imageCount > this.#maxImages || bytes > this.#maxBytes) {
      const oldest = retained.shift();
      if (!oldest) break;
      imageCount -= oldest.blobs.length;
      bytes -= byteSize(oldest);
      objectStore.delete(oldest.key);
    }
    return retained;
  }

  async #mutate<T>(
    mutation: (objectStore: IDBObjectStore, records: readonly RawStoredRecord[]) => T,
  ): Promise<T> {
    const database = await this.#open();
    if (this.#closed) throw closedError();

    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(STORE_NAME, "readwrite");
      } catch (error) {
        reject(error);
        return;
      }

      const objectStore = transaction.objectStore(STORE_NAME);
      const valuesRequest = objectStore.getAll();
      const keysRequest = objectStore.getAllKeys();
      let values: unknown[] | null = null;
      let keys: IDBValidKey[] | null = null;
      let result: T;
      let hasResult = false;
      let mutationError: unknown;

      const applyMutation = () => {
        if (values === null || keys === null || hasResult || mutationError !== undefined) return;
        try {
          result = mutation(
            objectStore,
            values.map((value, index) => ({ primaryKey: keys![index], value })),
          );
          hasResult = true;
        } catch (error) {
          mutationError = error;
          transaction.abort();
        }
      };

      valuesRequest.onsuccess = () => {
        values = valuesRequest.result;
        applyMutation();
      };
      keysRequest.onsuccess = () => {
        keys = keysRequest.result;
        applyMutation();
      };
      valuesRequest.onerror = () => {
        mutationError = valuesRequest.error;
      };
      keysRequest.onerror = () => {
        mutationError = keysRequest.error;
      };
      transaction.oncomplete = () => {
        if (hasResult) resolve(result!);
        else reject(mutationError ?? new Error("IndexedDB transaction completed without a result"));
      };
      transaction.onabort = () => {
        reject(mutationError ?? transaction.error ?? new Error("IndexedDB transaction was aborted"));
      };
      transaction.onerror = () => {
        mutationError ??= transaction.error;
      };
    });
  }

  #open(): Promise<IDBDatabase> {
    if (this.#closed) return Promise.reject(closedError());
    if (!this.#indexedDB) return Promise.reject(unavailableError());
    if (this.#database) return Promise.resolve(this.#database);
    if (this.#opening) return this.#opening;

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      let request: IDBOpenDBRequest;
      try {
        request = this.#indexedDB!.open(this.#dbName, DATABASE_VERSION);
      } catch (error) {
        reject(error);
        return;
      }

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onerror = () => fail(request.error ?? new Error("Could not open image preview storage"));
      request.onblocked = () => fail(new Error("Image preview storage is blocked by another page"));
      request.onsuccess = () => {
        const database = request.result;
        if (settled || this.#closed) {
          database.close();
          fail(closedError());
          return;
        }
        settled = true;
        database.onversionchange = () => {
          database.close();
          if (this.#database === database) this.#database = null;
        };
        database.onclose = () => {
          if (this.#database === database) this.#database = null;
        };
        this.#database = database;
        resolve(database);
      };
    });
    this.#opening = opening;
    const clearOpening = () => {
      if (this.#opening === opening) this.#opening = null;
    };
    void opening.then(clearOpening, clearOpening);
    return opening;
  }
}
