import { describe, expect, it } from "vitest";
import { appReducer, initialState, type AppState } from "./appReducer";

function stateWithTurn(): AppState {
  return {
    ...initialState,
    selectedThreadId: "thread-1",
    currentThread: {
      id: "thread-1",
      turns: [{ id: "turn-1", status: "inProgress", items: [] }],
    },
  };
}

describe("appReducer", () => {
  it("hydrates a thread and tracks its active turn", () => {
    const state = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        name: "Refactor parser",
        turns: [{ id: "turn-1", status: "inProgress", items: [] }],
      },
    });

    expect(state.selectedThreadId).toBe("thread-1");
    expect(state.activeTurnId).toBe("turn-1");
    expect(state.threads[0]?.name).toBe("Refactor parser");
  });

  it("stores the history cursor when hydrating a recent turn page", () => {
    const state = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [
          { id: "turn-2", status: "completed", items: [] },
          { id: "turn-2", status: "completed", items: [] },
        ],
      },
      history: { nextCursor: "older-page" },
    });

    expect(state.turnHistory).toEqual({
      threadId: "thread-1",
      nextCursor: "older-page",
      loadingCursor: null,
      status: "idle",
      error: null,
    });
    expect(state.currentThread?.turns?.map((turn) => turn.id)).toEqual(["turn-2"]);
    expect(state.threads[0]?.turns).toBeUndefined();
  });

  it("prepends older turns in order without replacing live duplicates", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [
          { id: "turn-2", status: "inProgress", items: [{ id: "live", type: "agentMessage", text: "live" }] },
          { id: "turn-3", status: "completed", items: [] },
        ],
      },
      history: { nextCursor: "page-2" },
    });
    const loading = appReducer(hydrated, {
      type: "loadOlderTurnsStarted",
      threadId: "thread-1",
      cursor: "page-2",
    });
    const loaded = appReducer(loading, {
      type: "prependOlderTurns",
      threadId: "thread-1",
      cursor: "page-2",
      turns: [
        { id: "turn-1", status: "completed", items: [] },
        { id: "turn-2", status: "completed", items: [] },
        { id: "turn-1", status: "completed", items: [] },
      ],
      nextCursor: null,
    });

    expect(loaded.currentThread?.turns?.map((turn) => turn.id)).toEqual(["turn-1", "turn-2", "turn-3"]);
    expect(loaded.currentThread?.turns?.[1]?.items[0]).toEqual(expect.objectContaining({ text: "live" }));
    expect(loaded.turnHistory).toEqual(expect.objectContaining({
      nextCursor: null,
      loadingCursor: null,
      status: "idle",
      error: null,
    }));
  });

  it("does not let metadata notifications erase loaded turn history", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: { id: "thread-1", turns: [{ id: "turn-1", items: [] }] },
      history: { nextCursor: null },
    });
    const updated = appReducer(hydrated, {
      type: "upsertThread",
      thread: { id: "thread-1", name: "Renamed", turns: [] },
    });

    expect(updated.currentThread?.name).toBe("Renamed");
    expect(updated.currentThread?.turns?.map((turn) => turn.id)).toEqual(["turn-1"]);
  });

  it("reconciles a full snapshot without losing older history or approvals", () => {
    const hydrated = appReducer({
      ...initialState,
      pendingRequests: [{ id: 7, method: "approval", params: {}, receivedAt: 1 }],
    }, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [
          { id: "turn-old", status: "completed", items: [{ id: "old", type: "agentMessage" }] },
          {
            id: "turn-active",
            status: "inProgress",
            items: [{ id: "partial", type: "agentMessage" }],
            diff: "live diff",
            plan: { plan: [{ step: "Keep this plan", status: "in_progress" }] },
          },
        ],
      },
      history: { nextCursor: "older-page" },
    });
    const reconciled = appReducer(hydrated, {
      type: "reconcileCurrentThread",
      thread: {
        id: "thread-1",
        name: "Recovered",
        turns: [{
          id: "turn-active",
          status: "completed",
          itemsView: "full",
          items: [{ id: "complete", type: "agentMessage", text: "Done" }],
        }],
      },
    });

    expect(reconciled.currentThread?.turns?.map((turn) => turn.id))
      .toEqual(["turn-old", "turn-active"]);
    expect(reconciled.currentThread?.turns?.[1]?.items[0]?.id).toBe("complete");
    expect(reconciled.currentThread?.turns?.[1]?.diff).toBe("live diff");
    expect(reconciled.currentThread?.turns?.[1]?.plan).toEqual({
      plan: [{ step: "Keep this plan", status: "in_progress" }],
    });
    expect(reconciled.currentThread?.name).toBe("Recovered");
    expect(reconciled.activeTurnId).toBeNull();
    expect(reconciled.turnHistory.nextCursor).toBe("older-page");
    expect(reconciled.pendingRequests).toEqual(hydrated.pendingRequests);
  });

  it("uses summary state without replacing full items or uncovered live turns", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [
          {
            id: "turn-1",
            status: "inProgress",
            itemsView: "full",
            items: [{ id: "full-item", type: "commandExecution", aggregatedOutput: "visible" }],
          },
          { id: "turn-live", status: "inProgress", items: [] },
        ],
      },
      history: { nextCursor: null },
    });
    const reconciled = appReducer(hydrated, {
      type: "reconcileCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "completed",
          itemsView: "summary",
          items: [],
          historyDetail: { cursor: null, status: "idle", error: null },
        }],
      },
    });

    expect(reconciled.currentThread?.turns?.[0]).toEqual(expect.objectContaining({
      status: "completed",
      itemsView: "full",
      items: [expect.objectContaining({ id: "full-item", aggregatedOutput: "visible" })],
    }));
    expect(reconciled.currentThread?.turns?.[0]?.historyDetail).toBeUndefined();
    expect(reconciled.currentThread?.turns?.[1]?.id).toBe("turn-live");
    expect(reconciled.activeTurnId).toBe("turn-live");
  });

  it("keeps summary retry metadata when a resync cannot replace streamed partial items", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          items: [{ id: "partial-item", type: "commandExecution", aggregatedOutput: "partial" }],
        }],
      },
    });
    const reconciled = appReducer(hydrated, {
      type: "reconcileCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "completed",
          itemsView: "summary",
          items: [],
          historyDetail: { cursor: null, status: "idle", error: null },
        }],
      },
    });

    expect(reconciled.currentThread?.turns?.[0]).toEqual(expect.objectContaining({
      status: "completed",
      itemsView: "summary",
      items: [expect.objectContaining({ id: "partial-item", aggregatedOutput: "partial" })],
      historyDetail: { cursor: null, status: "idle", error: null },
    }));
  });

  it("treats a legacy snapshot without itemsView as a conservative summary", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          items: [{ id: "partial-item", type: "agentMessage", text: "streamed" }],
        }],
      },
    });
    const reconciled = appReducer(hydrated, {
      type: "reconcileCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      },
    });

    expect(reconciled.currentThread?.turns?.[0]).toEqual(expect.objectContaining({
      status: "completed",
      items: [expect.objectContaining({ id: "partial-item", text: "streamed" })],
    }));
  });

  it("records unrecoverable oversized turn projections until a newer update arrives", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: { id: "thread-1", turns: [{ id: "turn-1", items: [] }] },
    });
    const omitted = appReducer(hydrated, {
      type: "recordTurnRecoveryOmission",
      threadId: "thread-1",
      turnId: "turn-1",
      method: "turn/diff/updated",
    });
    const repeated = appReducer(omitted, {
      type: "recordTurnRecoveryOmission",
      threadId: "thread-1",
      turnId: "turn-1",
      method: "turn/diff/updated",
    });
    const restored = appReducer(repeated, {
      type: "setTurnDiff",
      turnId: "turn-1",
      diff: "new diff",
    });

    expect(repeated.currentThread?.turns?.[0]?.recoveryOmissions).toEqual(["turn/diff/updated"]);
    expect(restored.currentThread?.turns?.[0]?.recoveryOmissions).toEqual([]);
    expect(restored.currentThread?.turns?.[0]?.diff).toBe("new diff");
  });

  it("ignores a resync snapshot for a superseded selection", () => {
    const selected = appReducer(initialState, {
      type: "setCurrentThread",
      thread: { id: "thread-2", turns: [] },
    });
    const stale = appReducer(selected, {
      type: "reconcileCurrentThread",
      thread: { id: "thread-1", turns: [{ id: "stale", items: [] }] },
    });

    expect(stale).toBe(selected);
  });

  it("applies buffered live notifications after the resync snapshot baseline", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          items: [{ id: "message-1", type: "agentMessage", text: "old" }],
        }],
      },
    });
    const snapshot = appReducer(hydrated, {
      type: "reconcileCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          itemsView: "full",
          items: [{ id: "message-1", type: "agentMessage", text: "snapshot" }],
        }],
      },
    });
    const replayed = appReducer(snapshot, {
      type: "appendItemDelta",
      turnId: "turn-1",
      itemId: "message-1",
      field: "text",
      delta: " tail",
    });
    const completed = appReducer(replayed, {
      type: "setTurnStatus",
      turnId: "turn-1",
      status: "completed",
    });

    expect(completed.currentThread?.turns?.[0]?.items[0]?.text).toBe("snapshot tail");
    expect(completed.activeTurnId).toBeNull();
  });

  it("keeps a failed page cursor available for retry", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: { id: "thread-1", turns: [] },
      history: { nextCursor: "retry-page" },
    });
    const loading = appReducer(hydrated, {
      type: "loadOlderTurnsStarted",
      threadId: "thread-1",
      cursor: "retry-page",
    });
    const failed = appReducer(loading, {
      type: "loadOlderTurnsFailed",
      threadId: "thread-1",
      cursor: "retry-page",
      error: "connection closed",
    });
    const retrying = appReducer(failed, {
      type: "loadOlderTurnsStarted",
      threadId: "thread-1",
      cursor: "retry-page",
    });

    expect(failed.turnHistory).toEqual(expect.objectContaining({
      nextCursor: "retry-page",
      loadingCursor: null,
      status: "error",
      error: "connection closed",
    }));
    expect(retrying.turnHistory).toEqual(expect.objectContaining({
      nextCursor: "retry-page",
      loadingCursor: "retry-page",
      status: "loading",
      error: null,
    }));

    const reselected = appReducer(failed, { type: "selectThread", threadId: "thread-1" });
    expect(reselected.turnHistory).toEqual(expect.objectContaining({
      nextCursor: "retry-page",
      loadingCursor: null,
      status: "idle",
      error: null,
    }));
  });

  it("ignores a page response after selecting another thread", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: { id: "thread-1", turns: [{ id: "turn-2", items: [] }] },
      history: { nextCursor: "page-2" },
    });
    const loading = appReducer(hydrated, {
      type: "loadOlderTurnsStarted",
      threadId: "thread-1",
      cursor: "page-2",
    });
    const switched = appReducer(loading, { type: "selectThread", threadId: "thread-2" });
    const stale = appReducer(switched, {
      type: "prependOlderTurns",
      threadId: "thread-1",
      cursor: "page-2",
      turns: [{ id: "turn-1", items: [] }],
      nextCursor: null,
    });

    expect(stale).toBe(switched);
    expect(stale.selectedThreadId).toBe("thread-2");
  });

  it("creates a streaming item when a delta arrives before item/started", () => {
    const first = appReducer(stateWithTurn(), {
      type: "appendItemDelta",
      turnId: "turn-1",
      itemId: "item-1",
      itemType: "agentMessage",
      field: "text",
      delta: "Hello",
    });
    const second = appReducer(first, {
      type: "appendItemDelta",
      turnId: "turn-1",
      itemId: "item-1",
      itemType: "agentMessage",
      field: "text",
      delta: " world",
    });

    expect(second.currentThread?.turns?.[0]?.items).toEqual([
      expect.objectContaining({ id: "item-1", type: "agentMessage", text: "Hello world" }),
    ]);
  });

  it("bounds continuously streamed text and records omitted characters", () => {
    const first = appReducer(stateWithTurn(), {
      type: "appendItemDelta",
      turnId: "turn-1",
      itemId: "command-large",
      itemType: "commandExecution",
      field: "aggregatedOutput",
      delta: "a".repeat(250_000),
    });
    const second = appReducer(first, {
      type: "appendItemDelta",
      turnId: "turn-1",
      itemId: "command-large",
      field: "aggregatedOutput",
      delta: "b".repeat(250_000),
    });
    const item = second.currentThread?.turns?.[0]?.items[0];

    expect(item?.aggregatedOutput).toHaveLength(300_000);
    expect(item?.aggregatedOutput).toMatch(/^a+/);
    expect(item?.aggregatedOutput).toMatch(/b+$/);
    expect(item?.streamOmittedCharacters).toEqual({ aggregatedOutput: 200_000 });
  });

  it("bounds indexed reasoning parts and clears truncation when full content arrives", () => {
    const first = appReducer(stateWithTurn(), {
      type: "appendIndexedItemDelta",
      turnId: "turn-1",
      itemId: "reasoning-large",
      itemType: "reasoning",
      field: "summary",
      index: 0,
      delta: "a".repeat(80_000),
    });
    const second = appReducer(first, {
      type: "appendIndexedItemDelta",
      turnId: "turn-1",
      itemId: "reasoning-large",
      field: "summary",
      index: 0,
      delta: "b".repeat(80_000),
    });
    const streamed = second.currentThread?.turns?.[0]?.items[0];

    expect((streamed?.summary as string[])[0]).toHaveLength(100_000);
    expect(streamed?.streamOmittedCharacters).toEqual({ "summary[0]": 60_000 });

    const restored = appReducer(second, {
      type: "upsertItem",
      turnId: "turn-1",
      item: { id: "reasoning-large", type: "reasoning", summary: ["complete"] },
      lifecycle: "completed",
    });
    expect(restored.currentThread?.turns?.[0]?.items[0]?.streamOmittedCharacters).toBeUndefined();
  });

  it("merges completed item data without duplicating its streamed item", () => {
    const streaming = appReducer(stateWithTurn(), {
      type: "upsertItem",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", status: "inProgress", aggregatedOutput: "one" },
      lifecycle: "started",
    });
    const completed = appReducer(streaming, {
      type: "upsertItem",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", status: "completed", exitCode: 0 },
      lifecycle: "completed",
    });

    expect(completed.currentThread?.turns?.[0]?.items).toHaveLength(1);
    expect(completed.currentThread?.turns?.[0]?.items[0]).toEqual(expect.objectContaining({
      aggregatedOutput: "one",
      status: "completed",
      exitCode: 0,
    }));
  });

  it("keeps streamed content and omissions when item/started arrives late", () => {
    const streamed = appReducer(stateWithTurn(), {
      type: "appendItemDelta",
      turnId: "turn-1",
      itemId: "command-late",
      itemType: "commandExecution",
      field: "aggregatedOutput",
      delta: "x".repeat(350_000),
    });
    const started = appReducer(streamed, {
      type: "upsertItem",
      turnId: "turn-1",
      item: {
        id: "command-late",
        type: "commandExecution",
        status: "inProgress",
        command: "npm test",
        aggregatedOutput: null,
      },
      lifecycle: "started",
    });
    const item = started.currentThread?.turns?.[0]?.items[0];

    expect(item?.command).toBe("npm test");
    expect(item?.aggregatedOutput).toHaveLength(300_000);
    expect(item?.streamOmittedCharacters).toEqual({ aggregatedOutput: 50_000 });
  });

  it("records out-of-range reasoning deltas as omitted instead of merging index zero", () => {
    const visible = appReducer(stateWithTurn(), {
      type: "appendIndexedItemDelta",
      turnId: "turn-1",
      itemId: "reasoning-overflow",
      itemType: "reasoning",
      field: "summary",
      index: 0,
      delta: "Visible",
    });
    const omitted = appReducer(visible, {
      type: "recordIndexedItemOmission",
      turnId: "turn-1",
      itemId: "reasoning-overflow",
      field: "summary",
      omitted: 12,
    });
    const repeated = appReducer(omitted, {
      type: "recordIndexedItemOmission",
      turnId: "turn-1",
      itemId: "reasoning-overflow",
      field: "summary",
      omitted: 8,
    });
    const item = repeated.currentThread?.turns?.[0]?.items[0];

    expect(item?.summary).toEqual(["Visible"]);
    expect(item?.streamOmittedCharacters).toEqual({ "summary[overflow]": 20 });

    const completed = appReducer(repeated, {
      type: "upsertItem",
      turnId: "turn-1",
      item: { id: "reasoning-overflow", type: "reasoning", summary: ["Complete"] },
      lifecycle: "completed",
    });
    expect(completed.currentThread?.turns?.[0]?.items[0]?.streamOmittedCharacters).toBeUndefined();
  });

  it("keeps summary turns retryable and replaces them with full detail", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-large",
          items: [],
          itemsView: "summary",
          historyDetail: { cursor: "page-large", status: "idle", error: null },
        }],
      },
      history: { nextCursor: "older" },
    });
    const loading = appReducer(hydrated, {
      type: "loadTurnDetailStarted",
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "page-large",
    });
    const reselected = appReducer(loading, { type: "selectThread", threadId: "thread-1" });
    const failed = appReducer(loading, {
      type: "loadTurnDetailFailed",
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "page-large",
      error: "still too large",
    });
    const retrying = appReducer(failed, {
      type: "loadTurnDetailStarted",
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "page-large",
    });
    const loaded = appReducer(retrying, {
      type: "loadTurnDetailSucceeded",
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "page-large",
      turn: {
        id: "turn-large",
        itemsView: "full",
        items: [{ id: "message", type: "agentMessage", text: "Full detail" }],
      },
    });

    expect(failed.currentThread?.turns?.[0]?.historyDetail).toEqual(expect.objectContaining({
      status: "error",
      error: "still too large",
    }));
    expect(reselected.currentThread?.turns?.[0]?.historyDetail).toEqual(expect.objectContaining({
      status: "idle",
      error: null,
    }));
    expect(loaded.currentThread?.turns?.[0]).toEqual(expect.objectContaining({
      itemsView: "full",
      items: [expect.objectContaining({ text: "Full detail" })],
    }));
    expect(loaded.currentThread?.turns?.[0]?.historyDetail).toBeUndefined();
  });

  it("keeps indexed reasoning parts separate while streaming", () => {
    const first = appReducer(stateWithTurn(), {
      type: "appendIndexedItemDelta",
      turnId: "turn-1",
      itemId: "reasoning-1",
      itemType: "reasoning",
      field: "summary",
      index: 1,
      delta: "Second",
    });
    const second = appReducer(first, {
      type: "appendIndexedItemDelta",
      turnId: "turn-1",
      itemId: "reasoning-1",
      field: "summary",
      index: 0,
      delta: "First",
    });

    expect(second.currentThread?.turns?.[0]?.items[0]?.summary).toEqual(["First", "Second"]);
  });

  it("only applies runtime settings to the selected thread", () => {
    const selected = { ...initialState, selectedThreadId: "thread-1" };
    const ignored = appReducer(selected, {
      type: "threadSettings",
      threadId: "thread-2",
      settings: { effort: "high" },
    });
    const applied = appReducer(ignored, {
      type: "threadSettings",
      threadId: "thread-1",
      settings: { effort: "low", sandbox: "external" },
    });

    expect(ignored.settings.effort).toBe("");
    expect(applied.settings).toEqual(expect.objectContaining({ effort: "low", sandbox: "external" }));
  });

  it("stores plan and diff updates on the matching turn", () => {
    const planned = appReducer(stateWithTurn(), {
      type: "setTurnPlan",
      turnId: "turn-1",
      plan: { plan: [{ step: "Run tests", status: "in_progress" }] },
    });
    const diffed = appReducer(planned, {
      type: "setTurnDiff",
      turnId: "turn-1",
      diff: "+const fixed = true;",
    });

    expect(diffed.currentThread?.turns?.[0]?.plan?.plan[0]?.step).toBe("Run tests");
    expect(diffed.currentThread?.turns?.[0]?.diff).toContain("fixed");
  });

  it("clears the active turn when turn/completed carries a full turn", () => {
    const completed = appReducer({ ...stateWithTurn(), activeTurnId: "turn-1" }, {
      type: "upsertTurn",
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    });

    expect(completed.activeTurnId).toBeNull();
    expect(completed.currentThread?.turns?.[0]?.status).toBe("completed");
  });

  it("sorts Unix-second and millisecond thread timestamps consistently", () => {
    const state = appReducer(initialState, {
      type: "setThreads",
      threads: [
        { id: "milliseconds", updatedAt: 1_700_000_000_000 },
        { id: "seconds", updatedAt: 1_800_000_000 },
      ],
    });

    expect(state.threads.map((thread) => thread.id)).toEqual(["seconds", "milliseconds"]);
  });

  it("clears stale approval requests after an app-server failure", () => {
    const state = appReducer({
      ...initialState,
      pendingRequests: [{ id: 1, method: "approval", params: {}, receivedAt: 1 }],
    }, { type: "clearRequests" });

    expect(state.pendingRequests).toEqual([]);
  });
});
