import type {
  MessageQueueItem,
  MessageQueueReviewReason,
  MessageQueueSnapshot,
  MessageQueueStatus,
} from "../types/protocol";
import { isRecord } from "./protocol";

const MAX_QUEUE_ITEMS = 64;
const MAX_QUEUE_TEXT_BYTES = 64 * 1024;
const QUEUE_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const STATUSES: ReadonlySet<MessageQueueStatus> = new Set([
  "queued",
  "claimed",
  "dispatching",
  "needsReview",
  "indeterminate",
  "confirmed",
  "expired",
  "cancelled",
]);
const REVIEW_REASONS: ReadonlySet<MessageQueueReviewReason> = new Set([
  "contextChanged",
  "dispatchRejected",
  "threadBusy",
  "threadUnavailable",
]);

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function queueItem(value: unknown): MessageQueueItem | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !QUEUE_ID_PATTERN.test(value.id) ||
    typeof value.threadId !== "string" ||
    !value.threadId ||
    typeof value.text !== "string" ||
    new TextEncoder().encode(value.text).byteLength > MAX_QUEUE_TEXT_BYTES ||
    (value.expectedLastTurnId !== null && typeof value.expectedLastTurnId !== "string") ||
    typeof value.status !== "string" ||
    !STATUSES.has(value.status as MessageQueueStatus) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) <= 0
  ) {
    return null;
  }
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  const expiresAt = timestamp(value.expiresAt);
  if (createdAt === null || updatedAt === null || expiresAt === null) return null;
  if (
    value.reviewReason !== undefined &&
    (typeof value.reviewReason !== "string" ||
      !REVIEW_REASONS.has(value.reviewReason as MessageQueueReviewReason))
  ) {
    return null;
  }
  if (value.confirmedTurnId !== undefined && typeof value.confirmedTurnId !== "string") {
    return null;
  }
  return {
    id: value.id,
    threadId: value.threadId,
    text: value.text,
    expectedLastTurnId: value.expectedLastTurnId,
    status: value.status as MessageQueueStatus,
    revision: value.revision as number,
    createdAt,
    updatedAt,
    expiresAt,
    ...(value.reviewReason === undefined
      ? {}
      : { reviewReason: value.reviewReason as MessageQueueReviewReason }),
    ...(value.confirmedTurnId === undefined
      ? {}
      : { confirmedTurnId: value.confirmedTurnId }),
  };
}

export function extractMessageQueueSnapshot(value: unknown): MessageQueueSnapshot | null {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_QUEUE_ITEMS
  ) {
    return null;
  }
  const items = value.items.map(queueItem);
  if (items.some((item) => item === null)) return null;
  return { revision: value.revision as number, items: items as MessageQueueItem[] };
}

export function extractMessageQueueItem(value: unknown): MessageQueueItem | null {
  return queueItem(isRecord(value) ? value.item : undefined);
}
