import { isRecord } from "./types.js";

const PLAN_UPDATE_METHOD = "turn/plan/updated";
const PLAN_STATUSES = new Set(["pending", "inProgress", "completed"]);

export interface TurnPlanCacheLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxSnapshotBytes: number;
  maxDecorationBytes: number;
  maxDecoratedPlans: number;
  maxSteps: number;
  maxExplanationBytes: number;
  maxStepBytes: number;
  maxThreadIdBytes: number;
  maxTurnIdBytes: number;
}

export const DEFAULT_TURN_PLAN_CACHE_LIMITS: Readonly<TurnPlanCacheLimits> = Object.freeze({
  maxEntries: 512,
  maxTotalBytes: 8 * 1024 * 1024,
  maxSnapshotBytes: 128 * 1024,
  maxDecorationBytes: 256 * 1024,
  maxDecoratedPlans: 128,
  maxSteps: 128,
  maxExplanationBytes: 32 * 1024,
  maxStepBytes: 8 * 1024,
  maxThreadIdBytes: 256,
  maxTurnIdBytes: 256,
});

export interface TurnPlanTiming {
  emittedAtMs?: number;
  gatewayReceivedAtMs: number;
}

export interface TurnPlanNotificationObservation {
  projectedParams: unknown;
  recoveryRequired: boolean;
  threadId?: string;
  turnId?: string;
}

interface CachedPlanStep {
  step: string;
  status: string;
}

interface CachedTurnPlan {
  explanation?: string;
  plan: CachedPlanStep[];
  emittedAtMs?: number;
  gatewayReceivedAtMs: number;
}

interface CacheRecord {
  threadId: string;
  turnId: string;
  plan: CachedTurnPlan | null;
  unavailable: boolean;
  bytes: number;
}

interface DecorationBudget {
  remainingBytes: number;
  remainingPlans: number;
}

function cacheKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedIdentifier(value: unknown, maximumBytes: number): string | undefined {
  return typeof value === "string" && value.length > 0 && utf8Bytes(value) <= maximumBytes
    ? value
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function cacheRecord(
  threadId: string,
  turnId: string,
  plan: CachedTurnPlan | null,
  unavailable: boolean,
): CacheRecord {
  const bytes = utf8Bytes(cacheKey(threadId, turnId)) + utf8Bytes(JSON.stringify({
    threadId,
    turnId,
    plan,
    unavailable,
  })) + 64;
  return { threadId, turnId, plan, unavailable, bytes };
}

function clonePlan(plan: CachedTurnPlan): CachedTurnPlan {
  return {
    ...(plan.explanation === undefined ? {} : { explanation: plan.explanation }),
    plan: plan.plan.map((step) => ({ ...step })),
    ...(plan.emittedAtMs === undefined ? {} : { emittedAtMs: plan.emittedAtMs }),
    gatewayReceivedAtMs: plan.gatewayReceivedAtMs,
  };
}

function livePlanParams(
  threadId: string,
  turnId: string,
  plan: CachedTurnPlan,
): Record<string, unknown> {
  return {
    threadId,
    turnId,
    ...(plan.explanation === undefined ? {} : { explanation: plan.explanation }),
    plan: plan.plan.map((step) => ({ ...step })),
  };
}

function recoveryOmissions(value: unknown, unavailable: boolean): string[] | undefined {
  const existing = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
  const next = unavailable
    ? [...new Set([...existing, PLAN_UPDATE_METHOD])]
    : existing.filter((method) => method !== PLAN_UPDATE_METHOD);
  return next.length > 0 ? next : undefined;
}

export class TurnPlanCache {
  private readonly limits: TurnPlanCacheLimits;
  private readonly records = new Map<string, CacheRecord>();
  private totalBytes = 0;

  constructor(limits: Partial<TurnPlanCacheLimits> = {}) {
    this.limits = {
      maxEntries: positiveInteger(
        limits.maxEntries,
        DEFAULT_TURN_PLAN_CACHE_LIMITS.maxEntries,
        "maxEntries",
      ),
      maxTotalBytes: positiveInteger(
        limits.maxTotalBytes,
        DEFAULT_TURN_PLAN_CACHE_LIMITS.maxTotalBytes,
        "maxTotalBytes",
      ),
      maxSnapshotBytes: positiveInteger(
        limits.maxSnapshotBytes,
        DEFAULT_TURN_PLAN_CACHE_LIMITS.maxSnapshotBytes,
        "maxSnapshotBytes",
      ),
      maxDecorationBytes: positiveInteger(
        limits.maxDecorationBytes,
        DEFAULT_TURN_PLAN_CACHE_LIMITS.maxDecorationBytes,
        "maxDecorationBytes",
      ),
      maxDecoratedPlans: positiveInteger(
        limits.maxDecoratedPlans,
        DEFAULT_TURN_PLAN_CACHE_LIMITS.maxDecoratedPlans,
        "maxDecoratedPlans",
      ),
      maxSteps: positiveInteger(
        limits.maxSteps,
        DEFAULT_TURN_PLAN_CACHE_LIMITS.maxSteps,
        "maxSteps",
      ),
      maxExplanationBytes: positiveInteger(
        limits.maxExplanationBytes,
        DEFAULT_TURN_PLAN_CACHE_LIMITS.maxExplanationBytes,
        "maxExplanationBytes",
      ),
      maxStepBytes: positiveInteger(
        limits.maxStepBytes,
        DEFAULT_TURN_PLAN_CACHE_LIMITS.maxStepBytes,
        "maxStepBytes",
      ),
      maxThreadIdBytes: positiveInteger(
        limits.maxThreadIdBytes,
        DEFAULT_TURN_PLAN_CACHE_LIMITS.maxThreadIdBytes,
        "maxThreadIdBytes",
      ),
      maxTurnIdBytes: positiveInteger(
        limits.maxTurnIdBytes,
        DEFAULT_TURN_PLAN_CACHE_LIMITS.maxTurnIdBytes,
        "maxTurnIdBytes",
      ),
    };
  }

  observeNotification(
    method: string,
    params: unknown,
    timing: TurnPlanTiming,
  ): TurnPlanNotificationObservation {
    if (!isRecord(params)) {
      return {
        projectedParams: params,
        recoveryRequired: method === PLAN_UPDATE_METHOD,
      };
    }
    if (method === "thread/deleted") {
      const threadId = boundedIdentifier(params.threadId, this.limits.maxThreadIdBytes);
      if (threadId) this.forgetThread(threadId);
      return { projectedParams: params, recoveryRequired: false };
    }
    if (method !== PLAN_UPDATE_METHOD) {
      return { projectedParams: params, recoveryRequired: false };
    }

    const threadId = boundedIdentifier(params.threadId, this.limits.maxThreadIdBytes);
    const turnId = boundedIdentifier(params.turnId, this.limits.maxTurnIdBytes);
    if (!threadId || !turnId) {
      return {
        projectedParams: {},
        recoveryRequired: true,
        ...(threadId === undefined ? {} : { threadId }),
        ...(turnId === undefined ? {} : { turnId }),
      };
    }

    const plan = this.parsePlan(params, timing);
    if (!plan) {
      this.remember(cacheRecord(threadId, turnId, null, true));
      return { projectedParams: {}, recoveryRequired: true, threadId, turnId };
    }

    const record = cacheRecord(threadId, turnId, plan, false);
    if (record.bytes > this.limits.maxSnapshotBytes || record.bytes > this.limits.maxTotalBytes) {
      this.remember(cacheRecord(threadId, turnId, null, true));
      return { projectedParams: {}, recoveryRequired: true, threadId, turnId };
    }
    this.remember(record);
    return {
      projectedParams: livePlanParams(threadId, turnId, plan),
      recoveryRequired: false,
    };
  }

  observeRpcResult(method: string, params: unknown): void {
    if (method !== "thread/delete" || !isRecord(params)) return;
    const threadId = boundedIdentifier(params.threadId, this.limits.maxThreadIdBytes);
    if (threadId) this.forgetThread(threadId);
  }

  decorateRpcResult(method: string, params: unknown, projectedResult: unknown): unknown {
    if (!isRecord(params) || !isRecord(projectedResult)) return projectedResult;
    const threadId = boundedIdentifier(params.threadId, this.limits.maxThreadIdBytes);
    if (!threadId) return projectedResult;
    const budget = this.decorationBudget();

    if (method === "thread/turns/list" && Array.isArray(projectedResult.data)) {
      this.decorateTurns(projectedResult.data, threadId, budget);
      return projectedResult;
    }

    if (method === "thread/read" || method === "thread/resume") {
      const thread = isRecord(projectedResult.thread)
        ? projectedResult.thread
        : projectedResult.id === threadId ? projectedResult : undefined;
      if (!thread || thread.id !== threadId) return projectedResult;
      if (Array.isArray(thread.turns)) {
        this.decorateTurns(thread.turns, threadId, budget);
      }
      if (isRecord(projectedResult.initialTurnsPage) && Array.isArray(projectedResult.initialTurnsPage.data)) {
        this.decorateTurns(projectedResult.initialTurnsPage.data, threadId, budget);
      }
      return projectedResult;
    }

    if (method === "turn/start" && isRecord(projectedResult.turn)) {
      this.decorateTurn(projectedResult.turn, threadId, budget);
    }
    return projectedResult;
  }

  decorateNotification(method: string, projectedParams: unknown): unknown {
    if (
      (method !== "turn/started" && method !== "turn/completed") ||
      !isRecord(projectedParams)
    ) {
      return projectedParams;
    }
    const threadId = boundedIdentifier(projectedParams.threadId, this.limits.maxThreadIdBytes);
    if (threadId && isRecord(projectedParams.turn)) {
      this.decorateTurn(projectedParams.turn, threadId, this.decorationBudget());
    }
    return projectedParams;
  }

  private parsePlan(params: Record<string, unknown>, timing: TurnPlanTiming): CachedTurnPlan | null {
    if (!Array.isArray(params.plan) || params.plan.length > this.limits.maxSteps) return null;
    const explanation = typeof params.explanation === "string" &&
        utf8Bytes(params.explanation) <= this.limits.maxExplanationBytes
      ? params.explanation
      : undefined;

    const plan: CachedPlanStep[] = [];
    for (const entry of params.plan) {
      if (
        !isRecord(entry) ||
        typeof entry.step !== "string" ||
        utf8Bytes(entry.step) > this.limits.maxStepBytes ||
        typeof entry.status !== "string" ||
        !PLAN_STATUSES.has(entry.status)
      ) {
        return null;
      }
      plan.push({ step: entry.step, status: entry.status });
    }

    const gatewayReceivedAtMs = timestamp(timing.gatewayReceivedAtMs);
    if (gatewayReceivedAtMs === undefined) return null;
    const emittedAtMs = timestamp(timing.emittedAtMs);
    return {
      ...(explanation === undefined ? {} : { explanation }),
      plan,
      ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
      gatewayReceivedAtMs,
    };
  }

  private decorationBudget(): DecorationBudget {
    return {
      remainingBytes: this.limits.maxDecorationBytes,
      remainingPlans: this.limits.maxDecoratedPlans,
    };
  }

  private decorateTurns(
    values: unknown[],
    threadId: string,
    budget: DecorationBudget,
  ): void {
    const seenTurnIds = new Set<string>();
    for (const value of values) {
      const turnId = isRecord(value)
        ? boundedIdentifier(value.id, this.limits.maxTurnIdBytes)
        : undefined;
      const duplicate = turnId !== undefined && seenTurnIds.has(turnId);
      if (turnId !== undefined) seenTurnIds.add(turnId);
      this.decorateTurn(value, threadId, budget, duplicate);
    }
  }

  private decorateTurn(
    value: unknown,
    threadId: string,
    budget: DecorationBudget,
    duplicate = false,
  ): void {
    if (!isRecord(value)) return;
    const turnId = boundedIdentifier(value.id, this.limits.maxTurnIdBytes);
    if (!turnId) return;
    if (Object.hasOwn(value, "plan")) return;

    const record = this.get(threadId, turnId);
    if (!record) return;
    if (record.plan && !duplicate &&
      budget.remainingPlans > 0 && budget.remainingBytes >= record.bytes) {
      value.plan = clonePlan(record.plan);
      budget.remainingPlans -= 1;
      budget.remainingBytes -= record.bytes;
      const omissions = recoveryOmissions(value.recoveryOmissions, false);
      if (omissions) value.recoveryOmissions = omissions;
      else delete value.recoveryOmissions;
      return;
    }

    value.plan = null;
    if (record.unavailable || record.plan) {
      value.recoveryOmissions = recoveryOmissions(value.recoveryOmissions, true);
    }
  }

  private get(threadId: string, turnId: string): CacheRecord | undefined {
    return this.records.get(cacheKey(threadId, turnId));
  }

  private remember(record: CacheRecord): void {
    const key = cacheKey(record.threadId, record.turnId);
    const existing = this.records.get(key);
    if (existing) {
      this.records.delete(key);
      this.totalBytes = Math.max(0, this.totalBytes - existing.bytes);
    }
    if (record.bytes > this.limits.maxTotalBytes) return;

    while (
      this.records.size >= this.limits.maxEntries ||
      this.totalBytes > this.limits.maxTotalBytes - record.bytes
    ) {
      const oldestKey = this.records.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.records.get(oldestKey);
      this.records.delete(oldestKey);
      if (oldest) this.totalBytes = Math.max(0, this.totalBytes - oldest.bytes);
    }
    this.records.set(key, record);
    this.totalBytes += record.bytes;
  }

  private forgetThread(threadId: string): void {
    for (const [key, record] of this.records) {
      if (record.threadId !== threadId) continue;
      this.records.delete(key);
      this.totalBytes = Math.max(0, this.totalBytes - record.bytes);
    }
  }
}
