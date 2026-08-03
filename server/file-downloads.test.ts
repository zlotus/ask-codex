// @vitest-environment node

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

const fileSystemHooks = vi.hoisted(() => ({
  beforeRealpath: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    realpath: async (path: Parameters<typeof original.realpath>[0]) => {
      await fileSystemHooks.beforeRealpath?.(String(path));
      return original.realpath(path);
    },
  };
});

import {
  FILE_DOWNLOADS_ITEM_FIELD,
  FileDownloadError,
  FileDownloadStore,
  type FileDownloadDescriptor,
  type FileDownloadLease,
  type FileDownloadStoreOptions,
} from "./file-downloads.js";
import { isRecord } from "./types.js";

const temporaryDirectories: string[] = [];
const execFile = promisify(execFileCallback);

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ask-codex-download-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function descriptors(item: unknown): FileDownloadDescriptor[] {
  if (!isRecord(item) || !Array.isArray(item[FILE_DOWNLOADS_ITEM_FIELD])) return [];
  return item[FILE_DOWNLOADS_ITEM_FIELD] as FileDownloadDescriptor[];
}

function rememberCwd(store: FileDownloadStore, threadId: string, cwd: string): void {
  store.observeRpcResult("thread/read", { threadId }, {
    thread: { id: threadId, cwd },
  });
}

function completedItem(
  store: FileDownloadStore,
  threadId: string,
  text: string,
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: `item-${Math.random()}`,
    type: "agentMessage",
    text,
  };
  store.decorateNotification("item/completed", { threadId, item });
  return item;
}

function issueCapability(
  store: FileDownloadStore,
  threadId: string,
  path: string,
): string {
  const item = completedItem(store, threadId, `[file](<${path}>)`);
  const capabilityId = descriptors(item)[0]?.capabilityId;
  if (!capabilityId) throw new Error("Expected a file download capability");
  return capabilityId;
}

async function leaseBytes(lease: FileDownloadLease): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of lease.createReadStream()) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof FileDownloadError ? error.code : undefined;
}

afterEach(async () => {
  fileSystemHooks.beforeRealpath = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("FileDownloadStore", () => {
  it("extracts bounded absolute inline and reference Markdown links", async () => {
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const direct = join(cwd, "direct.md");
    const spaced = join(cwd, "file with spaces.txt");
    const referenced = join(cwd, "referenced.ts");
    await Promise.all([
      writeFile(direct, "direct"),
      writeFile(spaced, "spaced"),
      writeFile(referenced, "referenced"),
    ]);
    const store = new FileDownloadStore();
    rememberCwd(store, "thread-links", cwd);

    const markdown = [
      `[direct](${direct}:12)`,
      `[spaces](<${spaced}:2:3>)`,
      `[encoded](${spaced.replaceAll(" ", "%20")}:4)`,
      "[reference][source]",
      "![image](/tmp/not-a-download.png)",
      "`[code](/tmp/not-a-download.txt)`",
      "[relative](notes.md)",
      "[external](https://example.com/file.txt)",
      `[outside](${join(outside, "secret.txt")})`,
      `[query](${direct}?raw=1)`,
      "",
      `[source]: ${referenced}:9`,
      "[source]: https://example.com/ignored-by-commonmark",
    ].join("\n\n");
    const item = completedItem(store, "thread-links", markdown);

    expect(descriptors(item).map((entry) => entry.href)).toEqual([
      `${direct}:12`,
      `${spaced}:2:3`,
      `${spaced.replaceAll(" ", "%20")}:4`,
      `${referenced}:9`,
    ]);
    await store.close();
  });

  it("signs only completed item lifecycles and full completed history", async () => {
    const cwd = await temporaryDirectory();
    const path = join(cwd, "complete.md");
    await writeFile(path, "complete");
    const store = new FileDownloadStore();
    rememberCwd(store, "thread-complete", cwd);

    const started = { id: "started", type: "agentMessage", text: `[file](${path})` };
    store.decorateNotification("item/started", { threadId: "thread-complete", item: started });
    expect(descriptors(started)).toEqual([]);

    const inProgress = {
      data: [{
        id: "turn-running",
        status: "inProgress",
        itemsView: "full",
        items: [{ id: "partial", type: "agentMessage", text: `[file](${path})` }],
      }],
    };
    store.decorateRpcResult(
      "thread/turns/list",
      { threadId: "thread-complete", itemsView: "full" },
      inProgress,
    );
    expect(descriptors((inProgress.data[0]?.items ?? [])[0])).toEqual([]);

    const summary = {
      data: [{
        id: "turn-summary",
        status: "completed",
        itemsView: "summary",
        items: [{ id: "summary", type: "agentMessage", text: `[file](${path})` }],
      }],
    };
    store.decorateRpcResult(
      "thread/turns/list",
      { threadId: "thread-complete", itemsView: "summary" },
      summary,
    );
    expect(descriptors((summary.data[0]?.items ?? [])[0])).toEqual([]);

    for (const itemsView of ["notLoaded", undefined, "futureView"]) {
      const incomplete = {
        data: [{
          id: `turn-${itemsView ?? "missing"}`,
          status: "completed",
          ...(itemsView === undefined ? {} : { itemsView }),
          items: [{
            id: `item-${itemsView ?? "missing"}`,
            type: "agentMessage",
            text: `[file](${path})`,
          }],
        }],
      };
      store.decorateRpcResult(
        "thread/turns/list",
        { threadId: "thread-complete", itemsView: "full" },
        incomplete,
      );
      expect(descriptors(incomplete.data[0]?.items[0])).toEqual([]);
    }

    const full = {
      data: ["completed", "interrupted", "failed"].map((status) => ({
        id: `turn-${status}`,
        status,
        itemsView: "full",
        items: [{ id: `item-${status}`, type: "agentMessage", text: `[file](${path})` }],
      })),
    };
    store.observeRpcResult(
      "thread/turns/list",
      { threadId: "thread-complete", itemsView: "full" },
      full,
    );
    store.decorateRpcResult(
      "thread/turns/list",
      { threadId: "thread-complete", itemsView: "full" },
      full,
    );
    expect(descriptors(full.data[0]?.items[0])).toHaveLength(1);
    expect(descriptors(full.data[1]?.items[0])).toEqual([]);
    expect(descriptors(full.data[2]?.items[0])).toEqual([]);

    const failedNotification = {
      threadId: "thread-complete",
      turn: {
        id: "turn-failed-notification",
        status: "failed",
        items: [{ id: "failed-partial", type: "agentMessage", text: `[file](${path})` }],
      },
    };
    store.observeNotification("turn/completed", failedNotification);
    store.decorateNotification("turn/completed", failedNotification);
    expect(descriptors(failedNotification.turn.items[0])).toEqual([]);

    const completedNotification = {
      threadId: "thread-complete",
      turn: {
        id: "turn-completed-notification",
        status: "completed",
        itemsView: "full",
        items: [{
          id: "completed-notification-item",
          type: "agentMessage",
          text: `[file](${path})`,
        }],
      },
    };
    store.observeNotification("turn/completed", completedNotification);
    store.decorateNotification("turn/completed", completedNotification);
    expect(descriptors(completedNotification.turn.items[0])).toEqual([]);

    const failedItemPage = {
      data: [{
        turnId: "turn-failed-notification",
        item: { id: "failed-page", type: "agentMessage", text: `[file](${path})` },
      }],
    };
    store.decorateRpcResult(
      "thread/items/list",
      { threadId: "thread-complete" },
      failedItemPage,
    );
    expect(descriptors(failedItemPage.data[0]?.item)).toEqual([]);

    const historicalItem = {
      data: [{
        turnId: "turn-completed",
        item: { id: "historical", type: "agentMessage", text: `[file](${path})` },
      }],
    };
    store.decorateRpcResult(
      "thread/items/list",
      { threadId: "thread-complete" },
      historicalItem,
    );
    expect(descriptors(historicalItem.data[0]?.item)).toHaveLength(1);

    const activeItem = {
      data: [{
        turnId: "turn-running",
        item: { id: "active-page", type: "agentMessage", text: `[file](${path})` },
      }],
    };
    store.decorateRpcResult(
      "thread/items/list",
      { threadId: "thread-complete" },
      activeItem,
    );
    expect(descriptors(activeItem.data[0]?.item)).toEqual([]);
    await store.close();
  });

  it("opens a capability once and streams only the snapshotted file size", async () => {
    const cwd = await temporaryDirectory();
    const path = join(cwd, "download.txt");
    await writeFile(path, "download bytes");
    const store = new FileDownloadStore();
    rememberCwd(store, "thread-once", cwd);
    const capabilityId = issueCapability(store, "thread-once", `${path}:7`);

    const lease = await store.consume(capabilityId);
    expect(lease.name).toBe("download.txt");
    expect(lease.size).toBe(Buffer.byteLength("download bytes"));
    expect(await leaseBytes(lease)).toEqual(Buffer.from("download bytes"));
    await expect(store.consume(capabilityId)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadNotFound",
    );
    await lease.release();
    await store.close();
  });

  it("expires and evicts capabilities within configured bounds", async () => {
    const cwd = await temporaryDirectory();
    const first = join(cwd, "first.txt");
    const second = join(cwd, "second.txt");
    await Promise.all([writeFile(first, "first"), writeFile(second, "second")]);
    let now = 1_000;
    const options: FileDownloadStoreOptions = {
      now: () => now,
      limits: { ttlMs: 50, maxCapabilities: 1 },
    };
    const store = new FileDownloadStore(options);
    rememberCwd(store, "thread-bounds", cwd);
    const firstId = issueCapability(store, "thread-bounds", first);
    const secondId = issueCapability(store, "thread-bounds", second);

    await expect(store.consume(firstId)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadNotFound",
    );
    now += 51;
    await expect(store.consume(secondId)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadNotFound",
    );
    await store.close();
  });

  it("enforces file-size and concurrent download limits", async () => {
    const cwd = await temporaryDirectory();
    const large = join(cwd, "large.txt");
    const first = join(cwd, "first.txt");
    const second = join(cwd, "second.txt");
    await Promise.all([
      writeFile(large, "12345"),
      writeFile(first, "1"),
      writeFile(second, "2"),
    ]);
    const store = new FileDownloadStore({
      limits: { maxFileBytes: 4, maxConcurrentDownloads: 1 },
    });
    rememberCwd(store, "thread-limits", cwd);

    await expect(store.consume(issueCapability(store, "thread-limits", large)))
      .rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "fileDownloadTooLarge",
      );

    const firstLease = await store.consume(issueCapability(store, "thread-limits", first));
    const secondId = issueCapability(store, "thread-limits", second);
    await expect(store.consume(secondId)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "tooManyFileDownloads",
    );
    await firstLease.release();
    const secondLease = await store.consume(secondId);
    await secondLease.release();
    await store.close();
  });

  it("rejects traversal, symlink escapes, swaps, directories, and FIFOs", async () => {
    const cwd = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const secret = join(outside, "secret.txt");
    const link = join(cwd, "secret-link.txt");
    const swapped = join(cwd, "swapped.txt");
    const directory = join(cwd, "directory");
    const fifo = join(cwd, "named-pipe");
    await writeFile(secret, "secret");
    await symlink(secret, link);
    await writeFile(swapped, "safe");
    await mkdir(directory);
    await execFile("mkfifo", [fifo]);
    const store = new FileDownloadStore();
    rememberCwd(store, "thread-security", cwd);

    expect(descriptors(completedItem(
      store,
      "thread-security",
      `[outside](${join(cwd, "..", "outside.txt")})`,
    ))).toEqual([]);

    const linkId = issueCapability(store, "thread-security", link);
    await expect(store.consume(linkId)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadNotFound",
    );

    const swappedId = issueCapability(store, "thread-security", swapped);
    await unlink(swapped);
    await symlink(secret, swapped);
    await expect(store.consume(swappedId)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadNotFound",
    );

    const directoryId = issueCapability(store, "thread-security", directory);
    await expect(store.consume(directoryId)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadNotFound",
    );

    const fifoId = issueCapability(store, "thread-security", fifo);
    await expect(store.consume(fifoId)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadNotFound",
    );
    await store.close();
  });

  it("rejects capabilities after the authoritative cwd root identity changes", async () => {
    const parent = await temporaryDirectory();
    const firstTarget = join(parent, "first-target");
    const secondTarget = join(parent, "second-target");
    const cwdLink = join(parent, "cwd-link");
    await Promise.all([mkdir(firstTarget), mkdir(secondTarget)]);
    await Promise.all([
      writeFile(join(firstTarget, "same-name.txt"), "first"),
      writeFile(join(secondTarget, "same-name.txt"), "second"),
    ]);
    await symlink(firstTarget, cwdLink);

    const store = new FileDownloadStore();
    rememberCwd(store, "thread-root-link", cwdLink);
    const linkCapability = issueCapability(
      store,
      "thread-root-link",
      join(cwdLink, "same-name.txt"),
    );
    await unlink(cwdLink);
    await symlink(secondTarget, cwdLink);
    await expect(store.consume(linkCapability)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadNotFound",
    );

    const cwdDirectory = join(parent, "replaceable-root");
    const oldDirectory = join(parent, "old-root");
    await mkdir(cwdDirectory);
    await writeFile(join(cwdDirectory, "same-name.txt"), "original");
    rememberCwd(store, "thread-root-directory", cwdDirectory);
    const directoryCapability = issueCapability(
      store,
      "thread-root-directory",
      join(cwdDirectory, "same-name.txt"),
    );
    await rename(cwdDirectory, oldDirectory);
    await mkdir(cwdDirectory);
    await writeFile(join(cwdDirectory, "same-name.txt"), "replacement");
    await expect(store.consume(directoryCapability)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadNotFound",
    );
    await store.close();
  });

  it("keeps resolution pinned when the cwd root is replaced during consumption", async () => {
    const parent = await temporaryDirectory();
    const cwd = join(parent, "cwd");
    const originalCwd = join(parent, "original-cwd");
    const replacementCwd = join(parent, "replacement-cwd");
    await Promise.all([mkdir(cwd), mkdir(replacementCwd)]);
    await Promise.all([
      writeFile(join(cwd, "same-name.txt"), "original"),
      writeFile(join(replacementCwd, "same-name.txt"), "replacement"),
    ]);
    const store = new FileDownloadStore();
    rememberCwd(store, "thread-mid-consume-root", cwd);
    const capabilityId = issueCapability(
      store,
      "thread-mid-consume-root",
      join(cwd, "same-name.txt"),
    );

    let replaced = false;
    fileSystemHooks.beforeRealpath = async (path) => {
      if (replaced || !path.endsWith("/same-name.txt")) return;
      replaced = true;
      await rename(cwd, originalCwd);
      await rename(replacementCwd, cwd);
    };

    await expect(store.consume(capabilityId)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadNotFound",
    );
    expect(replaced).toBe(true);
    await store.close();
  });

  it("revokes capabilities when authoritative cwd changes, disappears, or closes", async () => {
    const firstCwd = await temporaryDirectory();
    const secondCwd = await temporaryDirectory();
    const first = join(firstCwd, "first.txt");
    const second = join(secondCwd, "second.txt");
    await Promise.all([writeFile(first, "first"), writeFile(second, "second")]);
    const store = new FileDownloadStore({ limits: { maxThreadCwds: 1 } });
    rememberCwd(store, "thread-first", firstCwd);
    store.observeRpcResult("thread/turns/list", { threadId: "thread-first" }, {
      data: [{ id: "turn-before-cwd-change", status: "completed", items: [] }],
    });
    const changedId = issueCapability(store, "thread-first", first);
    store.observeNotification("thread/settings/updated", {
      threadId: "thread-first",
      threadSettings: { cwd: secondCwd },
    });
    await expect(store.consume(changedId)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadNotFound",
    );
    const staleCompletedPage = {
      data: [{
        turnId: "turn-before-cwd-change",
        item: { id: "stale-completed", type: "agentMessage", text: `[file](${second})` },
      }],
    };
    store.decorateRpcResult(
      "thread/items/list",
      { threadId: "thread-first" },
      staleCompletedPage,
    );
    expect(descriptors(staleCompletedPage.data[0]?.item)).toEqual([]);

    const deletedId = issueCapability(store, "thread-first", second);
    store.observeNotification("thread/deleted", { threadId: "thread-first" });
    await expect(store.consume(deletedId)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadNotFound",
    );

    rememberCwd(store, "thread-second", secondCwd);
    const closedId = issueCapability(store, "thread-second", second);
    await store.close();
    await expect(store.consume(closedId)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "fileDownloadsUnavailable",
    );
  });

  it("does not let an RPC result older than a cwd notification restore authority", async () => {
    const parent = await temporaryDirectory();
    const updatedCwd = join(parent, "updated");
    const oldScopeFile = join(parent, "old-scope.txt");
    const updatedScopeFile = join(updatedCwd, "updated-scope.txt");
    await mkdir(updatedCwd);
    await Promise.all([
      writeFile(oldScopeFile, "old"),
      writeFile(updatedScopeFile, "updated"),
    ]);
    const store = new FileDownloadStore();
    rememberCwd(store, "thread-stale-authority", parent);
    const requestRevision = store.captureAuthorityRevision();

    store.observeNotification("thread/settings/updated", {
      threadId: "thread-stale-authority",
      threadSettings: { cwd: updatedCwd },
    });
    expect(store.observeRpcResult(
      "thread/read",
      { threadId: "thread-stale-authority" },
      { thread: { id: "thread-stale-authority", cwd: parent } },
      requestRevision,
    )).toBe(false);
    expect(store.observeRpcResult(
      "thread/list",
      {},
      { data: [{ id: "thread-stale-authority", cwd: parent }] },
      requestRevision,
    )).toBe(true);

    expect(descriptors(completedItem(
      store,
      "thread-stale-authority",
      `[old](${oldScopeFile})`,
    ))).toEqual([]);
    expect(descriptors(completedItem(
      store,
      "thread-stale-authority",
      `[updated](${updatedScopeFile})`,
    ))).toHaveLength(1);
    await store.close();
  });

  it("keeps older content responses usable across newer same-scope authority refreshes", async () => {
    const cwd = await temporaryDirectory();
    const otherCwd = await temporaryDirectory();
    const path = join(cwd, "same-scope.txt");
    await writeFile(path, "same scope");
    const store = new FileDownloadStore();
    rememberCwd(store, "thread-same-scope", cwd);
    const readRequestRevision = store.captureAuthorityRevision();
    const differentReadRequestRevision = store.captureAuthorityRevision();
    const turnsRequestRevision = store.captureAuthorityRevision();
    const refreshRequestRevision = store.captureAuthorityRevision();

    expect(store.observeRpcResult(
      "thread/list",
      {},
      { data: [{ id: "thread-same-scope", cwd }] },
      refreshRequestRevision,
    )).toBe(true);
    store.observeNotification("thread/started", {
      thread: { id: "thread-same-scope", cwd },
    });
    store.observeNotification("thread/settings/updated", {
      threadId: "thread-same-scope",
      threadSettings: { cwd },
    });

    const readResult = {
      thread: {
        id: "thread-same-scope",
        cwd,
        turns: [{
          id: "turn-same-scope-read",
          status: "completed",
          itemsView: "full",
          items: [{ id: "read-item", type: "agentMessage", text: `[file](${path})` }],
        }],
      },
    };
    expect(store.observeRpcResult(
      "thread/read",
      { threadId: "thread-same-scope" },
      readResult,
      readRequestRevision,
    )).toBe(true);
    store.decorateRpcResult(
      "thread/read",
      { threadId: "thread-same-scope" },
      readResult,
      readRequestRevision,
    );
    expect(descriptors(readResult.thread.turns[0]?.items[0])).toHaveLength(1);

    expect(store.observeRpcResult(
      "thread/read",
      { threadId: "thread-same-scope" },
      { thread: { id: "thread-same-scope", cwd: otherCwd, turns: [] } },
      differentReadRequestRevision,
    )).toBe(false);

    const turnsResult = {
      data: [{
        id: "turn-same-scope-page",
        status: "completed",
        itemsView: "full",
        items: [{ id: "page-item", type: "agentMessage", text: `[file](${path})` }],
      }],
    };
    expect(store.observeRpcResult(
      "thread/turns/list",
      { threadId: "thread-same-scope", itemsView: "full" },
      turnsResult,
      turnsRequestRevision,
    )).toBe(true);
    store.decorateRpcResult(
      "thread/turns/list",
      { threadId: "thread-same-scope", itemsView: "full" },
      turnsResult,
      turnsRequestRevision,
    );
    expect(descriptors(turnsResult.data[0]?.items[0])).toHaveLength(1);
    await store.close();
  });

  it("invalidates content requests dispatched before an RPC-derived scope change is observed", async () => {
    const firstCwd = await temporaryDirectory();
    const secondCwd = await temporaryDirectory();
    const path = join(secondCwd, "new-scope.txt");
    await writeFile(path, "new scope");
    const store = new FileDownloadStore();
    rememberCwd(store, "thread-scope-observation", firstCwd);
    const scopeChangeRequestRevision = store.captureAuthorityRevision();
    const staleTurnsRequestRevision = store.captureAuthorityRevision();

    expect(store.observeRpcResult(
      "thread/read",
      { threadId: "thread-scope-observation" },
      { thread: { id: "thread-scope-observation", cwd: secondCwd, turns: [] } },
      scopeChangeRequestRevision,
    )).toBe(true);

    const staleTurns = {
      data: [{
        id: "turn-before-scope-observation",
        status: "completed",
        itemsView: "full",
        items: [{ id: "stale-item", type: "agentMessage", text: `[file](${path})` }],
      }],
    };
    const canDecorateStale = store.observeRpcResult(
      "thread/turns/list",
      { threadId: "thread-scope-observation", itemsView: "full" },
      staleTurns,
      staleTurnsRequestRevision,
    );
    expect(canDecorateStale).toBe(false);
    if (canDecorateStale) {
      store.decorateRpcResult(
        "thread/turns/list",
        { threadId: "thread-scope-observation", itemsView: "full" },
        staleTurns,
        staleTurnsRequestRevision,
      );
    }
    expect(descriptors(staleTurns.data[0]?.items[0])).toEqual([]);

    const freshTurnsRequestRevision = store.captureAuthorityRevision();
    const freshTurns = {
      data: [{
        id: "turn-after-scope-observation",
        status: "completed",
        itemsView: "full",
        items: [{ id: "fresh-item", type: "agentMessage", text: `[file](${path})` }],
      }],
    };
    expect(store.observeRpcResult(
      "thread/turns/list",
      { threadId: "thread-scope-observation", itemsView: "full" },
      freshTurns,
      freshTurnsRequestRevision,
    )).toBe(true);
    store.decorateRpcResult(
      "thread/turns/list",
      { threadId: "thread-scope-observation", itemsView: "full" },
      freshTurns,
      freshTurnsRequestRevision,
    );
    expect(descriptors(freshTurns.data[0]?.items[0])).toHaveLength(1);
    await store.close();
  });

  it("rejects in-flight content after thread authority is deleted or cleared", async () => {
    const cwd = await temporaryDirectory();
    const store = new FileDownloadStore();
    rememberCwd(store, "thread-scope-loss", cwd);
    const beforeDeleteRevision = store.captureAuthorityRevision();

    store.observeNotification("thread/deleted", { threadId: "thread-scope-loss" });
    expect(store.observeRpcResult(
      "thread/turns/list",
      { threadId: "thread-scope-loss", itemsView: "full" },
      { data: [] },
      beforeDeleteRevision,
    )).toBe(false);

    rememberCwd(store, "thread-scope-loss", cwd);
    const beforeClearRevision = store.captureAuthorityRevision();
    store.clearAuthority();
    expect(store.observeRpcResult(
      "thread/turns/list",
      { threadId: "thread-scope-loss", itemsView: "full" },
      { data: [] },
      beforeClearRevision,
    )).toBe(false);
    await store.close();
  });

  it("does not let an older item request borrow completion evidence observed later", async () => {
    const cwd = await temporaryDirectory();
    const path = join(cwd, "completed-later.txt");
    await writeFile(path, "completed later");
    const store = new FileDownloadStore();
    rememberCwd(store, "thread-completion-order", cwd);
    const turnsRequestRevision = store.captureAuthorityRevision();
    const staleItemsRequestRevision = store.captureAuthorityRevision();

    store.observeRpcResult(
      "thread/turns/list",
      { threadId: "thread-completion-order", itemsView: "full" },
      {
        data: [{
          id: "turn-completion-order",
          status: "completed",
          itemsView: "full",
          items: [],
        }],
      },
      turnsRequestRevision,
    );
    const staleItems = {
      data: [{
        turnId: "turn-completion-order",
        item: { id: "stale-item", type: "agentMessage", text: `[file](${path})` },
      }],
    };
    store.decorateRpcResult(
      "thread/items/list",
      { threadId: "thread-completion-order" },
      staleItems,
      staleItemsRequestRevision,
    );
    expect(descriptors(staleItems.data[0]?.item)).toEqual([]);

    const freshItems = {
      data: [{
        turnId: "turn-completion-order",
        item: { id: "fresh-item", type: "agentMessage", text: `[file](${path})` },
      }],
    };
    store.decorateRpcResult(
      "thread/items/list",
      { threadId: "thread-completion-order" },
      freshItems,
      store.captureAuthorityRevision(),
    );
    expect(descriptors(freshItems.data[0]?.item)).toHaveLength(1);
    await store.close();
  });
});
