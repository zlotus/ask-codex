import type {
  ActivityKind,
  CodexThread,
  PendingRequest,
  ThreadActivityEvent,
} from "../types/protocol";
import { activityKindForThread } from "../utils/monitoring";
import { isRecord, threadRecencyTimestamp, timestampMilliseconds } from "../utils/protocol";

export interface ActivityEntry {
  thread: CodexThread;
  kind: ActivityKind;
  occurredAt: number;
  durationMs?: number;
}

const MAX_RECENT_ACTIVITY = 12;

export function threadTitle(thread: CodexThread): string {
  return thread.name?.trim() || thread.preview?.trim() || "Untitled thread";
}

function requestThreadId(request: PendingRequest): string | null {
  const value = request.params.threadId ?? request.params.conversationId;
  return typeof value === "string" && value ? value : null;
}

function requestKind(request: PendingRequest): ActivityKind {
  return request.method === "tool/requestUserInput" || request.method.endsWith("requestUserInput")
    ? "waitingInput"
    : "waitingApproval";
}

function entryTime(thread: CodexThread): number {
  return timestampMilliseconds(threadRecencyTimestamp(thread)) ?? 0;
}

function hasExplicitInactiveStatus(thread: CodexThread): boolean {
  if (typeof thread.status === "string") {
    const status = thread.status.toLowerCase().replaceAll("_", "");
    return status === "idle" || status === "notloaded" || status === "completed";
  }
  if (!isRecord(thread.status)) return false;
  return thread.status.type === "idle" || thread.status.type === "notLoaded";
}

function isTransientKind(kind: ActivityKind): boolean {
  return kind === "waitingApproval" ||
    kind === "waitingInput" ||
    kind === "running" ||
    kind === "systemError";
}

export function buildActivityEntries(
  threads: readonly CodexThread[],
  recentEvents: readonly ThreadActivityEvent[],
  pendingRequests: readonly PendingRequest[],
): ActivityEntry[] {
  const byThread = new Map(threads.map((thread) => [thread.id, thread]));
  const latestEvents = new Map<string, ThreadActivityEvent>();
  for (const event of recentEvents) {
    const current = latestEvents.get(event.threadId);
    if (!current || event.occurredAt >= current.occurredAt) latestEvents.set(event.threadId, event);
  }
  const pending = new Map<string, { kind: ActivityKind; occurredAt: number }>();
  for (const request of pendingRequests) {
    const threadId = requestThreadId(request);
    if (!threadId) continue;
    const kind = requestKind(request);
    const current = pending.get(threadId);
    if (!current || kind === "waitingInput" || request.receivedAt >= current.occurredAt) {
      pending.set(threadId, { kind, occurredAt: request.receivedAt });
    }
  }

  const live: ActivityEntry[] = [];
  const recent: ActivityEntry[] = [];
  for (const thread of threads) {
    const waiting = pending.get(thread.id);
    const runtimeKind = activityKindForThread(thread);
    const event = latestEvents.get(thread.id);
    if (waiting) {
      live.push({ thread, ...waiting });
    } else if (runtimeKind) {
      live.push({
        thread,
        kind: runtimeKind,
        occurredAt: event?.occurredAt ?? entryTime(thread),
        ...(event?.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      });
    } else if (event) {
      recent.push({
        thread,
        kind: hasExplicitInactiveStatus(thread) && isTransientKind(event.kind)
          ? "updated"
          : event.kind,
        occurredAt: event.occurredAt,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      });
    }
  }

  const represented = new Set([...live, ...recent].map((entry) => entry.thread.id));
  const fallback = threads
    .filter((thread) => !represented.has(thread.id))
    .sort((left, right) => entryTime(right) - entryTime(left))
    .slice(0, Math.max(0, MAX_RECENT_ACTIVITY - recent.length))
    .map((thread): ActivityEntry => ({
      thread,
      kind: "updated",
      occurredAt: entryTime(thread),
    }));
  const boundedRecent = [...recent, ...fallback]
    .sort((left, right) => right.occurredAt - left.occurredAt)
    .slice(0, MAX_RECENT_ACTIVITY);

  const priority: Record<ActivityKind, number> = {
    waitingApproval: 0,
    waitingInput: 1,
    systemError: 2,
    running: 3,
    failed: 4,
    interrupted: 5,
    completed: 6,
    updated: 7,
  };
  return [...live, ...boundedRecent]
    .filter((entry) => byThread.has(entry.thread.id))
    .sort((left, right) => (
      priority[left.kind] - priority[right.kind] || right.occurredAt - left.occurredAt
    ));
}

export function monitoredActivityCount(
  threads: readonly CodexThread[],
  pendingRequests: readonly PendingRequest[],
): number {
  const pendingThreadIds = new Set(pendingRequests.map(requestThreadId).filter(Boolean));
  return threads.filter((thread) => pendingThreadIds.has(thread.id) || activityKindForThread(thread) !== null).length;
}
