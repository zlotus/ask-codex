import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { ClientRpcError } from "./security.js";
import { isRecord } from "./types.js";

export const MAX_MESSAGE_QUEUE_TEXT_BYTES = 64 * 1024;
const MAX_MESSAGE_QUEUE_THREAD_ID_CHARACTERS = 256;
const MAX_MESSAGE_QUEUE_TURN_ID_CHARACTERS = 256;

export type MessageQueueStatus =
  | "queued"
  | "claimed"
  | "dispatching"
  | "needsReview"
  | "indeterminate"
  | "confirmed"
  | "expired"
  | "cancelled";

export type MessageQueueReviewReason =
  | "contextChanged"
  | "dispatchRejected"
  | "threadBusy"
  | "threadUnavailable";

export interface MessageQueueItem {
  id: string;
  threadId: string;
  text: string;
  expectedLastTurnId: string | null;
  status: MessageQueueStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  reviewReason?: MessageQueueReviewReason;
  confirmedTurnId?: string;
}

interface StoredMessageQueueItem extends MessageQueueItem {
  claimId?: string;
}

interface MessageQueueDocument {
  version: 1;
  revision: number;
  items: StoredMessageQueueItem[];
}

export interface MessageQueueLimits {
  maxActiveItems: number;
  maxRecords: number;
  maxStoreBytes: number;
  activeTtlMs: number;
  terminalRetentionMs: number;
}

export const DEFAULT_MESSAGE_QUEUE_LIMITS: Readonly<MessageQueueLimits> = {
  maxActiveItems: 64,
  maxRecords: 128,
  maxStoreBytes: 4 * 1024 * 1024,
  activeTtlMs: 7 * 24 * 60 * 60 * 1000,
  terminalRetentionMs: 24 * 60 * 60 * 1000,
};

const ACTIVE_STATUSES: ReadonlySet<MessageQueueStatus> = new Set([
  "queued",
  "claimed",
  "dispatching",
  "needsReview",
  "indeterminate",
]);
const TERMINAL_STATUSES: ReadonlySet<MessageQueueStatus> = new Set([
  "confirmed",
  "expired",
  "cancelled",
]);
const ALL_STATUSES: ReadonlySet<MessageQueueStatus> = new Set([
  ...ACTIVE_STATUSES,
  ...TERMINAL_STATUSES,
]);
const REVIEW_REASONS: ReadonlySet<MessageQueueReviewReason> = new Set([
  "contextChanged",
  "dispatchRejected",
  "threadBusy",
  "threadUnavailable",
]);
const QUEUE_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export class MessageQueueError extends ClientRpcError {
  constructor(message: string) {
    super(-32_020, message);
    this.name = "MessageQueueError";
  }
}

export interface MessageQueueStoreOptions {
  filePath?: string;
  limits?: Partial<MessageQueueLimits>;
  now?: () => number;
  makeId?: () => string;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function publicItem(item: StoredMessageQueueItem): MessageQueueItem {
  const projected = { ...item };
  delete projected.claimId;
  return projected;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseStoredItem(value: unknown): StoredMessageQueueItem {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !QUEUE_ID_PATTERN.test(value.id) ||
    typeof value.threadId !== "string" ||
    value.threadId.length === 0 ||
    value.threadId.length > MAX_MESSAGE_QUEUE_THREAD_ID_CHARACTERS ||
    typeof value.text !== "string" ||
    value.text.trim().length === 0 ||
    Buffer.byteLength(value.text, "utf8") > MAX_MESSAGE_QUEUE_TEXT_BYTES ||
    (value.expectedLastTurnId !== null && (
      typeof value.expectedLastTurnId !== "string" ||
      value.expectedLastTurnId.length === 0 ||
      value.expectedLastTurnId.length > MAX_MESSAGE_QUEUE_TURN_ID_CHARACTERS
    )) ||
    typeof value.status !== "string" ||
    !ALL_STATUSES.has(value.status as MessageQueueStatus) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) <= 0 ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isTimestamp(value.expiresAt)
  ) {
    throw new Error("ASK_CODEX_QUEUE_PATH contains an invalid queue item");
  }
  if (
    value.reviewReason !== undefined &&
    (typeof value.reviewReason !== "string" ||
      !REVIEW_REASONS.has(value.reviewReason as MessageQueueReviewReason))
  ) {
    throw new Error("ASK_CODEX_QUEUE_PATH contains an invalid review reason");
  }
  if (value.claimId !== undefined && (
    typeof value.claimId !== "string" ||
    value.claimId.length === 0 ||
    value.claimId.length > 256
  )) {
    throw new Error("ASK_CODEX_QUEUE_PATH contains an invalid claim");
  }
  const claimRequired = value.status === "claimed" || value.status === "dispatching";
  if (claimRequired !== (typeof value.claimId === "string" && value.claimId.length > 0)) {
    throw new Error("ASK_CODEX_QUEUE_PATH contains an invalid claim state");
  }
  if (value.confirmedTurnId !== undefined && (
    typeof value.confirmedTurnId !== "string" ||
    value.confirmedTurnId.length === 0 ||
    value.confirmedTurnId.length > MAX_MESSAGE_QUEUE_TURN_ID_CHARACTERS
  )) {
    throw new Error("ASK_CODEX_QUEUE_PATH contains an invalid confirmed turn");
  }
  if ((value.status === "confirmed") !== (typeof value.confirmedTurnId === "string")) {
    throw new Error("ASK_CODEX_QUEUE_PATH contains an invalid confirmation state");
  }
  return {
    id: value.id,
    threadId: value.threadId,
    text: value.text,
    expectedLastTurnId: value.expectedLastTurnId,
    status: value.status as MessageQueueStatus,
    revision: value.revision as number,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    expiresAt: value.expiresAt,
    ...(value.reviewReason === undefined
      ? {}
      : { reviewReason: value.reviewReason as MessageQueueReviewReason }),
    ...(value.claimId === undefined ? {} : { claimId: value.claimId }),
    ...(value.confirmedTurnId === undefined
      ? {}
      : { confirmedTurnId: value.confirmedTurnId }),
  };
}

function parseDocument(value: unknown, limits: MessageQueueLimits): MessageQueueDocument {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.items) ||
    value.items.length > limits.maxRecords
  ) {
    throw new Error("ASK_CODEX_QUEUE_PATH contains an unsupported queue document");
  }
  const items = value.items.map(parseStoredItem);
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error("ASK_CODEX_QUEUE_PATH contains duplicate queue IDs");
  }
  if (items.filter((item) => ACTIVE_STATUSES.has(item.status)).length > limits.maxActiveItems) {
    throw new Error("ASK_CODEX_QUEUE_PATH contains too many active queue items");
  }
  return { version: 1, revision: value.revision as number, items };
}

export class MessageQueueStore {
  private readonly filePath?: string;
  private readonly limits: MessageQueueLimits;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private items: StoredMessageQueueItem[] = [];
  private revision = 0;

  constructor(options: MessageQueueStoreOptions = {}) {
    this.filePath = options.filePath;
    this.limits = {
      ...DEFAULT_MESSAGE_QUEUE_LIMITS,
      ...options.limits,
    };
    positiveSafeInteger(this.limits.maxActiveItems, "maxActiveItems");
    positiveSafeInteger(this.limits.maxRecords, "maxRecords");
    positiveSafeInteger(this.limits.maxStoreBytes, "maxStoreBytes");
    positiveSafeInteger(this.limits.activeTtlMs, "activeTtlMs");
    positiveSafeInteger(this.limits.terminalRetentionMs, "terminalRetentionMs");
    if (this.limits.maxActiveItems > this.limits.maxRecords) {
      throw new Error("maxActiveItems must not exceed maxRecords");
    }
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? (() => randomBytes(24).toString("base64url"));
    this.load();
    this.recoverAfterRestart();
  }

  list(threadId: string): { revision: number; items: MessageQueueItem[] } {
    this.compact();
    return {
      revision: this.revision,
      items: this.items
        .filter((item) => item.threadId === threadId && ACTIVE_STATUSES.has(item.status))
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(publicItem),
    };
  }

  enqueue(input: {
    threadId: string;
    text: string;
    expectedLastTurnId: string | null;
  }): MessageQueueItem {
    if (
      !input.threadId ||
      input.threadId.length > MAX_MESSAGE_QUEUE_THREAD_ID_CHARACTERS ||
      !input.text.trim()
    ) {
      throw new MessageQueueError("Queued messages require a thread and non-empty text");
    }
    if (input.expectedLastTurnId !== null && (
      !input.expectedLastTurnId ||
      input.expectedLastTurnId.length > MAX_MESSAGE_QUEUE_TURN_ID_CHARACTERS
    )) {
      throw new MessageQueueError("Queued message has an invalid last turn ID");
    }
    if (Buffer.byteLength(input.text, "utf8") > MAX_MESSAGE_QUEUE_TEXT_BYTES) {
      throw new MessageQueueError("Queued message exceeds the 64 KiB text limit");
    }
    this.compact();
    const activeCount = this.items.filter((item) => ACTIVE_STATUSES.has(item.status)).length;
    if (activeCount >= this.limits.maxActiveItems) {
      throw new MessageQueueError("The persistent message queue is full");
    }

    const now = this.now();
    const id = this.makeId();
    if (!QUEUE_ID_PATTERN.test(id) || this.items.some((item) => item.id === id)) {
      throw new Error("Could not generate a unique queue ID");
    }
    const item: StoredMessageQueueItem = {
      id,
      threadId: input.threadId,
      text: input.text,
      expectedLastTurnId: input.expectedLastTurnId,
      status: "queued",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.limits.activeTtlMs,
    };
    let next = [...this.items, item];
    next = this.evictOldestTerminalRecords(next, this.limits.maxRecords);
    if (next.length > this.limits.maxRecords) {
      throw new MessageQueueError("The persistent message queue is full");
    }
    this.commitWithinBudget(next);
    return publicItem(item);
  }

  claim(
    id: string,
    expectedRevision: number,
    claimId: string,
    confirmReview: boolean,
  ): MessageQueueItem {
    this.compact();
    const item = this.requireItem(id, expectedRevision);
    if (item.status === "needsReview" && !confirmReview) {
      throw new MessageQueueError("Queued message requires explicit review before sending");
    }
    if (item.status === "queued" && confirmReview) {
      throw new MessageQueueError("Queued message has no review state to confirm");
    }
    if (item.status !== "queued" && item.status !== "needsReview") {
      throw new MessageQueueError("Queued message cannot be claimed in its current state");
    }
    return this.transition(item, {
      status: "claimed",
      claimId,
    });
  }

  markNeedsReview(
    id: string,
    claimId: string,
    reason: MessageQueueReviewReason,
  ): MessageQueueItem {
    const item = this.requireClaim(id, claimId, new Set(["claimed", "dispatching"]));
    return this.transition(item, {
      status: "needsReview",
      claimId: undefined,
      reviewReason: reason,
    });
  }

  markDispatching(id: string, claimId: string): MessageQueueItem {
    const item = this.requireClaim(id, claimId, new Set(["claimed"]));
    return this.transition(item, { status: "dispatching", reviewReason: undefined });
  }

  confirm(id: string, claimId: string, turnId: string): MessageQueueItem {
    const item = this.requireClaim(id, claimId, new Set(["dispatching"]));
    return this.transition(item, {
      status: "confirmed",
      claimId: undefined,
      confirmedTurnId: turnId,
    });
  }

  markIndeterminate(id: string, claimId: string): MessageQueueItem {
    const item = this.requireClaim(id, claimId, new Set(["dispatching"]));
    return this.transition(item, {
      status: "indeterminate",
      claimId: undefined,
    });
  }

  cancel(id: string, expectedRevision: number): MessageQueueItem {
    this.compact();
    const item = this.requireItem(id, expectedRevision);
    if (!new Set<MessageQueueStatus>(["queued", "needsReview", "indeterminate"]).has(item.status)) {
      throw new MessageQueueError("Queued message cannot be cancelled in its current state");
    }
    return this.transition(item, {
      status: "cancelled",
      claimId: undefined,
    });
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    const metadata = statSync(this.filePath);
    if (!metadata.isFile() || metadata.size > this.limits.maxStoreBytes) {
      throw new Error("ASK_CODEX_QUEUE_PATH must be a bounded regular file");
    }
    const serialized = readFileSync(this.filePath, "utf8");
    const document = parseDocument(JSON.parse(serialized) as unknown, this.limits);
    this.items = document.items;
    this.revision = document.revision;
  }

  private recoverAfterRestart(): void {
    const now = this.now();
    let changed = false;
    const recovered = this.items.map((item) => {
      if (item.status === "claimed") {
        changed = true;
        return {
          ...item,
          status: "queued" as const,
          revision: item.revision + 1,
          updatedAt: now,
          claimId: undefined,
          reviewReason: undefined,
        };
      }
      if (item.status === "dispatching") {
        changed = true;
        return {
          ...item,
          status: "indeterminate" as const,
          revision: item.revision + 1,
          updatedAt: now,
          claimId: undefined,
        };
      }
      return item;
    });
    const compacted = this.compactedItems(recovered, now);
    if (changed || compacted.length !== recovered.length || compacted.some((item, index) => item !== recovered[index])) {
      this.commitWithinBudget(compacted);
    }
  }

  private compact(): void {
    const next = this.compactedItems(this.items, this.now());
    if (next.length !== this.items.length || next.some((item, index) => item !== this.items[index])) {
      this.commitWithinBudget(next);
    }
  }

  private compactedItems(items: StoredMessageQueueItem[], now: number): StoredMessageQueueItem[] {
    return items.flatMap((item) => {
      if (TERMINAL_STATUSES.has(item.status)) {
        return now - item.updatedAt >= this.limits.terminalRetentionMs ? [] : [item];
      }
      if (now < item.expiresAt || item.status === "dispatching") return [item];
      return [{
        ...item,
        status: "expired" as const,
        revision: item.revision + 1,
        updatedAt: now,
        claimId: undefined,
      }];
    });
  }

  private requireItem(id: string, expectedRevision: number): StoredMessageQueueItem {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new MessageQueueError("Queued message is unavailable");
    if (item.revision !== expectedRevision) {
      throw new MessageQueueError("Queued message changed; refresh before retrying");
    }
    return item;
  }

  private requireClaim(
    id: string,
    claimId: string,
    statuses: ReadonlySet<MessageQueueStatus>,
  ): StoredMessageQueueItem {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item || item.claimId !== claimId || !statuses.has(item.status)) {
      throw new MessageQueueError("Queued message claim is no longer valid");
    }
    return item;
  }

  private transition(
    item: StoredMessageQueueItem,
    patch: Partial<StoredMessageQueueItem>,
  ): MessageQueueItem {
    const nextItem: StoredMessageQueueItem = {
      ...item,
      ...patch,
      revision: item.revision + 1,
      updatedAt: this.now(),
    };
    if (Object.hasOwn(patch, "claimId") && patch.claimId === undefined) {
      delete nextItem.claimId;
    }
    if (Object.hasOwn(patch, "reviewReason") && patch.reviewReason === undefined) {
      delete nextItem.reviewReason;
    }
    const next = this.items.map((candidate) => candidate.id === item.id ? nextItem : candidate);
    this.commitWithinBudget(next);
    return publicItem(nextItem);
  }

  private evictOldestTerminalRecords(
    items: StoredMessageQueueItem[],
    maximum: number,
  ): StoredMessageQueueItem[] {
    if (items.length <= maximum) return items;
    const removable = items
      .filter((item) => TERMINAL_STATUSES.has(item.status))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    const remove = new Set(removable.slice(0, items.length - maximum).map((item) => item.id));
    return items.filter((item) => !remove.has(item.id));
  }

  private commitWithinBudget(items: StoredMessageQueueItem[]): void {
    const nextRevision = this.revision + 1;
    const serialized = JSON.stringify({ version: 1, revision: nextRevision, items });
    if (Buffer.byteLength(serialized, "utf8") > this.limits.maxStoreBytes) {
      throw new MessageQueueError("The persistent message queue storage budget is exhausted");
    }
    if (this.filePath) this.writeAtomically(serialized);
    this.items = items;
    this.revision = nextRevision;
  }

  private writeAtomically(serialized: string): void {
    const filePath = this.filePath!;
    const directory = dirname(filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, filePath);
      const directoryDescriptor = openSync(directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The rename may already have consumed the temporary file.
      }
      throw error;
    }
  }
}
