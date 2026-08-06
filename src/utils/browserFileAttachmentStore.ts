import { MAX_ATTACHMENTS_PER_TURN, MAX_FILE_BYTES } from "./attachments";
import {
  isSessionFileAttachmentKey,
  MAX_LOCAL_FILE_BYTES,
  MAX_LOCAL_FILE_COUNT,
  sessionFileAttachmentThreadId,
  type LocalFileAttachment,
} from "./sessionFileAttachments";

const DATABASE_VERSION = 1;
const STORE_NAME = "fileGroups";
const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_FILE_ATTACHMENT_TTL_MS = 30 * DAY_MS;

export interface BrowserFileAttachmentEntry {
  files: readonly LocalFileAttachment[];
  key: string;
  storedAt: number;
}

export interface BrowserFileAttachmentStoreOptions {
  dbName?: string;
  indexedDB?: IDBFactory | null;
  maxBytes?: number;
  maxFiles?: number;
  now?: () => number;
  ttlMs?: number;
}

interface StoredFileGroup {
  files: LocalFileAttachment[];
  key: string;
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

function isBlob(value: unknown): value is Blob {
  const tag = Object.prototype.toString.call(value);
  return typeof value === "object" &&
    value !== null &&
    ((typeof Blob !== "undefined" && value instanceof Blob) || tag === "[object Blob]") &&
    typeof (value as Blob).slice === "function";
}

function parseFile(value: unknown): LocalFileAttachment | null {
  if (!isRecord(value) || Object.keys(value).length !== 4) return null;
  const { blob, mediaType, name, size } = value;
  if (
    !isBlob(blob) ||
    typeof mediaType !== "string" ||
    mediaType.length < 1 ||
    mediaType.length > 127 ||
    typeof name !== "string" ||
    name.length < 1 ||
    new TextEncoder().encode(name).byteLength > 255 ||
    !Number.isSafeInteger(size) ||
    (size as number) < 1 ||
    (size as number) > MAX_FILE_BYTES ||
    blob.size !== size
  ) {
    return null;
  }
  return { blob, mediaType, name, size: size as number };
}

function parseStoredGroup(value: unknown): StoredFileGroup | null {
  if (!isRecord(value) || Object.keys(value).length !== 4) return null;
  const files = Array.isArray(value.files)
    ? value.files.map(parseFile)
    : [];
  if (
    typeof value.key !== "string" ||
    !isSessionFileAttachmentKey(value.key) ||
    files.length < 1 ||
    files.length > MAX_ATTACHMENTS_PER_TURN ||
    files.some((file) => file === null) ||
    typeof value.storedAt !== "number" ||
    !Number.isFinite(value.storedAt) ||
    value.storedAt < 0 ||
    !Number.isSafeInteger(value.writeOrder) ||
    (value.writeOrder as number) < 0
  ) {
    return null;
  }
  return {
    files: files as LocalFileAttachment[],
    key: value.key,
    storedAt: value.storedAt,
    writeOrder: value.writeOrder as number,
  };
}

function byteSize(group: StoredFileGroup): number {
  return group.files.reduce((total, file) => total + file.size, 0);
}

function oldestFirst(first: StoredFileGroup, second: StoredFileGroup): number {
  return first.writeOrder - second.writeOrder ||
    first.storedAt - second.storedAt ||
    first.key.localeCompare(second.key);
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export class BrowserFileAttachmentStore {
  readonly #indexedDB: IDBFactory | null;
  readonly #dbName: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #now: () => number;
  readonly #ttlMs: number;
  #closed = false;
  #database: IDBDatabase | null = null;
  #opening: Promise<IDBDatabase> | null = null;

  constructor(options: BrowserFileAttachmentStoreOptions = {}) {
    this.#indexedDB = Object.prototype.hasOwnProperty.call(options, "indexedDB")
      ? options.indexedDB ?? null
      : defaultIndexedDB();
    this.#dbName = options.dbName ?? "ask-codex-file-attachments";
    this.#maxBytes = nonNegativeInteger(options.maxBytes ?? MAX_LOCAL_FILE_BYTES, "maxBytes");
    this.#maxFiles = nonNegativeInteger(options.maxFiles ?? MAX_LOCAL_FILE_COUNT, "maxFiles");
    this.#now = options.now ?? Date.now;
    this.#ttlMs = nonNegativeInteger(
      options.ttlMs ?? DEFAULT_FILE_ATTACHMENT_TTL_MS,
      "ttlMs",
    );
    if (!this.#dbName) throw new TypeError("dbName must not be empty");
  }

  async remember(key: string, files: readonly LocalFileAttachment[]): Promise<void> {
    if (!isSessionFileAttachmentKey(key)) {
      throw new TypeError("File attachment key must contain canonical thread and turn ids");
    }
    if (
      files.length < 1 ||
      files.length > MAX_ATTACHMENTS_PER_TURN ||
      files.some((file) => parseFile(file) === null)
    ) {
      throw new TypeError("File attachments are invalid or exceed local storage limits");
    }
    const storedAt = this.#readNow();
    const storedFiles = files.map((file): LocalFileAttachment => ({
      blob: file.blob.slice(0, file.size, file.mediaType),
      mediaType: file.mediaType,
      name: file.name,
      size: file.size,
    }));

    await this.#mutate((objectStore, records) => {
      const groups = this.#clean(objectStore, records, storedAt)
        .filter((group) => group.key !== key)
        .sort(oldestFirst);
      objectStore.delete(key);
      let writeOrder = (groups.at(-1)?.writeOrder ?? -1) + 1;
      if (!Number.isSafeInteger(writeOrder)) {
        groups.forEach((group, index) => {
          group.writeOrder = index;
          objectStore.put(group);
        });
        writeOrder = groups.length;
      }
      const group = { files: storedFiles, key, storedAt, writeOrder };
      groups.push(group);
      if (this.#evict(objectStore, groups).some((candidate) => candidate.key === key)) {
        objectStore.put(group);
      }
    });
  }

  async loadAll(): Promise<BrowserFileAttachmentEntry[]> {
    const now = this.#readNow();
    return this.#mutate((objectStore, records) => (
      this.#evict(objectStore, this.#clean(objectStore, records, now).sort(oldestFirst))
        .map((group) => ({
          files: group.files.map((file) => ({ ...file })),
          key: group.key,
          storedAt: group.storedAt,
        }))
    ));
  }

  async removeThread(threadId: string): Promise<void> {
    if (!threadId) throw new TypeError("threadId must not be empty");
    const now = this.#readNow();
    await this.#mutate((objectStore, records) => {
      for (const group of this.#clean(objectStore, records, now)) {
        if (sessionFileAttachmentThreadId(group.key) === threadId) objectStore.delete(group.key);
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

  #clean(
    objectStore: IDBObjectStore,
    records: readonly RawStoredRecord[],
    now: number,
  ): StoredFileGroup[] {
    const groups: StoredFileGroup[] = [];
    for (const record of records) {
      const group = parseStoredGroup(record.value);
      if (!group || group.key !== record.primaryKey || now - group.storedAt >= this.#ttlMs) {
        objectStore.delete(record.primaryKey);
      } else {
        groups.push(group);
      }
    }
    return groups;
  }

  #evict(
    objectStore: IDBObjectStore,
    sortedGroups: readonly StoredFileGroup[],
  ): StoredFileGroup[] {
    const retained = [...sortedGroups];
    let fileCount = retained.reduce((total, group) => total + group.files.length, 0);
    let bytes = retained.reduce((total, group) => total + byteSize(group), 0);
    while (fileCount > this.#maxFiles || bytes > this.#maxBytes) {
      const oldest = retained.shift();
      if (!oldest) break;
      fileCount -= oldest.files.length;
      bytes -= byteSize(oldest);
      objectStore.delete(oldest.key);
    }
    return retained;
  }

  async #mutate<T>(
    mutation: (store: IDBObjectStore, records: readonly RawStoredRecord[]) => T,
  ): Promise<T> {
    const database = await this.#open();
    if (this.#closed) throw new Error("Browser file attachment store is closed");
    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(STORE_NAME, "readwrite");
      } catch (error) {
        reject(error);
        return;
      }
      const store = transaction.objectStore(STORE_NAME);
      const valuesRequest = store.getAll();
      const keysRequest = store.getAllKeys();
      let values: unknown[] | null = null;
      let keys: IDBValidKey[] | null = null;
      let result: T;
      let applied = false;
      let mutationError: unknown;
      const apply = () => {
        if (values === null || keys === null || applied || mutationError !== undefined) return;
        try {
          result = mutation(
            store,
            values.map((value, index) => ({ primaryKey: keys![index], value })),
          );
          applied = true;
        } catch (error) {
          mutationError = error;
          transaction.abort();
        }
      };
      valuesRequest.onsuccess = () => {
        values = valuesRequest.result;
        apply();
      };
      keysRequest.onsuccess = () => {
        keys = keysRequest.result;
        apply();
      };
      valuesRequest.onerror = () => { mutationError = valuesRequest.error; };
      keysRequest.onerror = () => { mutationError = keysRequest.error; };
      transaction.oncomplete = () => {
        if (applied) resolve(result!);
        else reject(mutationError ?? new Error("IndexedDB transaction completed without a result"));
      };
      transaction.onabort = () => {
        reject(mutationError ?? transaction.error ?? new Error("IndexedDB transaction was aborted"));
      };
      transaction.onerror = () => { mutationError ??= transaction.error; };
    });
  }

  #open(): Promise<IDBDatabase> {
    if (this.#closed) return Promise.reject(new Error("Browser file attachment store is closed"));
    if (!this.#indexedDB) return Promise.reject(new Error("IndexedDB is unavailable"));
    if (this.#database) return Promise.resolve(this.#database);
    if (this.#opening) return this.#opening;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.#indexedDB!.open(this.#dbName, DATABASE_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onerror = () => reject(request.error ?? new Error("Could not open file storage"));
      request.onblocked = () => reject(new Error("File storage is blocked by another page"));
      request.onsuccess = () => {
        const database = request.result;
        if (this.#closed) {
          database.close();
          reject(new Error("Browser file attachment store is closed"));
          return;
        }
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
    const clear = () => {
      if (this.#opening === opening) this.#opening = null;
    };
    void opening.then(clear, clear);
    return opening;
  }
}
