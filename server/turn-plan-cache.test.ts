// @vitest-environment node

import { describe, expect, it } from "vitest";

import { TurnPlanCache, type TurnPlanTiming } from "./turn-plan-cache.js";

const BASE_TIMING: TurnPlanTiming = {
  emittedAtMs: 900,
  gatewayReceivedAtMs: 1_000,
};

function observePlan(
  cache: TurnPlanCache,
  threadId: string,
  turnId: string,
  plan: unknown[],
  options: {
    explanation?: unknown;
    timing?: TurnPlanTiming;
    extra?: Record<string, unknown>;
  } = {},
): ReturnType<TurnPlanCache["observeNotification"]> {
  return cache.observeNotification("turn/plan/updated", {
    threadId,
    turnId,
    ...(options.explanation === undefined ? {} : { explanation: options.explanation }),
    plan,
    ...options.extra,
  }, options.timing ?? BASE_TIMING);
}

function decorateListedTurn(
  cache: TurnPlanCache,
  threadId: string,
  turnId: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  const turn: Record<string, unknown> = { id: turnId, items: [], ...fields };
  cache.decorateRpcResult("thread/turns/list", { threadId }, { data: [turn] });
  return turn;
}

describe("TurnPlanCache", () => {
  it("uses the last complete snapshot, preserves empty plans, and returns defensive clones", () => {
    const cache = new TurnPlanCache();
    observePlan(cache, "thread-1", "turn-1", [
      { step: "Inspect", status: "inProgress" },
      { step: "Verify", status: "pending" },
    ], {
      explanation: "Initial approach",
      timing: { emittedAtMs: 100, gatewayReceivedAtMs: 110 },
    });
    observePlan(cache, "thread-1", "turn-1", [], {
      explanation: "No remaining work",
      timing: { emittedAtMs: 200, gatewayReceivedAtMs: 210 },
    });

    const first = decorateListedTurn(cache, "thread-1", "turn-1");
    expect(first.plan).toEqual({
      explanation: "No remaining work",
      plan: [],
      emittedAtMs: 200,
      gatewayReceivedAtMs: 210,
    });

    const firstPlan = first.plan as { explanation: string; plan: unknown[] };
    firstPlan.explanation = "mutated by a caller";
    firstPlan.plan.push({ step: "Injected", status: "completed" });

    const second = decorateListedTurn(cache, "thread-1", "turn-1");
    expect(second.plan).toEqual({
      explanation: "No remaining work",
      plan: [],
      emittedAtMs: 200,
      gatewayReceivedAtMs: 210,
    });
  });

  it("rebuilds only documented fields and accepts only protocol plan statuses", () => {
    const cache = new TurnPlanCache();
    const observation = observePlan(cache, "thread-strict", "turn-strict", [
      { step: "Queued", status: "pending", private: "discard" },
      { step: "Running", status: "inProgress", nested: { discard: true } },
      { step: "Done", status: "completed", output: "discard" },
    ], {
      explanation: "Bounded projection",
      extra: { private: "discard", unknown: { secret: true } },
    });

    expect(decorateListedTurn(cache, "thread-strict", "turn-strict").plan).toEqual({
      explanation: "Bounded projection",
      plan: [
        { step: "Queued", status: "pending" },
        { step: "Running", status: "inProgress" },
        { step: "Done", status: "completed" },
      ],
      emittedAtMs: 900,
      gatewayReceivedAtMs: 1_000,
    });
    expect(observation).toEqual({
      projectedParams: {
        threadId: "thread-strict",
        turnId: "turn-strict",
        explanation: "Bounded projection",
        plan: [
          { step: "Queued", status: "pending" },
          { step: "Running", status: "inProgress" },
          { step: "Done", status: "completed" },
        ],
      },
      recoveryRequired: false,
    });

    const invalid = observePlan(cache, "thread-strict", "turn-strict", [
      { step: "Legacy spelling", status: "in_progress" },
    ]);
    expect(invalid).toMatchObject({
      recoveryRequired: true,
      threadId: "thread-strict",
      turnId: "turn-strict",
    });
    expect(decorateListedTurn(cache, "thread-strict", "turn-strict")).toMatchObject({
      plan: null,
      recoveryOmissions: ["turn/plan/updated"],
    });

    observePlan(cache, "thread-strict", "turn-strict", [
      { step: "Missing status" },
    ]);
    expect(decorateListedTurn(cache, "thread-strict", "turn-strict")).toMatchObject({
      plan: null,
      recoveryOmissions: ["turn/plan/updated"],
    });
  });

  it("replaces over-limit snapshots with tombstones and clears only the plan omission on recovery", () => {
    const cache = new TurnPlanCache({
      maxSnapshotBytes: 300,
      maxExplanationBytes: 8,
      maxStepBytes: 8,
      maxSteps: 2,
    });
    observePlan(cache, "thread-limits", "turn-limits", [
      { step: "Valid", status: "pending" },
    ]);

    observePlan(cache, "thread-limits", "turn-limits", [
      { step: "123456789", status: "inProgress" },
    ]);
    expect(decorateListedTurn(cache, "thread-limits", "turn-limits", {
      recoveryOmissions: ["turn/diff/updated"],
    })).toMatchObject({
      plan: null,
      recoveryOmissions: ["turn/diff/updated", "turn/plan/updated"],
    });

    observePlan(cache, "thread-limits", "turn-limits", [
      { step: "One", status: "pending" },
      { step: "Two", status: "pending" },
      { step: "Three", status: "pending" },
    ]);
    expect(decorateListedTurn(cache, "thread-limits", "turn-limits")).toMatchObject({
      plan: null,
      recoveryOmissions: ["turn/plan/updated"],
    });

    observePlan(cache, "thread-limits", "turn-limits", [
      { step: "Valid", status: "completed" },
    ], { explanation: "123456789" });
    expect(decorateListedTurn(cache, "thread-limits", "turn-limits").plan).toEqual({
      plan: [{ step: "Valid", status: "completed" }],
      emittedAtMs: 900,
      gatewayReceivedAtMs: 1_000,
    });

    observePlan(cache, "thread-limits", "turn-limits", [
      { step: "12345678", status: "completed" },
      { step: "abcdefgh", status: "completed" },
    ], { explanation: "12345678" });
    expect(decorateListedTurn(cache, "thread-limits", "turn-limits")).toMatchObject({
      plan: null,
      recoveryOmissions: ["turn/plan/updated"],
    });

    observePlan(cache, "thread-limits", "turn-limits", [
      { step: "Fixed", status: "completed" },
    ], { explanation: "Restored" });
    expect(decorateListedTurn(cache, "thread-limits", "turn-limits", {
      recoveryOmissions: ["turn/diff/updated", "turn/plan/updated"],
    })).toMatchObject({
      plan: {
        explanation: "Restored",
        plan: [{ step: "Fixed", status: "completed" }],
      },
      recoveryOmissions: ["turn/diff/updated"],
    });
  });

  it("evicts the least recently updated record when the entry limit is reached", () => {
    const cache = new TurnPlanCache({ maxEntries: 2 });
    observePlan(cache, "thread-entry", "turn-a", [{ step: "A1", status: "pending" }]);
    observePlan(cache, "thread-entry", "turn-b", [{ step: "B", status: "pending" }]);
    observePlan(cache, "thread-entry", "turn-a", [{ step: "A2", status: "inProgress" }]);
    observePlan(cache, "thread-entry", "turn-c", [{ step: "C", status: "completed" }]);

    expect(decorateListedTurn(cache, "thread-entry", "turn-a").plan).toMatchObject({
      plan: [{ step: "A2", status: "inProgress" }],
    });
    expect(decorateListedTurn(cache, "thread-entry", "turn-b")).not.toHaveProperty("plan");
    expect(decorateListedTurn(cache, "thread-entry", "turn-c").plan).toMatchObject({
      plan: [{ step: "C", status: "completed" }],
    });
  });

  it("evicts old records to enforce the aggregate byte limit", () => {
    const cache = new TurnPlanCache({
      maxEntries: 10,
      maxTotalBytes: 500,
      maxSnapshotBytes: 1_000,
      maxStepBytes: 200,
    });
    observePlan(cache, "thread-bytes", "turn-a", [
      { step: "a".repeat(80), status: "pending" },
    ]);
    observePlan(cache, "thread-bytes", "turn-b", [
      { step: "b".repeat(80), status: "completed" },
    ]);

    expect(decorateListedTurn(cache, "thread-bytes", "turn-a")).not.toHaveProperty("plan");
    expect(decorateListedTurn(cache, "thread-bytes", "turn-b").plan).toMatchObject({
      plan: [{ step: "b".repeat(80), status: "completed" }],
    });
  });

  it("rejects invalid limits instead of disabling cache bounds", () => {
    for (const maxEntries of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new TurnPlanCache({ maxEntries })).toThrow(RangeError);
    }
  });

  it("bounds response decoration and does not clone duplicate turn ids", () => {
    const cache = new TurnPlanCache({
      maxDecorationBytes: 1_000,
      maxDecoratedPlans: 1,
    });
    observePlan(cache, "thread-response", "turn-a", [
      { step: "First", status: "inProgress" },
    ]);
    observePlan(cache, "thread-response", "turn-b", [
      { step: "Second", status: "pending" },
    ]);

    const turns: Array<Record<string, unknown>> = [
      { id: "turn-a", items: [] },
      { id: "turn-a", items: [] },
      { id: "turn-b", items: [] },
    ];
    cache.decorateRpcResult("thread/turns/list", { threadId: "thread-response" }, {
      data: turns,
    });

    expect(turns[0]?.plan).toMatchObject({
      plan: [{ step: "First", status: "inProgress" }],
    });
    expect(turns[1]).toMatchObject({
      plan: null,
      recoveryOmissions: ["turn/plan/updated"],
    });
    expect(turns[2]).toMatchObject({
      plan: null,
      recoveryOmissions: ["turn/plan/updated"],
    });
  });

  it("uses the response byte budget even when the plan count budget remains", () => {
    const cache = new TurnPlanCache({
      maxDecorationBytes: 1,
      maxDecoratedPlans: 10,
    });
    observePlan(cache, "thread-budget", "turn-budget", [
      { step: "Bounded", status: "inProgress" },
    ]);

    expect(decorateListedTurn(cache, "thread-budget", "turn-budget")).toMatchObject({
      plan: null,
      recoveryOmissions: ["turn/plan/updated"],
    });
  });

  it("accounts for bounded identifiers when retaining tombstones", () => {
    const cache = new TurnPlanCache({
      maxEntries: 10,
      maxTotalBytes: 300,
      maxSnapshotBytes: 1,
    });
    observePlan(cache, "thread-\"alpha\"", "turn-alpha", [
      { step: "Alpha", status: "pending" },
    ]);
    observePlan(cache, "thread-\"beta\"", "turn-beta", [
      { step: "Beta", status: "pending" },
    ]);

    expect(decorateListedTurn(cache, "thread-\"alpha\"", "turn-alpha"))
      .not.toHaveProperty("plan");
    expect(decorateListedTurn(cache, "thread-\"beta\"", "turn-beta"))
      .toMatchObject({ plan: null, recoveryOmissions: ["turn/plan/updated"] });
  });

  it("keeps identical turn ids isolated by thread and clears only deleted threads", () => {
    const cache = new TurnPlanCache();
    observePlan(cache, "thread-a", "turn-shared", [{ step: "Plan A", status: "pending" }]);
    observePlan(cache, "thread-b", "turn-shared", [{ step: "Plan B", status: "completed" }]);

    expect(decorateListedTurn(cache, "thread-a", "turn-shared").plan).toMatchObject({
      plan: [{ step: "Plan A", status: "pending" }],
    });
    expect(decorateListedTurn(cache, "thread-b", "turn-shared").plan).toMatchObject({
      plan: [{ step: "Plan B", status: "completed" }],
    });

    cache.observeNotification("thread/deleted", { threadId: "thread-a" }, BASE_TIMING);
    expect(decorateListedTurn(cache, "thread-a", "turn-shared")).not.toHaveProperty("plan");
    expect(decorateListedTurn(cache, "thread-b", "turn-shared").plan).not.toBeNull();

    cache.observeRpcResult("thread/delete", { threadId: "thread-b" });
    expect(decorateListedTurn(cache, "thread-b", "turn-shared")).not.toHaveProperty("plan");
  });

  it("copies bounded source snapshots to a structurally linked fork", () => {
    const cache = new TurnPlanCache();
    observePlan(cache, "thread-source", "turn-cached", [
      { step: "Keep structured history", status: "completed" },
    ]);
    cache.observeNotification("turn/plan/updated", {
      threadId: "thread-source",
      turnId: "turn-unavailable",
      plan: "invalid",
    }, BASE_TIMING);

    cache.observeRpcResult(
      "thread/fork",
      { threadId: "thread-source" },
      { thread: { id: "thread-forked", forkedFromId: "thread-source" } },
    );

    expect(decorateListedTurn(cache, "thread-forked", "turn-cached").plan)
      .toMatchObject({
        plan: [{ step: "Keep structured history", status: "completed" }],
      });
    expect(decorateListedTurn(cache, "thread-forked", "turn-unavailable"))
      .toMatchObject({ plan: null, recoveryOmissions: ["turn/plan/updated"] });
    expect(decorateListedTurn(cache, "thread-source", "turn-cached").plan)
      .not.toBeNull();

    cache.observeRpcResult(
      "thread/fork",
      { threadId: "thread-source" },
      { thread: { id: "thread-unlinked", forkedFromId: "thread-other" } },
    );
    expect(decorateListedTurn(cache, "thread-unlinked", "turn-cached"))
      .not.toHaveProperty("plan");
  });

  it("decorates turn pages, reads, resumes, initial pages, and turn starts within request scope", () => {
    const cache = new TurnPlanCache();
    observePlan(cache, "thread-rpc", "turn-cached", [
      { step: "Restore", status: "inProgress" },
    ]);

    const listedCached: Record<string, unknown> = { id: "turn-cached", items: [] };
    const listedMissing: Record<string, unknown> = { id: "turn-missing", items: [] };
    cache.decorateRpcResult("thread/turns/list", { threadId: "thread-rpc" }, {
      data: [listedCached, listedMissing],
    });
    expect(listedCached.plan).toMatchObject({ plan: [{ step: "Restore", status: "inProgress" }] });
    expect(listedMissing).not.toHaveProperty("plan");

    const readTurn: Record<string, unknown> = { id: "turn-cached", items: [] };
    cache.decorateRpcResult("thread/read", { threadId: "thread-rpc" }, {
      thread: { id: "thread-rpc", turns: [readTurn] },
    });
    expect(readTurn.plan).toMatchObject({ plan: [{ step: "Restore", status: "inProgress" }] });

    const directReadTurn: Record<string, unknown> = { id: "turn-cached", items: [] };
    cache.decorateRpcResult("thread/read", { threadId: "thread-rpc" }, {
      id: "thread-rpc",
      turns: [directReadTurn],
    });
    expect(directReadTurn.plan).not.toBeNull();

    const resumedTurn: Record<string, unknown> = { id: "turn-cached", items: [] };
    const initialTurn: Record<string, unknown> = { id: "turn-cached", items: [] };
    cache.decorateRpcResult("thread/resume", { threadId: "thread-rpc" }, {
      thread: { id: "thread-rpc", turns: [resumedTurn] },
      initialTurnsPage: { data: [initialTurn] },
    });
    expect(resumedTurn.plan).not.toBeNull();
    expect(initialTurn.plan).not.toBeNull();

    const startedTurn: Record<string, unknown> = { id: "turn-cached", items: [] };
    cache.decorateRpcResult("turn/start", { threadId: "thread-rpc" }, { turn: startedTurn });
    expect(startedTurn.plan).not.toBeNull();

    const mismatchedTurn: Record<string, unknown> = { id: "turn-cached", items: [] };
    cache.decorateRpcResult("thread/read", { threadId: "thread-rpc" }, {
      thread: { id: "different-thread", turns: [mismatchedTurn] },
    });
    expect(mismatchedTurn).not.toHaveProperty("plan");
  });

  it("decorates started and completed notifications without touching unrelated notifications", () => {
    const cache = new TurnPlanCache();
    observePlan(cache, "thread-events", "turn-events", [
      { step: "Handle lifecycle", status: "completed" },
    ]);

    for (const method of ["turn/started", "turn/completed"]) {
      const turn: Record<string, unknown> = { id: "turn-events", items: [] };
      const params = { threadId: "thread-events", turn };
      expect(cache.decorateNotification(method, params)).toBe(params);
      expect(turn.plan).toMatchObject({
        plan: [{ step: "Handle lifecycle", status: "completed" }],
      });
    }

    const unrelatedTurn: Record<string, unknown> = { id: "turn-events", items: [] };
    const unrelated = { threadId: "thread-events", turn: unrelatedTurn };
    expect(cache.decorateNotification("turn/status/changed", unrelated)).toBe(unrelated);
    expect(unrelatedTurn).not.toHaveProperty("plan");

    const wrongThreadTurn: Record<string, unknown> = { id: "turn-events", items: [] };
    cache.decorateNotification("turn/completed", {
      threadId: "thread-other",
      turn: wrongThreadTurn,
    });
    expect(wrongThreadTurn).not.toHaveProperty("plan");
  });

  it("never overwrites an upstream own plan value", () => {
    const cache = new TurnPlanCache();
    observePlan(cache, "thread-native", "turn-native", [
      { step: "Cached", status: "pending" },
    ]);

    const nativePlan = {
      explanation: "Upstream",
      plan: [{ step: "Native", status: "completed" }],
    };
    const native = decorateListedTurn(cache, "thread-native", "turn-native", {
      plan: nativePlan,
      recoveryOmissions: ["turn/plan/updated"],
    });
    expect(native.plan).toBe(nativePlan);
    expect(native.recoveryOmissions).toEqual(["turn/plan/updated"]);

    const nativeNull = decorateListedTurn(cache, "thread-native", "turn-native", { plan: null });
    expect(nativeNull.plan).toBeNull();
  });
});
