// @vitest-environment node

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_MESSAGE_QUEUE_TEXT_BYTES,
  MessageQueueStore,
} from "./message-queue.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function queueFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ask-codex-queue-test-"));
  directories.push(directory);
  return join(directory, "queue.json");
}

describe("MessageQueueStore", () => {
  it("persists queued text and hides terminal records from thread lists", async () => {
    const filePath = await queueFile();
    const now = 1_000;
    const store = new MessageQueueStore({
      filePath,
      now: () => now,
      makeId: () => "a".repeat(32),
    });
    const queued = store.enqueue({
      threadId: "thread-1",
      text: "continue on another device",
      expectedLastTurnId: "turn-1",
    });
    expect(queued.status).toBe("queued");
    expect(store.list("thread-1").items).toEqual([queued]);

    const reloaded = new MessageQueueStore({ filePath, now: () => now });
    expect(reloaded.list("thread-1").items[0]).toMatchObject({
      id: queued.id,
      text: queued.text,
      expectedLastTurnId: "turn-1",
    });

    const claimed = reloaded.claim(queued.id, queued.revision, "claim-1", false);
    const cancelled = reloaded.cancel(
      reloaded.markNeedsReview(claimed.id, "claim-1", "threadBusy").id,
      claimed.revision + 1,
    );
    expect(cancelled.status).toBe("cancelled");
    expect(reloaded.list("thread-1").items).toEqual([]);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ version: 1 });
  });

  it("recovers pre-dispatch claims but quarantines dispatching records", async () => {
    const filePath = await queueFile();
    let nextId = 0;
    const makeId = () => `${++nextId}`.padStart(32, "a");
    const store = new MessageQueueStore({ filePath, now: () => 2_000, makeId });
    const safe = store.enqueue({ threadId: "thread-1", text: "safe", expectedLastTurnId: null });
    const unknown = store.enqueue({ threadId: "thread-1", text: "unknown", expectedLastTurnId: null });
    store.claim(safe.id, safe.revision, "claim-safe", false);
    const unknownClaim = store.claim(unknown.id, unknown.revision, "claim-unknown", false);
    store.markDispatching(unknown.id, "claim-unknown");

    const recovered = new MessageQueueStore({ filePath, now: () => 3_000 });
    expect(recovered.list("thread-1").items).toEqual([
      expect.objectContaining({ id: safe.id, status: "queued", revision: 3 }),
      expect.objectContaining({ id: unknown.id, status: "indeterminate", revision: unknownClaim.revision + 2 }),
    ]);
  });

  it("requires revision matching and explicit review acknowledgement", () => {
    const store = new MessageQueueStore({ makeId: () => "b".repeat(32) });
    const queued = store.enqueue({ threadId: "thread-1", text: "one", expectedLastTurnId: null });
    expect(() => store.claim(queued.id, queued.revision + 1, "claim", false))
      .toThrow("refresh before retrying");

    const claim = store.claim(queued.id, queued.revision, "claim", false);
    const review = store.markNeedsReview(claim.id, "claim", "contextChanged");
    expect(() => store.claim(review.id, review.revision, "claim-2", false))
      .toThrow("requires explicit review");
    expect(store.claim(review.id, review.revision, "claim-2", true).status).toBe("claimed");
  });

  it("expires active records and enforces active and byte budgets", () => {
    let now = 1_000;
    let nextId = 0;
    const store = new MessageQueueStore({
      now: () => now,
      makeId: () => `${++nextId}`.padStart(32, "c"),
      limits: {
        maxActiveItems: 1,
        maxRecords: 2,
        maxStoreBytes: MAX_MESSAGE_QUEUE_TEXT_BYTES + 2_048,
        activeTtlMs: 100,
        terminalRetentionMs: 100,
      },
    });
    store.enqueue({ threadId: "thread-1", text: "one", expectedLastTurnId: null });
    expect(() => store.enqueue({ threadId: "thread-1", text: "two", expectedLastTurnId: null }))
      .toThrow("queue is full");
    now = 1_101;
    expect(store.list("thread-1").items).toEqual([]);
    expect(store.enqueue({ threadId: "thread-1", text: "two", expectedLastTurnId: null }).status)
      .toBe("queued");
  });

  it("enforces text limits at the store boundary", () => {
    let nextId = 0;
    const store = new MessageQueueStore({
      makeId: () => `${++nextId}`.padStart(32, "d"),
    });
    expect(() => store.enqueue({
      threadId: "thread-1",
      text: " ",
      expectedLastTurnId: null,
    })).toThrow("non-empty text");
    expect(() => store.enqueue({
      threadId: "thread-1",
      text: "x".repeat(MAX_MESSAGE_QUEUE_TEXT_BYTES + 1),
      expectedLastTurnId: null,
    })).toThrow("64 KiB");
    expect(() => store.enqueue({
      threadId: "thread-1",
      text: "valid",
      expectedLastTurnId: "x".repeat(257),
    })).toThrow("invalid last turn ID");
  });

  it("creates private directories and atomically replaced files", async () => {
    const root = await mkdtemp(join(tmpdir(), "ask-codex-queue-mode-test-"));
    directories.push(root);
    const filePath = join(root, "private-state", "queue.json");
    const store = new MessageQueueStore({
      filePath,
      makeId: () => "e".repeat(32),
    });
    store.enqueue({ threadId: "thread-1", text: "private", expectedLastTurnId: null });

    expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await readFile(filePath, "utf8"))).toContain("private");
  });

  it("fails closed on corrupt, oversized, or over-active persisted state", async () => {
    const filePath = await queueFile();
    await writeFile(filePath, "not-json", "utf8");
    expect(() => new MessageQueueStore({ filePath })).toThrow();

    await writeFile(filePath, JSON.stringify({ version: 2, revision: 0, items: [] }), "utf8");
    expect(() => new MessageQueueStore({ filePath })).toThrow("unsupported queue document");

    const activeItem = (id: string) => ({
      id,
      threadId: "thread-1",
      text: "queued",
      expectedLastTurnId: null,
      status: "queued",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 10_000,
    });
    await writeFile(filePath, JSON.stringify({
      version: 1,
      revision: 1,
      items: [activeItem("f".repeat(32)), activeItem("g".repeat(32))],
    }), "utf8");
    expect(() => new MessageQueueStore({
      filePath,
      limits: { maxActiveItems: 1, maxRecords: 2 },
      now: () => 2,
    })).toThrow("too many active queue items");

    await writeFile(filePath, JSON.stringify({
      version: 1,
      revision: 1,
      items: [{ ...activeItem("h".repeat(32)), status: "dispatching" }],
    }), "utf8");
    expect(() => new MessageQueueStore({ filePath, now: () => 2 }))
      .toThrow("invalid claim state");

    await writeFile(filePath, "x".repeat(257), "utf8");
    expect(() => new MessageQueueStore({
      filePath,
      limits: { maxStoreBytes: 256 },
    })).toThrow("bounded regular file");
  });
});
