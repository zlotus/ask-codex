// @vitest-environment node

import {
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AttachmentStore,
  type AttachmentStoreLimits,
  type AttachmentStoreOptions,
} from "./attachments.js";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

describe("AttachmentStore", () => {
  const stores: AttachmentStore[] = [];
  const testDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await Promise.all(testDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  async function createStore(
    options: Omit<AttachmentStoreOptions, "baseDirectory"> = {},
  ): Promise<AttachmentStore> {
    const baseDirectory = await mkdtemp(join(tmpdir(), "ask-codex-attachment-test-"));
    testDirectories.push(baseDirectory);
    const store = new AttachmentStore({
      cleanupIntervalMs: 0,
      ...options,
      baseDirectory,
    });
    stores.push(store);
    return store;
  }

  function limits(
    overrides: Partial<AttachmentStoreLimits> = {},
  ): Partial<AttachmentStoreLimits> {
    return {
      maxAttachmentBytes: 1024,
      maxAttachmentsPerTurn: 4,
      maxAttachmentsPerOwner: 8,
      maxBytesPerOwner: 4096,
      maxStoredAttachments: 16,
      maxStoredBytes: 8192,
      ttlMs: 60_000,
      leaseTtlMs: 60_000,
      ...overrides,
    };
  }

  it("stores private files and exposes paths only through one-shot leases", async () => {
    const store = await createStore({ limits: limits() });
    const uploaded = await store.store("browser-session-a", {
      mediaType: "image/png",
      data: PNG,
    });

    expect(uploaded).toMatchObject({
      mediaType: "image/png",
      size: PNG.byteLength,
    });
    expect(uploaded.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(uploaded).not.toHaveProperty("path");

    const [lease] = await store.consumeForTurn("browser-session-a", [uploaded.id]);
    expect(await readFile(lease.path)).toEqual(PNG);
    expect((await stat(dirname(lease.path))).mode & 0o777).toBe(0o700);
    expect((await stat(lease.path)).mode & 0o777).toBe(0o600);

    await expect(
      store.consumeForTurn("browser-session-a", [uploaded.id]),
    ).rejects.toMatchObject({ code: "attachmentNotFound", statusCode: 404 });
    await expect(stat(lease.path)).resolves.toBeDefined();

    await lease.release();
    await expect(stat(lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("accepts only PNG, JPEG, and WebP with matching signatures", async () => {
    const store = await createStore({ limits: limits() });

    const png = await store.store("owner", {
      mediaType: " IMAGE/PNG ",
      data: PNG,
    });
    const jpeg = await store.store("owner", {
      mediaType: "image/jpeg",
      data: JPEG,
    });
    const webp = await store.store("owner", {
      mediaType: "image/webp",
      data: WEBP,
    });
    expect([png.mediaType, jpeg.mediaType, webp.mediaType]).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);

    await expect(store.store("owner", {
      mediaType: "image/gif",
      data: Buffer.from("GIF89a"),
    })).rejects.toMatchObject({ code: "unsupportedMediaType", statusCode: 415 });
    await expect(store.store("owner", {
      mediaType: "image/jpeg",
      data: PNG,
    })).rejects.toMatchObject({ code: "mediaTypeMismatch", statusCode: 415 });
    await expect(store.store("owner", {
      mediaType: "image/png; charset=binary",
      data: PNG,
    })).rejects.toMatchObject({ code: "unsupportedMediaType", statusCode: 415 });
    await expect(store.store("owner", {
      mediaType: "image/png",
      data: PNG.subarray(0, 16),
    })).rejects.toMatchObject({ code: "mediaTypeMismatch", statusCode: 415 });
  });

  it("rejects oversized images before reserving storage", async () => {
    const store = await createStore({
      limits: limits({ maxAttachmentBytes: PNG.byteLength - 1 }),
    });

    await expect(store.store("owner", {
      mediaType: "image/png",
      data: PNG,
    })).rejects.toMatchObject({ code: "attachmentTooLarge", statusCode: 413 });
  });

  it("isolates owners and validates a whole turn before consuming any ID", async () => {
    const store = await createStore({ limits: limits() });
    const first = await store.store("owner-a", {
      mediaType: "image/png",
      data: PNG,
    });
    const second = await store.store("owner-a", {
      mediaType: "image/jpeg",
      data: JPEG,
    });

    await expect(
      store.consumeForTurn("owner-b", [first.id]),
    ).rejects.toMatchObject({ code: "attachmentNotFound" });
    await expect(
      store.consumeForTurn("owner-a", [first.id, "x".repeat(32)]),
    ).rejects.toMatchObject({ code: "attachmentNotFound" });

    const leases = await store.consumeForTurn("owner-a", [first.id, second.id]);
    expect(leases.map((lease) => lease.id)).toEqual([first.id, second.id]);
    await Promise.all(leases.map((lease) => lease.release()));
  });

  it("rejects duplicate IDs and per-turn overflows without consuming files", async () => {
    const store = await createStore({
      limits: limits({ maxAttachmentsPerTurn: 1 }),
    });
    const first = await store.store("owner", {
      mediaType: "image/png",
      data: PNG,
    });
    const second = await store.store("owner", {
      mediaType: "image/jpeg",
      data: JPEG,
    });

    await expect(
      store.consumeForTurn("owner", [first.id, second.id]),
    ).rejects.toMatchObject({ code: "tooManyAttachments" });
    await expect(
      store.consumeForTurn("owner", [first.id, first.id]),
    ).rejects.toMatchObject({ code: "tooManyAttachments" });

    const [lease] = await store.consumeForTurn("owner", [first.id]);
    await lease.release();
    await store.discard("owner", second.id);
  });

  it("rejects duplicate IDs distinctly when they are within the turn limit", async () => {
    const store = await createStore({ limits: limits() });
    const uploaded = await store.store("owner", {
      mediaType: "image/png",
      data: PNG,
    });

    await expect(
      store.consumeForTurn("owner", [uploaded.id, uploaded.id]),
    ).rejects.toMatchObject({ code: "duplicateAttachment" });
    const [lease] = await store.consumeForTurn("owner", [uploaded.id]);
    await lease.release();
  });

  it("keeps leased files charged against owner and global quotas", async () => {
    const store = await createStore({
      limits: limits({
        maxAttachmentsPerOwner: 1,
        maxStoredAttachments: 2,
      }),
    });
    const first = await store.store("owner-a", {
      mediaType: "image/png",
      data: PNG,
    });
    const [lease] = await store.consumeForTurn("owner-a", [first.id]);

    await expect(store.store("owner-a", {
      mediaType: "image/jpeg",
      data: JPEG,
    })).rejects.toMatchObject({ code: "ownerAttachmentLimitExceeded" });

    await store.store("owner-b", { mediaType: "image/jpeg", data: JPEG });
    await expect(store.store("owner-c", {
      mediaType: "image/webp",
      data: WEBP,
    })).rejects.toMatchObject({ code: "storeAttachmentLimitExceeded" });

    await lease.release();
    await expect(store.store("owner-a", {
      mediaType: "image/webp",
      data: WEBP,
    })).resolves.toMatchObject({ mediaType: "image/webp" });
  });

  it("enforces owner and global resident-byte quotas", async () => {
    const ownerLimited = await createStore({
      limits: limits({ maxBytesPerOwner: PNG.byteLength }),
    });
    await ownerLimited.store("owner-a", { mediaType: "image/png", data: PNG });
    await expect(ownerLimited.store("owner-a", {
      mediaType: "image/jpeg",
      data: JPEG,
    })).rejects.toMatchObject({ code: "ownerByteLimitExceeded" });
    await expect(ownerLimited.store("owner-b", {
      mediaType: "image/jpeg",
      data: JPEG,
    })).resolves.toMatchObject({ size: JPEG.byteLength });

    const globallyLimited = await createStore({
      limits: limits({ maxStoredBytes: PNG.byteLength }),
    });
    await globallyLimited.store("owner-a", { mediaType: "image/png", data: PNG });
    await expect(globallyLimited.store("owner-b", {
      mediaType: "image/jpeg",
      data: JPEG,
    })).rejects.toMatchObject({ code: "storeByteLimitExceeded" });
  });

  it("enforces concurrent owner reservations", async () => {
    const store = await createStore({
      limits: limits({ maxAttachmentsPerOwner: 1 }),
    });

    const results = await Promise.allSettled([
      store.store("owner", { mediaType: "image/png", data: PNG }),
      store.store("owner", { mediaType: "image/jpeg", data: JPEG }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "ownerAttachmentLimitExceeded" },
    });
  });

  it("uses a longer safety expiry for leased files than pending uploads", async () => {
    let currentTime = 1_000;
    const store = await createStore({
      now: () => currentTime,
      limits: limits({ ttlMs: 100, leaseTtlMs: 1_000 }),
    });
    const leasedUpload = await store.store("owner", {
      mediaType: "image/png",
      data: PNG,
    });
    currentTime = 1_050;
    const [lease] = await store.consumeForTurn("owner", [leasedUpload.id]);
    expect(lease.expiresAt).toBe(2_050);
    const pending = await store.store("owner", {
      mediaType: "image/jpeg",
      data: JPEG,
    });

    currentTime = 1_151;
    expect(await store.sweepExpired()).toBe(1);
    await expect(stat(lease.path)).resolves.toBeDefined();
    await expect(
      store.consumeForTurn("owner", [pending.id]),
    ).rejects.toMatchObject({ code: "attachmentNotFound" });

    currentTime = 2_051;
    expect(await store.sweepExpired()).toBe(1);
    await expect(stat(lease.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("discards only pending attachments owned by the caller", async () => {
    const store = await createStore({ limits: limits() });
    const pending = await store.store("owner-a", {
      mediaType: "image/png",
      data: PNG,
    });

    await expect(store.discard("owner-b", pending.id)).rejects.toMatchObject({
      code: "attachmentNotFound",
    });
    await expect(store.discard("owner-a", pending.id)).resolves.toBeUndefined();
    await expect(store.discard("owner-a", pending.id)).rejects.toMatchObject({
      code: "attachmentNotFound",
    });

    const leasedUpload = await store.store("owner-a", {
      mediaType: "image/jpeg",
      data: JPEG,
    });
    const [lease] = await store.consumeForTurn("owner-a", [leasedUpload.id]);
    await expect(store.discard("owner-a", leasedUpload.id)).rejects.toMatchObject({
      code: "attachmentNotFound",
    });
    await lease.release();
  });

  it("removes its private directory on close and fails closed afterward", async () => {
    const store = await createStore({ limits: limits() });
    const uploaded = await store.store("owner", {
      mediaType: "image/png",
      data: PNG,
    });
    const [lease] = await store.consumeForTurn("owner", [uploaded.id]);
    const privateDirectory = dirname(lease.path);

    await store.close();
    await expect(stat(privateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.store("owner", {
      mediaType: "image/png",
      data: PNG,
    })).rejects.toMatchObject({ code: "storeClosed", statusCode: 503 });
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("fails closed without exposing filesystem errors", async () => {
    const baseDirectory = await mkdtemp(join(tmpdir(), "ask-codex-attachment-test-"));
    testDirectories.push(baseDirectory);
    const missingDirectory = join(baseDirectory, "missing");
    const store = new AttachmentStore({
      baseDirectory: missingDirectory,
      cleanupIntervalMs: 0,
      limits: limits(),
    });
    stores.push(store);

    let failure: unknown;
    try {
      await store.store("owner", { mediaType: "image/png", data: PNG });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "storageUnavailable",
      statusCode: 500,
      message: "Attachment storage is unavailable",
    });
    expect(String(failure)).not.toContain(missingDirectory);
  });
});
