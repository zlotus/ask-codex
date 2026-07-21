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

  it("merges completed item data without duplicating its streamed item", () => {
    const streaming = appReducer(stateWithTurn(), {
      type: "upsertItem",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", status: "inProgress", aggregatedOutput: "one" },
    });
    const completed = appReducer(streaming, {
      type: "upsertItem",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", status: "completed", exitCode: 0 },
    });

    expect(completed.currentThread?.turns?.[0]?.items).toHaveLength(1);
    expect(completed.currentThread?.turns?.[0]?.items[0]).toEqual(expect.objectContaining({
      aggregatedOutput: "one",
      status: "completed",
      exitCode: 0,
    }));
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
