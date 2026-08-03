import { randomBytes } from "node:crypto";
import { constants, realpathSync, statSync } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import { fromMarkdown } from "mdast-util-from-markdown";

import { isRecord } from "./types.js";

export const FILE_DOWNLOADS_ITEM_FIELD = "askCodexFileDownloads";

export interface FileDownloadDescriptor {
  href: string;
  capabilityId: string;
}

export interface FileDownloadLimits {
  maxFileBytes: number;
  maxConcurrentDownloads: number;
  maxCapabilities: number;
  maxCapabilityMetadataBytes: number;
  maxLinksPerItem: number;
  maxItemMetadataBytes: number;
  maxMarkdownCharacters: number;
  maxHrefBytes: number;
  maxThreadCwds: number;
  maxThreadIdBytes: number;
  maxCwdBytes: number;
  maxCompletedTurns: number;
  maxTurnIdBytes: number;
  ttlMs: number;
}

export const DEFAULT_FILE_DOWNLOAD_LIMITS: Readonly<FileDownloadLimits> = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxConcurrentDownloads: 2,
  maxCapabilities: 512,
  maxCapabilityMetadataBytes: 1024 * 1024,
  maxLinksPerItem: 16,
  maxItemMetadataBytes: 16 * 1024,
  maxMarkdownCharacters: 240_000,
  maxHrefBytes: 4_096,
  maxThreadCwds: 1_024,
  maxThreadIdBytes: 256,
  maxCwdBytes: 4_096,
  maxCompletedTurns: 4_096,
  maxTurnIdBytes: 256,
  ttlMs: 10 * 60 * 1000,
});

export type FileDownloadErrorCode =
  | "fileDownloadNotFound"
  | "fileDownloadTooLarge"
  | "tooManyFileDownloads"
  | "fileDownloadsUnavailable";

export class FileDownloadError extends Error {
  constructor(
    readonly code: FileDownloadErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "FileDownloadError";
  }
}

export interface FileDownloadLease {
  name: string;
  size: number;
  createReadStream(): Readable;
  release(): Promise<void>;
}

export interface FileDownloadStoreOptions {
  limits?: Partial<FileDownloadLimits>;
  now?: () => number;
}

interface ThreadCwdRecord {
  cwd: string;
  root: string;
  rootDevice: bigint;
  rootInode: bigint;
}

interface CapabilityRecord {
  id: string;
  threadId: string;
  href: string;
  path: string;
  relativePath: string;
  cwd: string;
  root: string;
  rootDevice: bigint;
  rootInode: bigint;
  expiresAt: number;
  metadataBytes: number;
}

interface CompletedTurnRecord {
  threadId: string;
  turnId: string;
  revision: bigint;
}

const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const CAPABILITY_CREATION_ATTEMPTS = 5;
const MAX_MARKDOWN_NODES = 2_000;
const LOCATION_SUFFIX_PATTERN = /^(.*?):([1-9]\d{0,8})(?::([1-9]\d{0,8}))?$/;

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function mergedLimits(overrides: Partial<FileDownloadLimits> | undefined): FileDownloadLimits {
  const limits = { ...DEFAULT_FILE_DOWNLOAD_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    positiveInteger(value, key);
  }
  return limits;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function relativeWithin(root: string, candidate: string): string | undefined {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  ) ? pathFromRoot : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  return relativeWithin(root, candidate) !== undefined;
}

function rootIdentity(directory: string): ThreadCwdRecord | undefined {
  try {
    const root = realpathSync(directory);
    const metadata = statSync(root, { bigint: true });
    if (!metadata.isDirectory()) return undefined;
    return {
      cwd: directory,
      root,
      rootDevice: metadata.dev,
      rootInode: metadata.ino,
    };
  } catch {
    return undefined;
  }
}

function sameRootIdentity(left: ThreadCwdRecord, right: ThreadCwdRecord): boolean {
  return left.cwd === right.cwd &&
    left.root === right.root &&
    left.rootDevice === right.rootDevice &&
    left.rootInode === right.rootInode;
}

function threadId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.threadId === "string" && value.threadId) return value.threadId;
  if (typeof value.id === "string" && value.id) return value.id;
  return undefined;
}

function cwd(value: unknown): string | undefined {
  return isRecord(value) && typeof value.cwd === "string" ? value.cwd : undefined;
}

function turnId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.turnId === "string" && value.turnId) return value.turnId;
  if (typeof value.id === "string" && value.id) return value.id;
  return undefined;
}

function completedTurn(value: unknown): boolean {
  return isRecord(value) && value.status === "completed";
}

function completedTurnKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

function markdownLinkUrls(markdown: string, maximumCharacters: number): string[] {
  let tree: unknown;
  try {
    tree = fromMarkdown(markdown.slice(0, maximumCharacters));
  } catch {
    return [];
  }

  const definitions = new Map<string, string>();
  const nodes: unknown[] = [tree];
  let visited = 0;
  while (nodes.length > 0 && visited < MAX_MARKDOWN_NODES) {
    const node = nodes.pop();
    visited += 1;
    if (!isRecord(node)) continue;
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string" &&
      !definitions.has(node.identifier)
    ) {
      definitions.set(node.identifier, node.url);
    }
    if (Array.isArray(node.children)) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        nodes.push(node.children[index]);
      }
    }
  }

  const urls: string[] = [];
  const seen = new Set<string>();
  const pending: unknown[] = [tree];
  visited = 0;
  while (pending.length > 0 && visited < MAX_MARKDOWN_NODES) {
    const node = pending.pop();
    visited += 1;
    if (!isRecord(node)) continue;
    const url = node.type === "link" && typeof node.url === "string"
      ? node.url
      : node.type === "linkReference" && typeof node.identifier === "string"
      ? definitions.get(node.identifier)
      : undefined;
    if (url !== undefined && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
    if (Array.isArray(node.children)) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push(node.children[index]);
      }
    }
  }
  return urls;
}

function localFileTarget(
  href: string,
  authority: ThreadCwdRecord,
  limits: FileDownloadLimits,
): string | undefined {
  if (
    Buffer.byteLength(href, "utf8") > limits.maxHrefBytes ||
    containsControlCharacter(href) ||
    !href.startsWith("/") ||
    href.startsWith("//") ||
    href.includes("?") ||
    href.includes("#")
  ) {
    return undefined;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    return undefined;
  }
  if (
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    containsControlCharacter(decoded)
  ) {
    return undefined;
  }

  const location = LOCATION_SUFFIX_PATTERN.exec(decoded);
  const withoutLocation = location?.[1] ?? decoded;
  if (!isAbsolute(withoutLocation) || withoutLocation.length === 0) return undefined;
  const normalized = resolve(withoutLocation);
  return isWithin(authority.cwd, normalized) || isWithin(authority.root, normalized)
    ? normalized
    : undefined;
}

function unavailable(): FileDownloadError {
  return new FileDownloadError(
    "fileDownloadNotFound",
    404,
    "File download is unavailable",
  );
}

function threadFromResult(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result)) return undefined;
  return isRecord(result.thread) ? result.thread : result;
}

export class FileDownloadStore {
  readonly limits: Readonly<FileDownloadLimits>;
  private readonly now: () => number;
  private readonly threadCwds = new Map<string, ThreadCwdRecord>();
  private readonly capabilities = new Map<string, CapabilityRecord>();
  private readonly completedTurns = new Map<string, CompletedTurnRecord>();
  private readonly activeHandles = new Set<FileHandle>();
  private capabilityMetadataBytes = 0;
  private inFlightDownloads = 0;
  private authorityRevision = 0n;
  private authorityOrderFloorRevision = 0n;
  private scopeFloorRevision = 0n;
  private readonly threadAuthorityOrderRevisions = new Map<string, bigint>();
  private readonly threadScopeRevisions = new Map<string, bigint>();
  private closed = false;

  constructor(options: FileDownloadStoreOptions = {}) {
    this.limits = Object.freeze(mergedLimits(options.limits));
    this.now = options.now ?? Date.now;
  }

  captureAuthorityRevision(): bigint {
    this.authorityRevision += 1n;
    return this.authorityRevision;
  }

  observeRpcResult(
    method: string,
    params: unknown,
    result: unknown,
    expectedAuthorityRevision?: bigint,
  ): boolean {
    const requestRevision = expectedAuthorityRevision ?? this.captureAuthorityRevision();
    const observationRevision = this.captureAuthorityRevision();
    const requestedThreadId = threadId(params);
    if (method === "thread/list" && isRecord(result) && Array.isArray(result.data)) {
      for (const entry of result.data) {
        const id = threadId(entry);
        if (id && this.isAuthorityOrderRevisionCurrent(id, requestRevision)) {
          this.rememberThread(entry, requestRevision, observationRevision);
        }
      }
      return true;
    }
    if (method === "thread/delete") {
      if (
        !requestedThreadId ||
        !this.isAuthorityOrderRevisionCurrent(requestedThreadId, requestRevision)
      ) {
        return false;
      }
      this.forgetThread(requestedThreadId, requestRevision);
      return true;
    }
    if (
      method === "thread/turns/list" ||
      method === "thread/items/list" ||
      method === "turn/start"
    ) {
      if (
        !requestedThreadId ||
        !this.threadCwds.has(requestedThreadId) ||
        !this.isScopeRevisionCurrent(requestedThreadId, requestRevision)
      ) {
        return false;
      }
      if (method === "thread/turns/list" && isRecord(result)) {
        this.observeTurns(requestedThreadId, result.data, observationRevision);
      } else if (method === "turn/start" && isRecord(result)) {
        this.observeTurns(requestedThreadId, [result.turn], observationRevision);
      }
      return true;
    }
    if (method !== "thread/start" && method !== "thread/resume" && method !== "thread/read") {
      return true;
    }

    const thread = threadFromResult(result);
    const resultThreadId = threadId(thread);
    const observedThreadId = method === "thread/start" ? resultThreadId : requestedThreadId;
    if (
      !thread ||
      !observedThreadId ||
      resultThreadId !== observedThreadId
    ) {
      return false;
    }
    const resultCwd = cwd(thread) ?? cwd(result);
    const authorityValue = { id: observedThreadId, cwd: resultCwd };
    const authorityOrderCurrent = this.isAuthorityOrderRevisionCurrent(
      observedThreadId,
      requestRevision,
    );
    const remembered = authorityOrderCurrent
      ? this.rememberThread(authorityValue, requestRevision, observationRevision)
      : this.isScopeRevisionCurrent(observedThreadId, requestRevision) &&
        this.matchesRememberedThread(authorityValue);
    if (remembered) {
      this.observeTurns(observedThreadId, thread.turns, observationRevision);
      if (isRecord(result) && isRecord(result.initialTurnsPage)) {
        this.observeTurns(observedThreadId, result.initialTurnsPage.data, observationRevision);
      }
    }
    return remembered;
  }

  observeNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return;
    if (method === "thread/deleted") {
      const id = threadId(params);
      if (id) this.forgetThread(id, this.captureAuthorityRevision());
      return;
    }
    if (method === "turn/completed") {
      const id = threadId(params);
      const completedTurnId = turnId(params.turn) ?? turnId(params);
      const completionProven = completedTurn(params.turn) || params.status === "completed";
      if (id && this.threadCwds.has(id) && completedTurnId && completionProven) {
        this.rememberCompletedTurn(id, completedTurnId, this.captureAuthorityRevision());
      }
      return;
    }
    if (method === "thread/started") {
      this.rememberThread(params.thread, this.captureAuthorityRevision());
      return;
    }
    if (method === "thread/settings/updated") {
      const settings = isRecord(params.threadSettings) ? params.threadSettings : undefined;
      const updatedCwd = cwd(settings);
      if (updatedCwd !== undefined) {
        this.rememberThread(
          { id: threadId(params), cwd: updatedCwd },
          this.captureAuthorityRevision(),
        );
      }
    }
  }

  decorateRpcResult(
    method: string,
    params: unknown,
    projectedResult: unknown,
    expectedAuthorityRevision = this.authorityRevision,
  ): unknown {
    if (!isRecord(projectedResult)) return projectedResult;
    const id = threadId(params) ?? threadId(threadFromResult(projectedResult));
    if (!id) return projectedResult;

    if (method === "thread/items/list" && Array.isArray(projectedResult.data)) {
      for (const entry of projectedResult.data) {
        if (
          isRecord(entry) &&
          typeof entry.turnId === "string" &&
          this.isCompletedTurn(id, entry.turnId, expectedAuthorityRevision)
        ) {
          this.decorateAgentItem(entry.item, id, true);
        }
      }
      return projectedResult;
    }

    if (method === "thread/turns/list" && Array.isArray(projectedResult.data)) {
      const fullItems = !isRecord(params) || params.itemsView !== "summary";
      for (const turn of projectedResult.data) this.decorateTurn(turn, id, fullItems);
      return projectedResult;
    }

    if (method === "thread/read" || method === "thread/resume") {
      const thread = threadFromResult(projectedResult);
      if (thread && Array.isArray(thread.turns)) {
        for (const turn of thread.turns) this.decorateTurn(turn, id, true);
      }
      const initialPage = isRecord(projectedResult.initialTurnsPage)
        ? projectedResult.initialTurnsPage
        : undefined;
      const requestedInitialPage = isRecord(params) && isRecord(params.initialTurnsPage)
        ? params.initialTurnsPage
        : undefined;
      const fullItems = requestedInitialPage?.itemsView !== "summary";
      if (initialPage && Array.isArray(initialPage.data)) {
        for (const turn of initialPage.data) this.decorateTurn(turn, id, fullItems);
      }
    }
    return projectedResult;
  }

  decorateNotification(method: string, projectedParams: unknown): unknown {
    if (!isRecord(projectedParams)) return projectedParams;
    const id = threadId(projectedParams);
    if (!id) return projectedParams;
    if (method === "item/completed") {
      this.decorateAgentItem(projectedParams.item, id, true);
    }
    return projectedParams;
  }

  clearAuthority(): void {
    const revision = this.captureAuthorityRevision();
    this.authorityOrderFloorRevision = revision;
    this.scopeFloorRevision = revision;
    this.threadAuthorityOrderRevisions.clear();
    this.threadScopeRevisions.clear();
    this.threadCwds.clear();
    this.completedTurns.clear();
    this.clearCapabilities();
  }

  async consume(capabilityId: string): Promise<FileDownloadLease> {
    if (this.closed) {
      throw new FileDownloadError(
        "fileDownloadsUnavailable",
        503,
        "File downloads are unavailable",
      );
    }
    this.sweepExpired(this.now());
    if (!CAPABILITY_ID_PATTERN.test(capabilityId)) throw unavailable();
    const record = this.capabilities.get(capabilityId);
    if (!record) throw unavailable();
    if (this.inFlightDownloads >= this.limits.maxConcurrentDownloads) {
      throw new FileDownloadError(
        "tooManyFileDownloads",
        429,
        "Too many file downloads are in progress",
      );
    }

    this.removeCapability(record);
    this.inFlightDownloads += 1;
    let handle: FileHandle | undefined;
    let rootHandle: FileHandle | undefined;
    try {
      rootHandle = await open(
        record.root,
        constants.O_RDONLY |
          constants.O_DIRECTORY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
      const pinnedRootHandle = rootHandle;
      const pinnedRootPath = `/proc/self/fd/${pinnedRootHandle.fd}`;
      const verifyRoot = async (): Promise<void> => {
        const [currentRoot, openedRoot, rootMetadata] = await Promise.all([
          realpath(record.cwd),
          realpath(pinnedRootPath),
          pinnedRootHandle.stat({ bigint: true }),
        ]);
        if (
          currentRoot !== record.root ||
          openedRoot !== record.root ||
          !rootMetadata.isDirectory() ||
          rootMetadata.dev !== record.rootDevice ||
          rootMetadata.ino !== record.rootInode
        ) {
          throw unavailable();
        }
      };
      await verifyRoot();

      const pinnedCandidatePath = resolve(pinnedRootPath, record.relativePath);
      const candidate = await realpath(pinnedCandidatePath);
      if (!isWithin(record.root, candidate)) throw unavailable();
      const beforeOpen = await lstat(pinnedCandidatePath);
      if (!beforeOpen.isFile()) throw unavailable();

      handle = await open(
        pinnedCandidatePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw unavailable();
      if (metadata.size > this.limits.maxFileBytes) {
        throw new FileDownloadError(
          "fileDownloadTooLarge",
          413,
          "File exceeds the download size limit",
        );
      }

      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (openedPath !== candidate || !isWithin(record.root, openedPath)) throw unavailable();
      await verifyRoot();
      await rootHandle.close();
      rootHandle = undefined;

      const activeHandle = handle;
      handle = undefined;
      this.activeHandles.add(activeHandle);
      let released = false;
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        this.activeHandles.delete(activeHandle);
        this.inFlightDownloads = Math.max(0, this.inFlightDownloads - 1);
        await activeHandle.close().catch(() => undefined);
      };
      return Object.freeze({
        name: basename(candidate),
        size: metadata.size,
        createReadStream: (): Readable => metadata.size === 0
          ? Readable.from([])
          : activeHandle.createReadStream({
              autoClose: false,
              start: 0,
              end: metadata.size - 1,
            }),
        release,
      });
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (rootHandle) await rootHandle.close().catch(() => undefined);
      this.inFlightDownloads = Math.max(0, this.inFlightDownloads - 1);
      if (error instanceof FileDownloadError) throw error;
      throw unavailable();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.threadCwds.clear();
    this.threadAuthorityOrderRevisions.clear();
    this.threadScopeRevisions.clear();
    this.completedTurns.clear();
    this.clearCapabilities();
    const handles = [...this.activeHandles];
    this.activeHandles.clear();
    this.inFlightDownloads = 0;
    await Promise.allSettled(handles.map((handle) => handle.close()));
  }

  private rememberThread(
    value: unknown,
    orderRevision: bigint,
    scopeRevision = orderRevision,
  ): boolean {
    if (!isRecord(value)) return false;
    const id = threadId(value);
    const directory = cwd(value);
    if (
      !id ||
      Buffer.byteLength(id, "utf8") > this.limits.maxThreadIdBytes
    ) {
      return false;
    }
    if (
      !directory ||
      !isAbsolute(directory) ||
      containsControlCharacter(directory) ||
      Buffer.byteLength(directory, "utf8") > this.limits.maxCwdBytes
    ) {
      this.forgetThread(id, orderRevision);
      return false;
    }
    const normalized = resolve(directory);
    const authority = rootIdentity(normalized);
    if (!authority) {
      this.forgetThread(id, orderRevision);
      return false;
    }
    const existing = this.threadCwds.get(id);
    const scopeChanged = !existing || !sameRootIdentity(existing, authority);
    if (existing && scopeChanged) {
      this.revokeThreadCapabilities(id);
      this.forgetCompletedTurns(id);
    }
    this.threadCwds.delete(id);
    this.threadCwds.set(id, authority);
    this.markThreadAuthorityOrderRevision(id, orderRevision);
    if (scopeChanged || !this.threadScopeRevisions.has(id)) {
      this.threadScopeRevisions.set(id, scopeRevision);
    }
    while (this.threadCwds.size > this.limits.maxThreadCwds) {
      const oldest = this.threadCwds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.forgetThread(oldest, orderRevision);
    }
    return true;
  }

  private matchesRememberedThread(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const id = threadId(value);
    const directory = cwd(value);
    if (
      !id ||
      !directory ||
      !isAbsolute(directory) ||
      containsControlCharacter(directory) ||
      Buffer.byteLength(id, "utf8") > this.limits.maxThreadIdBytes ||
      Buffer.byteLength(directory, "utf8") > this.limits.maxCwdBytes
    ) {
      return false;
    }
    const existing = this.threadCwds.get(id);
    const authority = rootIdentity(resolve(directory));
    return Boolean(existing && authority && sameRootIdentity(existing, authority));
  }

  private forgetThread(id: string | undefined, revision: bigint): void {
    if (!id || Buffer.byteLength(id, "utf8") > this.limits.maxThreadIdBytes) return;
    this.threadCwds.delete(id);
    this.threadScopeRevisions.delete(id);
    this.revokeThreadCapabilities(id);
    this.forgetCompletedTurns(id);
    this.markThreadAuthorityOrderRevision(id, revision);
  }

  private isAuthorityOrderRevisionCurrent(id: string, revision: bigint): boolean {
    if (revision < this.authorityOrderFloorRevision) return false;
    return revision >= (
      this.threadAuthorityOrderRevisions.get(id) ?? this.authorityOrderFloorRevision
    );
  }

  private isScopeRevisionCurrent(id: string, revision: bigint): boolean {
    const scopeRevision = this.threadScopeRevisions.get(id);
    return revision >= this.scopeFloorRevision &&
      scopeRevision !== undefined &&
      revision >= scopeRevision;
  }

  private markThreadAuthorityOrderRevision(id: string, revision: bigint): void {
    const previous = this.threadAuthorityOrderRevisions.get(id);
    if (previous === undefined || revision > previous) {
      this.threadAuthorityOrderRevisions.set(id, revision);
    }
    if (this.threadAuthorityOrderRevisions.size <= this.limits.maxThreadCwds) return;

    let floor = this.authorityOrderFloorRevision;
    for (const [observedThreadId, observedRevision] of this.threadAuthorityOrderRevisions) {
      if (!this.threadCwds.has(observedThreadId) && observedRevision > floor) {
        floor = observedRevision;
      }
    }
    this.authorityOrderFloorRevision = floor;
    const activeRevisions = [...this.threadCwds.keys()].map((observedThreadId) => [
      observedThreadId,
      this.threadAuthorityOrderRevisions.get(observedThreadId) ?? floor,
    ] as const);
    this.threadAuthorityOrderRevisions.clear();
    for (const [observedThreadId, observedRevision] of activeRevisions) {
      this.threadAuthorityOrderRevisions.set(observedThreadId, observedRevision);
    }
  }

  private decorateTurn(
    value: unknown,
    id: string,
    fullItems: boolean,
  ): void {
    if (
      !fullItems ||
      !isRecord(value) ||
      !completedTurn(value) ||
      value.itemsView !== "full" ||
      !Array.isArray(value.items)
    ) {
      return;
    }
    for (const item of value.items) this.decorateAgentItem(item, id, true);
  }

  private decorateAgentItem(value: unknown, id: string, complete: boolean): void {
    if (
      !complete ||
      !isRecord(value) ||
      value.type !== "agentMessage" ||
      typeof value.text !== "string"
    ) {
      return;
    }
    const authority = this.threadCwds.get(id);
    if (!authority) return;

    const descriptors: FileDownloadDescriptor[] = [];
    let itemMetadataBytes = 0;
    for (const href of markdownLinkUrls(value.text, this.limits.maxMarkdownCharacters)) {
      if (descriptors.length >= this.limits.maxLinksPerItem) break;
      const path = localFileTarget(href, authority, this.limits);
      if (!path) continue;
      const descriptorBytes = Buffer.byteLength(href, "utf8") + 32;
      if (itemMetadataBytes > this.limits.maxItemMetadataBytes - descriptorBytes) break;
      const capability = this.issueCapability(id, href, path, authority);
      if (!capability) continue;
      descriptors.push({ href, capabilityId: capability.id });
      itemMetadataBytes += descriptorBytes;
    }
    if (descriptors.length > 0) value[FILE_DOWNLOADS_ITEM_FIELD] = descriptors;
  }

  private issueCapability(
    id: string,
    href: string,
    path: string,
    authority: ThreadCwdRecord,
  ): CapabilityRecord | undefined {
    if (this.closed) return undefined;
    const currentAuthority = rootIdentity(authority.cwd);
    if (!currentAuthority || !sameRootIdentity(authority, currentAuthority)) return undefined;
    const relativePath = relativeWithin(authority.cwd, path) ??
      relativeWithin(authority.root, path);
    if (relativePath === undefined) return undefined;
    this.sweepExpired(this.now());
    const metadataBytes = Buffer.byteLength(
      `${id}\0${href}\0${path}\0${relativePath}\0${authority.cwd}\0${authority.root}\0${authority.rootDevice}\0${authority.rootInode}`,
      "utf8",
    ) + 32;
    if (metadataBytes > this.limits.maxCapabilityMetadataBytes) return undefined;

    while (
      this.capabilities.size >= this.limits.maxCapabilities ||
      this.capabilityMetadataBytes > this.limits.maxCapabilityMetadataBytes - metadataBytes
    ) {
      const oldest = this.capabilities.values().next().value as CapabilityRecord | undefined;
      if (!oldest) return undefined;
      this.removeCapability(oldest);
    }

    for (let attempt = 0; attempt < CAPABILITY_CREATION_ATTEMPTS; attempt += 1) {
      const capabilityId = randomBytes(24).toString("base64url");
      if (!CAPABILITY_ID_PATTERN.test(capabilityId) || this.capabilities.has(capabilityId)) {
        continue;
      }
      const record: CapabilityRecord = {
        id: capabilityId,
        threadId: id,
        href,
        path,
        relativePath,
        cwd: authority.cwd,
        root: authority.root,
        rootDevice: authority.rootDevice,
        rootInode: authority.rootInode,
        expiresAt: this.now() + this.limits.ttlMs,
        metadataBytes,
      };
      this.capabilities.set(capabilityId, record);
      this.capabilityMetadataBytes += metadataBytes;
      return record;
    }
    return undefined;
  }

  private revokeThreadCapabilities(id: string): void {
    for (const record of [...this.capabilities.values()]) {
      if (record.threadId === id) this.removeCapability(record);
    }
  }

  private observeTurns(id: string, value: unknown, revision: bigint): void {
    if (!Array.isArray(value)) return;
    for (const turn of value) {
      const observedTurnId = turnId(turn);
      if (observedTurnId && completedTurn(turn)) {
        this.rememberCompletedTurn(id, observedTurnId, revision);
      }
    }
  }

  private rememberCompletedTurn(id: string, observedTurnId: string, revision: bigint): void {
    if (
      Buffer.byteLength(id, "utf8") > this.limits.maxThreadIdBytes ||
      Buffer.byteLength(observedTurnId, "utf8") > this.limits.maxTurnIdBytes
    ) {
      return;
    }
    const key = completedTurnKey(id, observedTurnId);
    const existing = this.completedTurns.get(key);
    this.completedTurns.delete(key);
    this.completedTurns.set(key, {
      threadId: id,
      turnId: observedTurnId,
      revision: existing?.revision ?? revision,
    });
    while (this.completedTurns.size > this.limits.maxCompletedTurns) {
      const oldest = this.completedTurns.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completedTurns.delete(oldest);
    }
  }

  private isCompletedTurn(
    id: string,
    observedTurnId: string,
    requestRevision: bigint,
  ): boolean {
    const key = completedTurnKey(id, observedTurnId);
    const record = this.completedTurns.get(key);
    if (!record || requestRevision < record.revision) return false;
    this.completedTurns.delete(key);
    this.completedTurns.set(key, record);
    return true;
  }

  private forgetCompletedTurns(id: string): void {
    for (const [key, record] of this.completedTurns) {
      if (record.threadId === id) this.completedTurns.delete(key);
    }
  }

  private sweepExpired(now: number): void {
    for (const record of [...this.capabilities.values()]) {
      if (record.expiresAt <= now) this.removeCapability(record);
    }
  }

  private removeCapability(record: CapabilityRecord): void {
    if (this.capabilities.get(record.id) !== record) return;
    this.capabilities.delete(record.id);
    this.capabilityMetadataBytes = Math.max(
      0,
      this.capabilityMetadataBytes - record.metadataBytes,
    );
  }

  private clearCapabilities(): void {
    this.capabilities.clear();
    this.capabilityMetadataBytes = 0;
  }
}
