import { describe, expect, it } from "vitest";
import {
  activityEventFromNotification,
  activityKindForThread,
  extractAccountRateLimits,
  extractAccountUsage,
  extractThreadTokenUsage,
  mergeAccountRateLimitUpdate,
} from "./monitoring";

const breakdown = {
  totalTokens: 100,
  inputTokens: 60,
  cachedInputTokens: 20,
  cacheWriteInputTokens: 5,
  outputTokens: 40,
  reasoningOutputTokens: 10,
};

describe("monitoring protocol normalization", () => {
  it("normalizes bounded thread token usage", () => {
    expect(extractThreadTokenUsage({
      tokenUsage: { total: breakdown, last: { ...breakdown, totalTokens: 20 }, modelContextWindow: 200_000 },
    })).toEqual({
      total: breakdown,
      last: { ...breakdown, totalTokens: 20 },
      modelContextWindow: 200_000,
    });
    expect(extractThreadTokenUsage({
      total: { ...breakdown, inputTokens: -1 },
      last: breakdown,
      modelContextWindow: 200_000,
    })).toBeNull();
  });

  it("normalizes nullable account usage and rejects malformed buckets", () => {
    expect(extractAccountUsage({
      summary: {
        lifetimeTokens: 1_000,
        peakDailyTokens: null,
        longestRunningTurnSec: 45,
        currentStreakDays: 3,
        longestStreakDays: 8,
      },
      dailyUsageBuckets: [{ startDate: "2026-08-01", tokens: 120 }],
    })).toEqual(expect.objectContaining({
      summary: expect.objectContaining({ lifetimeTokens: 1_000, peakDailyTokens: null }),
      dailyUsageBuckets: [{ startDate: "2026-08-01", tokens: 120 }],
    }));
    expect(extractAccountUsage({ summary: {}, dailyUsageBuckets: "invalid" })).toBeNull();
  });

  it("merges sparse rate-limit notifications without clearing account metadata", () => {
    const snapshot = extractAccountRateLimits({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: null,
        credits: { hasCredits: true, unlimited: false, balance: "12.50" },
        spendControlReached: false,
        planType: "plus",
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
    });
    const merged = mergeAccountRateLimitUpdate(snapshot, {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 31, resetsAt: 1_800_000_100 },
        credits: { hasCredits: true, unlimited: false, balance: null },
        planType: null,
      },
    });
    expect(merged?.rateLimits).toEqual(expect.objectContaining({
      limitName: "Codex",
      planType: "plus",
      credits: expect.objectContaining({ balance: "12.50" }),
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1_800_000_100 },
    }));
  });

  it("retains a legacy bucket when a rolling update introduces another limit id", () => {
    const snapshot = extractAccountRateLimits({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: null },
        credits: { hasCredits: true, unlimited: false, balance: "12.50" },
        planType: "plus",
      },
      rateLimitsByLimitId: null,
    });
    const merged = mergeAccountRateLimitUpdate(snapshot, {
      rateLimits: {
        limitId: "reviews",
        limitName: "Reviews",
        primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: null },
      },
    });

    expect(Object.keys(merged?.rateLimitsByLimitId ?? {})).toEqual(["codex", "reviews"]);
    expect(merged?.rateLimits?.limitId).toBe("codex");
    expect(merged?.rateLimitsByLimitId?.reviews).toEqual({
      limitId: "reviews",
      limitName: "Reviews",
      primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: null },
      secondary: null,
      credits: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    });
  });

  it("bounds rolling rate-limit buckets while preserving the primary and newest entries", () => {
    let snapshot = extractAccountRateLimits({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null },
      },
      rateLimitsByLimitId: null,
    });
    for (let index = 0; index < 33; index += 1) {
      snapshot = mergeAccountRateLimitUpdate(snapshot, {
        rateLimits: {
          limitId: `limit-${index}`,
          primary: { usedPercent: index, windowDurationMins: 60, resetsAt: null },
        },
      });
    }

    expect(Object.keys(snapshot?.rateLimitsByLimitId ?? {})).toHaveLength(32);
    expect(snapshot?.rateLimitsByLimitId).toHaveProperty("codex");
    expect(snapshot?.rateLimitsByLimitId).toHaveProperty("limit-32");
    expect(snapshot?.rateLimitsByLimitId).not.toHaveProperty("limit-0");
    expect(snapshot?.rateLimitsByLimitId).not.toHaveProperty("limit-1");
  });
});

describe("activity monitoring", () => {
  it("prioritizes active flags over the generic running state", () => {
    expect(activityKindForThread({
      id: "thread-1",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    })).toBe("waitingApproval");
    expect(activityKindForThread({
      id: "thread-2",
      status: { type: "active", activeFlags: ["waitingOnUserInput"] },
    })).toBe("waitingInput");
    expect(activityKindForThread({ id: "thread-3", status: { type: "idle" } })).toBeNull();
  });

  it("records turn completion without retaining turn contents", () => {
    expect(activityEventFromNotification({
      type: "notification",
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "failed",
          completedAt: 1_800_000_000,
          durationMs: 1_500,
          items: [{ id: "secret-output" }],
        },
      },
    }, 0)).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "failed",
      occurredAt: 1_800_000_000_000,
      durationMs: 1_500,
    });
  });

  it("uses inactive thread snapshots without replacing a terminal turn event", () => {
    expect(activityEventFromNotification({
      type: "notification",
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "idle" } },
    }, 1_800_000_100_000)).toBeNull();
  });
});
