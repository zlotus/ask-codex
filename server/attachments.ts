import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdtemp,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const SUPPORTED_ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type AttachmentMediaType =
  (typeof SUPPORTED_ATTACHMENT_MEDIA_TYPES)[number];

export interface AttachmentStoreLimits {
  maxAttachmentBytes: number;
  maxAttachmentsPerTurn: number;
  maxAttachmentsPerOwner: number;
  maxBytesPerOwner: number;
  maxStoredAttachments: number;
  maxStoredBytes: number;
  ttlMs: number;
  leaseTtlMs: number;
}

export const DEFAULT_ATTACHMENT_STORE_LIMITS: Readonly<AttachmentStoreLimits> =
  Object.freeze({
    maxAttachmentBytes: 10 * 1024 * 1024,
    maxAttachmentsPerTurn: 4,
    maxAttachmentsPerOwner: 8,
    maxBytesPerOwner: 40 * 1024 * 1024,
    maxStoredAttachments: 32,
    maxStoredBytes: 64 * 1024 * 1024,
    ttlMs: 10 * 60 * 1000,
    leaseTtlMs: 6 * 60 * 60 * 1000,
  });

export interface AttachmentStoreOptions {
  baseDirectory?: string;
  cleanupIntervalMs?: number;
  limits?: Partial<AttachmentStoreLimits>;
  now?: () => number;
}

export interface AttachmentUpload {
  mediaType: string;
  data: Uint8Array;
}

export interface StoredAttachment {
  id: string;
  mediaType: AttachmentMediaType;
  size: number;
  expiresAt: number;
}

export interface AttachmentLease extends StoredAttachment {
  path: string;
  release(): Promise<void>;
}

export type AttachmentStoreErrorCode =
  | "invalidOwner"
  | "invalidPayload"
  | "unsupportedMediaType"
  | "mediaTypeMismatch"
  | "attachmentTooLarge"
  | "ownerAttachmentLimitExceeded"
  | "ownerByteLimitExceeded"
  | "storeAttachmentLimitExceeded"
  | "storeByteLimitExceeded"
  | "tooManyAttachments"
  | "duplicateAttachment"
  | "attachmentNotFound"
  | "storeClosed"
  | "storageUnavailable";

export class AttachmentStoreError extends Error {
  constructor(
    readonly code: AttachmentStoreErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentStoreError";
  }
}

interface OwnerUsage {
  count: number;
  bytes: number;
}

interface AttachmentRecord extends StoredAttachment {
  ownerId: string;
  path: string;
  state: "pending" | "leased" | "deleting";
  deletion?: Promise<void>;
}

const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const MAX_OWNER_ID_CHARACTERS = 256;
const FILE_CREATION_ATTEMPTS = 5;

const EXTENSIONS: Record<AttachmentMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function storageUnavailable(): AttachmentStoreError {
  return new AttachmentStoreError(
    "storageUnavailable",
    500,
    "Attachment storage is unavailable",
  );
}

function normalizeMediaType(value: string): AttachmentMediaType | undefined {
  const normalized = value.trim().toLowerCase();
  return SUPPORTED_ATTACHMENT_MEDIA_TYPES.find(
    (mediaType) => mediaType === normalized,
  );
}

function startsWithBytes(data: Uint8Array, signature: readonly number[]): boolean {
  return data.byteLength >= signature.length &&
    signature.every((byte, index) => data[index] === byte);
}

function asciiAt(data: Uint8Array, offset: number, value: string): boolean {
  if (data.byteLength < offset + value.length) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function detectedMediaType(data: Uint8Array): AttachmentMediaType | undefined {
  if (
    startsWithBytes(data, [137, 80, 78, 71, 13, 10, 26, 10]) &&
    data.byteLength >= 24 &&
    data[8] === 0 &&
    data[9] === 0 &&
    data[10] === 0 &&
    data[11] === 13 &&
    asciiAt(data, 12, "IHDR")
  ) {
    return "image/png";
  }

  if (
    data.byteLength >= 4 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff &&
    data[3] !== 0x00 &&
    data[3] !== 0xff
  ) {
    return "image/jpeg";
  }

  if (
    data.byteLength >= 16 &&
    asciiAt(data, 0, "RIFF") &&
    asciiAt(data, 8, "WEBP") &&
    (asciiAt(data, 12, "VP8 ") ||
      asciiAt(data, 12, "VP8L") ||
      asciiAt(data, 12, "VP8X"))
  ) {
    const declaredSize = data[4] |
      (data[5] << 8) |
      (data[6] << 16) |
      (data[7] << 24);
    if ((declaredSize >>> 0) + 8 === data.byteLength) {
      return "image/webp";
    }
  }

  return undefined;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function assertOwnerId(ownerId: string): void {
  if (
    typeof ownerId !== "string" ||
    ownerId.length === 0 ||
    ownerId.length > MAX_OWNER_ID_CHARACTERS ||
    ownerId.trim() !== ownerId ||
    hasControlCharacter(ownerId)
  ) {
    throw new AttachmentStoreError(
      "invalidOwner",
      400,
      "Attachment owner is invalid",
    );
  }
}

function attachmentNotFound(): AttachmentStoreError {
  return new AttachmentStoreError(
    "attachmentNotFound",
    404,
    "Attachment was not found",
  );
}

/**
 * Stores short-lived browser uploads without exposing a general file endpoint.
 * An owner ID is an opaque, server-assigned quota scope, not an authentication token.
 */
export class AttachmentStore {
  readonly limits: Readonly<AttachmentStoreLimits>;

  private readonly baseDirectory: string;
  private readonly cleanupIntervalMs: number;
  private readonly now: () => number;
  private readonly records = new Map<string, AttachmentRecord>();
  private readonly ownerUsage = new Map<string, OwnerUsage>();
  private readonly operations = new Set<Promise<unknown>>();
  private directoryPromise: Promise<string> | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private closePromise: Promise<void> | undefined;
  private storedCount = 0;
  private storedBytes = 0;
  private closed = false;

  constructor(options: AttachmentStoreOptions = {}) {
    const limits = {
      ...DEFAULT_ATTACHMENT_STORE_LIMITS,
      ...options.limits,
    };
    for (const [label, value] of Object.entries(limits)) {
      assertPositiveInteger(value, label);
    }

    const cleanupIntervalMs = options.cleanupIntervalMs ??
      DEFAULT_CLEANUP_INTERVAL_MS;
    if (!Number.isSafeInteger(cleanupIntervalMs) || cleanupIntervalMs < 0) {
      throw new RangeError("cleanupIntervalMs must be a non-negative safe integer");
    }

    this.baseDirectory = options.baseDirectory ?? tmpdir();
    if (!isAbsolute(this.baseDirectory)) {
      throw new Error("Attachment baseDirectory must be an absolute path");
    }
    this.limits = Object.freeze(limits);
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.now = options.now ?? Date.now;

    if (this.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        void this.sweepExpired().catch(() => undefined);
      }, this.cleanupIntervalMs);
      this.cleanupTimer.unref();
    }
  }

  store(ownerId: string, upload: AttachmentUpload): Promise<StoredAttachment> {
    return this.runOperation(() => this.storeInternal(ownerId, upload));
  }

  consumeForTurn(
    ownerId: string,
    attachmentIds: readonly string[],
  ): Promise<AttachmentLease[]> {
    return this.runOperation(() =>
      this.consumeForTurnInternal(ownerId, attachmentIds));
  }

  discard(ownerId: string, attachmentId: string): Promise<void> {
    return this.runOperation(() => this.discardInternal(ownerId, attachmentId));
  }

  sweepExpired(): Promise<number> {
    return this.runOperation(() => this.sweepExpiredInternal(this.now()));
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closed = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    this.closePromise = (async () => {
      await Promise.allSettled([...this.operations]);
      const directory = await this.directoryPromise?.catch(() => undefined);
      try {
        if (directory) {
          await rm(directory, { recursive: true, force: true });
        }
      } catch {
        throw storageUnavailable();
      } finally {
        this.records.clear();
        this.ownerUsage.clear();
        this.storedCount = 0;
        this.storedBytes = 0;
      }
    })();
    return this.closePromise;
  }

  private runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new AttachmentStoreError(
        "storeClosed",
        503,
        "Attachment storage is closed",
      ));
    }

    const promise = operation();
    this.operations.add(promise);
    void promise.then(
      () => this.operations.delete(promise),
      () => this.operations.delete(promise),
    );
    return promise;
  }

  private async storeInternal(
    ownerId: string,
    upload: AttachmentUpload,
  ): Promise<StoredAttachment> {
    assertOwnerId(ownerId);
    if (!(upload?.data instanceof Uint8Array) || typeof upload.mediaType !== "string") {
      throw new AttachmentStoreError(
        "invalidPayload",
        400,
        "Attachment payload is invalid",
      );
    }

    const mediaType = normalizeMediaType(upload.mediaType);
    if (!mediaType) {
      throw new AttachmentStoreError(
        "unsupportedMediaType",
        415,
        "Attachment media type is not supported",
      );
    }
    const size = upload.data.byteLength;
    if (size > this.limits.maxAttachmentBytes) {
      throw new AttachmentStoreError(
        "attachmentTooLarge",
        413,
        "Attachment exceeds the per-file size limit",
      );
    }
    if (detectedMediaType(upload.data) !== mediaType) {
      throw new AttachmentStoreError(
        "mediaTypeMismatch",
        415,
        "Attachment content does not match its media type",
      );
    }

    const directory = await this.ensureDirectory();
    if (this.closed) {
      throw new AttachmentStoreError(
        "storeClosed",
        503,
        "Attachment storage is closed",
      );
    }
    await this.sweepExpiredInternal(this.now());
    this.reserve(ownerId, size);

    let storedPath: string | undefined;
    let committed = false;
    let mayReleaseReservation = true;
    try {
      let id: string | undefined;
      for (let attempt = 0; attempt < FILE_CREATION_ATTEMPTS; attempt += 1) {
        const candidate = randomBytes(24).toString("base64url");
        if (!ATTACHMENT_ID_PATTERN.test(candidate) || this.records.has(candidate)) {
          continue;
        }
        const candidatePath = join(directory, `${candidate}.${EXTENSIONS[mediaType]}`);
        try {
          await writeFile(candidatePath, upload.data, {
            flag: "wx",
            mode: 0o600,
          });
          id = candidate;
          storedPath = candidatePath;
          break;
        } catch (error) {
          if (isNodeError(error) && error.code === "EEXIST") {
            continue;
          }
          try {
            await unlink(candidatePath);
          } catch (unlinkError) {
            if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") {
              mayReleaseReservation = false;
            }
          }
          throw storageUnavailable();
        }
      }
      if (!id || !storedPath) {
        throw storageUnavailable();
      }
      if (this.closed) {
        throw new AttachmentStoreError(
          "storeClosed",
          503,
          "Attachment storage is closed",
        );
      }

      const record: AttachmentRecord = {
        id,
        ownerId,
        mediaType,
        size,
        expiresAt: this.now() + this.limits.ttlMs,
        path: storedPath,
        state: "pending",
      };
      this.records.set(id, record);
      committed = true;
      return {
        id: record.id,
        mediaType: record.mediaType,
        size: record.size,
        expiresAt: record.expiresAt,
      };
    } catch (error) {
      if (storedPath) {
        try {
          await unlink(storedPath);
        } catch (unlinkError) {
          if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") {
            mayReleaseReservation = false;
            throw storageUnavailable();
          }
        }
      }
      if (error instanceof AttachmentStoreError) {
        throw error;
      }
      throw storageUnavailable();
    } finally {
      if (!committed && mayReleaseReservation) {
        this.releaseReservation(ownerId, size);
      }
    }
  }

  private async consumeForTurnInternal(
    ownerId: string,
    attachmentIds: readonly string[],
  ): Promise<AttachmentLease[]> {
    assertOwnerId(ownerId);
    if (!Array.isArray(attachmentIds)) {
      throw new AttachmentStoreError(
        "invalidPayload",
        400,
        "Attachment IDs are invalid",
      );
    }
    if (attachmentIds.length > this.limits.maxAttachmentsPerTurn) {
      throw new AttachmentStoreError(
        "tooManyAttachments",
        400,
        "Turn contains too many attachments",
      );
    }

    const uniqueIds = new Set(attachmentIds);
    if (uniqueIds.size !== attachmentIds.length) {
      throw new AttachmentStoreError(
        "duplicateAttachment",
        400,
        "Turn contains a duplicate attachment",
      );
    }

    const now = this.now();
    await this.sweepExpiredInternal(now);
    const records = attachmentIds.map((attachmentId) => {
      if (
        typeof attachmentId !== "string" ||
        !ATTACHMENT_ID_PATTERN.test(attachmentId)
      ) {
        throw attachmentNotFound();
      }
      const record = this.records.get(attachmentId);
      if (
        !record ||
        record.ownerId !== ownerId ||
        record.state !== "pending" ||
        record.expiresAt <= now
      ) {
        throw attachmentNotFound();
      }
      return record;
    });

    return records.map((record) => {
      record.state = "leased";
      record.expiresAt = now + this.limits.leaseTtlMs;
      return Object.freeze({
        id: record.id,
        mediaType: record.mediaType,
        size: record.size,
        expiresAt: record.expiresAt,
        path: record.path,
        release: () => this.releaseLease(record),
      });
    });
  }

  private async discardInternal(
    ownerId: string,
    attachmentId: string,
  ): Promise<void> {
    assertOwnerId(ownerId);
    await this.sweepExpiredInternal(this.now());
    const record = this.records.get(attachmentId);
    if (
      !ATTACHMENT_ID_PATTERN.test(attachmentId) ||
      !record ||
      record.ownerId !== ownerId ||
      record.state !== "pending"
    ) {
      throw attachmentNotFound();
    }
    await this.removeRecord(record);
  }

  private releaseLease(record: AttachmentRecord): Promise<void> {
    if (this.closed || this.records.get(record.id) !== record) {
      return Promise.resolve();
    }
    return this.runOperation(() => this.removeRecord(record));
  }

  private async sweepExpiredInternal(now: number): Promise<number> {
    const expired = [...this.records.values()].filter(
      (record) => record.expiresAt <= now,
    );
    await Promise.all(expired.map((record) => this.removeRecord(record)));
    return expired.length;
  }

  private removeRecord(record: AttachmentRecord): Promise<void> {
    if (this.records.get(record.id) !== record) {
      return Promise.resolve();
    }
    if (record.deletion) {
      return record.deletion;
    }

    const previousState = record.state;
    record.state = "deleting";
    const deletion = (async () => {
      try {
        await unlink(record.path);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw storageUnavailable();
        }
      }
      if (this.records.get(record.id) === record) {
        this.records.delete(record.id);
        this.releaseReservation(record.ownerId, record.size);
      }
    })().catch((error: unknown) => {
      if (this.records.get(record.id) === record) {
        record.state = previousState;
        record.deletion = undefined;
      }
      if (error instanceof AttachmentStoreError) {
        throw error;
      }
      throw storageUnavailable();
    });
    record.deletion = deletion;
    return deletion;
  }

  private reserve(ownerId: string, size: number): void {
    const usage = this.ownerUsage.get(ownerId) ?? { count: 0, bytes: 0 };
    if (usage.count >= this.limits.maxAttachmentsPerOwner) {
      throw new AttachmentStoreError(
        "ownerAttachmentLimitExceeded",
        429,
        "Attachment count limit was reached for this client",
      );
    }
    if (usage.bytes > this.limits.maxBytesPerOwner - size) {
      throw new AttachmentStoreError(
        "ownerByteLimitExceeded",
        429,
        "Attachment byte limit was reached for this client",
      );
    }
    if (this.storedCount >= this.limits.maxStoredAttachments) {
      throw new AttachmentStoreError(
        "storeAttachmentLimitExceeded",
        429,
        "Attachment storage count limit was reached",
      );
    }
    if (this.storedBytes > this.limits.maxStoredBytes - size) {
      throw new AttachmentStoreError(
        "storeByteLimitExceeded",
        429,
        "Attachment storage byte limit was reached",
      );
    }

    usage.count += 1;
    usage.bytes += size;
    this.ownerUsage.set(ownerId, usage);
    this.storedCount += 1;
    this.storedBytes += size;
  }

  private releaseReservation(ownerId: string, size: number): void {
    const usage = this.ownerUsage.get(ownerId);
    if (usage) {
      usage.count -= 1;
      usage.bytes -= size;
      if (usage.count <= 0) {
        this.ownerUsage.delete(ownerId);
      }
    }
    this.storedCount = Math.max(0, this.storedCount - 1);
    this.storedBytes = Math.max(0, this.storedBytes - size);
  }

  private ensureDirectory(): Promise<string> {
    this.directoryPromise ??= this.createPrivateDirectory();
    return this.directoryPromise;
  }

  private async createPrivateDirectory(): Promise<string> {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(this.baseDirectory, "ask-codex-attachments-"));
      await chmod(directory, 0o700);
      return directory;
    } catch {
      if (directory) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
      throw storageUnavailable();
    }
  }
}
