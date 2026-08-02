import type {
  AccountRateLimitsSnapshot,
  AccountUsageDailyBucket,
  AccountUsageSnapshot,
  ActivityKind,
  CodexThread,
  NotificationMessage,
  RateLimitSnapshot,
  RateLimitWindow,
  ThreadActivityEvent,
  ThreadTokenUsage,
  TokenUsageBreakdown,
} from "../types/protocol";
import { isRecord, readString, timestampMilliseconds } from "./protocol";

const MAX_DAILY_USAGE_BUCKETS = 366;
const MAX_RATE_LIMIT_BUCKETS = 32;
const MAX_RATE_LIMIT_ID_CHARACTERS = 128;

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function nullableNonNegativeNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : nonNegativeNumber(value);
}

function boundedString(value: unknown, maximum = MAX_RATE_LIMIT_ID_CHARACTERS): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : null;
}

function normalizeTokenBreakdown(value: unknown): TokenUsageBreakdown | null {
  if (!isRecord(value)) return null;
  const totalTokens = nonNegativeNumber(value.totalTokens);
  const inputTokens = nonNegativeNumber(value.inputTokens);
  const cachedInputTokens = nonNegativeNumber(value.cachedInputTokens);
  const cacheWriteInputTokens = nonNegativeNumber(value.cacheWriteInputTokens);
  const outputTokens = nonNegativeNumber(value.outputTokens);
  const reasoningOutputTokens = nonNegativeNumber(value.reasoningOutputTokens);
  if (
    totalTokens === null ||
    inputTokens === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null
  ) {
    return null;
  }
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}

export function extractThreadTokenUsage(value: unknown): ThreadTokenUsage | null {
  const candidate = isRecord(value) && "tokenUsage" in value ? value.tokenUsage : value;
  if (!isRecord(candidate)) return null;
  const total = normalizeTokenBreakdown(candidate.total);
  const last = normalizeTokenBreakdown(candidate.last);
  const modelContextWindow = nullableNonNegativeNumber(candidate.modelContextWindow);
  if (!total || !last || (candidate.modelContextWindow !== null && modelContextWindow === null)) {
    return null;
  }
  return { total, last, modelContextWindow };
}

function normalizeUsageBucket(value: unknown): AccountUsageDailyBucket | null {
  if (!isRecord(value)) return null;
  const startDate = readString(value.startDate);
  const tokens = nonNegativeNumber(value.tokens);
  if (!startDate || startDate.length > 32 || tokens === null) return null;
  return { startDate, tokens };
}

export function extractAccountUsage(value: unknown): AccountUsageSnapshot | null {
  if (!isRecord(value) || !isRecord(value.summary)) return null;
  const dailyUsageBuckets = value.dailyUsageBuckets === null || value.dailyUsageBuckets === undefined
    ? null
    : Array.isArray(value.dailyUsageBuckets)
      ? value.dailyUsageBuckets
          .slice(-MAX_DAILY_USAGE_BUCKETS)
          .map(normalizeUsageBucket)
          .filter((entry): entry is AccountUsageDailyBucket => entry !== null)
      : null;
  if (value.dailyUsageBuckets !== null && value.dailyUsageBuckets !== undefined && !Array.isArray(value.dailyUsageBuckets)) {
    return null;
  }
  return {
    summary: {
      lifetimeTokens: nullableNonNegativeNumber(value.summary.lifetimeTokens),
      peakDailyTokens: nullableNonNegativeNumber(value.summary.peakDailyTokens),
      longestRunningTurnSec: nullableNonNegativeNumber(value.summary.longestRunningTurnSec),
      currentStreakDays: nullableNonNegativeNumber(value.summary.currentStreakDays),
      longestStreakDays: nullableNonNegativeNumber(value.summary.longestStreakDays),
    },
    dailyUsageBuckets,
  };
}

function normalizeWindow(value: unknown): RateLimitWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = nonNegativeNumber(value.usedPercent);
  const windowDurationMins = nullableNonNegativeNumber(value.windowDurationMins);
  const resetsAt = nullableNonNegativeNumber(value.resetsAt);
  if (usedPercent === null || usedPercent > 100) return null;
  return { usedPercent, windowDurationMins, resetsAt };
}

function normalizeRateLimitSnapshot(value: unknown): RateLimitSnapshot | null {
  if (!isRecord(value)) return null;
  const primary = value.primary === null || value.primary === undefined
    ? null
    : normalizeWindow(value.primary);
  const secondary = value.secondary === null || value.secondary === undefined
    ? null
    : normalizeWindow(value.secondary);
  if ((value.primary !== null && value.primary !== undefined && !primary) ||
      (value.secondary !== null && value.secondary !== undefined && !secondary)) {
    return null;
  }
  const rawCredits = value.credits;
  const credits = isRecord(rawCredits) &&
      typeof rawCredits.hasCredits === "boolean" &&
      typeof rawCredits.unlimited === "boolean"
    ? {
        hasCredits: rawCredits.hasCredits,
        unlimited: rawCredits.unlimited,
        balance: boundedString(rawCredits.balance, 64),
      }
    : null;
  const spendControlReached = value.spendControlReached === null || value.spendControlReached === undefined
    ? null
    : typeof value.spendControlReached === "boolean" ? value.spendControlReached : undefined;
  if (spendControlReached === undefined) return null;
  return {
    limitId: boundedString(value.limitId),
    limitName: boundedString(value.limitName),
    primary,
    secondary,
    credits,
    spendControlReached,
    planType: boundedString(value.planType, 64),
    rateLimitReachedType: boundedString(value.rateLimitReachedType, 128),
  };
}

export function extractAccountRateLimits(value: unknown): AccountRateLimitsSnapshot | null {
  if (!isRecord(value)) return null;
  const rateLimits = value.rateLimits === null || value.rateLimits === undefined
    ? null
    : normalizeRateLimitSnapshot(value.rateLimits);
  if (value.rateLimits !== null && value.rateLimits !== undefined && !rateLimits) return null;

  let rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null = null;
  if (value.rateLimitsByLimitId !== null && value.rateLimitsByLimitId !== undefined) {
    if (!isRecord(value.rateLimitsByLimitId)) return null;
    rateLimitsByLimitId = {};
    for (const [rawId, rawSnapshot] of Object.entries(value.rateLimitsByLimitId).slice(0, MAX_RATE_LIMIT_BUCKETS)) {
      const id = boundedString(rawId);
      const snapshot = normalizeRateLimitSnapshot(rawSnapshot);
      if (id && snapshot) rateLimitsByLimitId[id] = snapshot;
    }
  }
  return { rateLimits, rateLimitsByLimitId };
}

function mergeWindow(current: RateLimitWindow | null, value: unknown): RateLimitWindow | null {
  if (!isRecord(value)) return current;
  const usedPercent = nonNegativeNumber(value.usedPercent);
  const windowDurationMins = nullableNonNegativeNumber(value.windowDurationMins);
  const resetsAt = nullableNonNegativeNumber(value.resetsAt);
  return {
    usedPercent: usedPercent !== null && usedPercent <= 100 ? usedPercent : current?.usedPercent ?? 0,
    windowDurationMins: windowDurationMins ?? current?.windowDurationMins ?? null,
    resetsAt: resetsAt ?? current?.resetsAt ?? null,
  };
}

function mergeRateLimitSnapshot(
  current: RateLimitSnapshot | null,
  value: Record<string, unknown>,
): RateLimitSnapshot {
  const rawCredits = value.credits;
  const credits = isRecord(rawCredits) &&
      typeof rawCredits.hasCredits === "boolean" &&
      typeof rawCredits.unlimited === "boolean"
    ? {
        hasCredits: rawCredits.hasCredits,
        unlimited: rawCredits.unlimited,
        balance: boundedString(rawCredits.balance, 64) ?? current?.credits?.balance ?? null,
      }
    : current?.credits ?? null;
  return {
    limitId: boundedString(value.limitId) ?? current?.limitId ?? null,
    limitName: boundedString(value.limitName) ?? current?.limitName ?? null,
    primary: mergeWindow(current?.primary ?? null, value.primary),
    secondary: mergeWindow(current?.secondary ?? null, value.secondary),
    credits,
    spendControlReached: typeof value.spendControlReached === "boolean"
      ? value.spendControlReached
      : current?.spendControlReached ?? null,
    planType: boundedString(value.planType, 64) ?? current?.planType ?? null,
    rateLimitReachedType: boundedString(value.rateLimitReachedType, 128) ?? current?.rateLimitReachedType ?? null,
  };
}

export function mergeAccountRateLimitUpdate(
  current: AccountRateLimitsSnapshot | null,
  value: unknown,
): AccountRateLimitsSnapshot | null {
  const params = isRecord(value) && isRecord(value.rateLimits) ? value.rateLimits : null;
  if (!params) return current;
  const limitId = boundedString(params.limitId) ?? current?.rateLimits?.limitId ?? null;
  const existingById = limitId ? current?.rateLimitsByLimitId?.[limitId] ?? null : null;
  const existingTopLevel = current?.rateLimits && (
    !limitId || current.rateLimits.limitId === limitId
  ) ? current.rateLimits : null;
  const existing = existingById ?? existingTopLevel;
  const merged = mergeRateLimitSnapshot(existing, params);
  const rateLimitsByLimitId = current?.rateLimitsByLimitId
    ? { ...current.rateLimitsByLimitId }
    : limitId ? {} as Record<string, RateLimitSnapshot> : null;
  const currentLimitId = current?.rateLimits?.limitId;
  if (rateLimitsByLimitId && currentLimitId && !rateLimitsByLimitId[currentLimitId]) {
    rateLimitsByLimitId[currentLimitId] = current.rateLimits!;
  }
  if (limitId && rateLimitsByLimitId) {
    delete rateLimitsByLimitId[limitId];
    rateLimitsByLimitId[limitId] = merged;
    while (Object.keys(rateLimitsByLimitId).length > MAX_RATE_LIMIT_BUCKETS) {
      const evictedId = Object.keys(rateLimitsByLimitId).find((id) => (
        id !== limitId && id !== currentLimitId
      )) ?? Object.keys(rateLimitsByLimitId).find((id) => id !== limitId);
      if (!evictedId) break;
      delete rateLimitsByLimitId[evictedId];
    }
  }
  return {
    rateLimits: !current?.rateLimits || !limitId || current.rateLimits.limitId === limitId
      ? merged
      : current.rateLimits,
    rateLimitsByLimitId,
  };
}

export function activityKindForThread(thread: CodexThread): ActivityKind | null {
  const status = thread.status;
  if (typeof status === "string") {
    const normalized = status.toLowerCase().replaceAll("_", "");
    if (normalized === "active" || normalized === "inprogress") return "running";
    if (normalized === "systemerror" || normalized === "failed") return "systemError";
    return null;
  }
  if (!isRecord(status)) return null;
  if (status.type === "systemError") return "systemError";
  if (status.type !== "active") return null;
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  if (flags.includes("waitingOnApproval")) return "waitingApproval";
  if (flags.includes("waitingOnUserInput")) return "waitingInput";
  return "running";
}

function eventTimestamp(value: unknown, fallback: number): number {
  return timestampMilliseconds(value) ?? fallback;
}

export function activityEventFromNotification(
  message: NotificationMessage,
  fallbackTime = Date.now(),
): ThreadActivityEvent | null {
  if (!isRecord(message.params)) return null;
  const threadId = readString(message.params.threadId);
  if (!threadId) return null;
  if (message.method === "turn/started") {
    const turn = isRecord(message.params.turn) ? message.params.turn : {};
    return {
      threadId,
      turnId: readString(turn.id),
      kind: "running",
      occurredAt: eventTimestamp(turn.startedAt, fallbackTime),
    };
  }
  if (message.method === "turn/completed") {
    const turn = isRecord(message.params.turn) ? message.params.turn : {};
    const status = readString(turn.status) ?? readString(message.params.status) ?? "completed";
    const kind: ActivityKind = status === "failed"
      ? "failed"
      : status === "interrupted" ? "interrupted" : "completed";
    const durationMs = nonNegativeNumber(turn.durationMs);
    return {
      threadId,
      turnId: readString(turn.id) ?? readString(message.params.turnId),
      kind,
      occurredAt: eventTimestamp(turn.completedAt, fallbackTime),
      ...(durationMs === null ? {} : { durationMs }),
    };
  }
  if (message.method === "thread/status/changed") {
    const status = typeof message.params.status === "string" || isRecord(message.params.status)
      ? message.params.status
      : undefined;
    const kind = activityKindForThread({ id: threadId, status });
    return kind ? { threadId, kind, occurredAt: fallbackTime } : null;
  }
  return null;
}
