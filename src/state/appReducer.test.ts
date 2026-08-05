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

  it("preserves only explicitly protected threads across a canonical list omission", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-new",
        createdAt: 1_800_000_000,
        updatedAt: 1_800_000_000,
        recencyAt: 1_800_000_000,
        turns: [],
      },
    });
    const protectedState = appReducer(hydrated, {
      type: "setThreads",
      threads: [{ id: "thread-existing", name: "Existing", updatedAt: 1_700_000_000 }],
      protectedThreadIds: ["thread-new"],
    });

    expect(protectedState.threads.map((thread) => thread.id)).toEqual([
      "thread-new",
      "thread-existing",
    ]);
    expect(protectedState.threads[0]).toEqual(expect.objectContaining({
      createdAt: 1_800_000_000,
      recencyAt: 1_800_000_000,
    }));

    const canonical = appReducer(protectedState, {
      type: "setThreads",
      threads: [{
        id: "thread-new",
        preview: "First request",
        createdAt: 1_800_000_000,
        updatedAt: 1_800_000_010,
        recencyAt: 1_800_000_010,
      }],
    });
    expect(canonical.threads).toEqual([
      expect.objectContaining({ id: "thread-new", preview: "First request" }),
    ]);
    expect(canonical.currentThread).toEqual(expect.objectContaining({
      id: "thread-new",
      preview: "First request",
      updatedAt: 1_800_000_010,
      turns: [],
    }));

    const replaced = appReducer(canonical, {
      type: "setThreads",
      threads: [{ id: "thread-existing", name: "Existing", updatedAt: 1_700_000_000 }],
    });
    expect(replaced.threads.map((thread) => thread.id)).toEqual(["thread-existing"]);
  });

  it("enriches a sparse thread notification from the selected thread snapshot", () => {
    let state = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "019abcde1234",
        preview: "First request",
        createdAt: 1_800_000_000,
        updatedAt: 1_800_000_000,
        recencyAt: 1_800_000_000,
        turns: [],
      },
    });
    state = appReducer(state, { type: "setThreads", threads: [] });
    state = appReducer(state, {
      type: "upsertThread",
      thread: { id: "019abcde1234", status: { type: "idle" } },
    });

    expect(state.threads).toEqual([
      expect.objectContaining({
        id: "019abcde1234",
        preview: "First request",
        createdAt: 1_800_000_000,
        recencyAt: 1_800_000_000,
        status: { type: "idle" },
      }),
    ]);
    expect(state.currentThread).toEqual(expect.objectContaining({
      preview: "First request",
      createdAt: 1_800_000_000,
      status: { type: "idle" },
    }));
  });

  it("updates renamed and pinned metadata in every matching thread projection", () => {
    const state: AppState = {
      ...initialState,
      threads: [{ id: "thread-active", name: "Old active", isPinned: false }],
      archivedThreads: [{ id: "thread-archived", name: "Old archived", isPinned: false }],
      selectedThreadId: "thread-active",
      currentThread: { id: "thread-active", name: "Old active", isPinned: false, turns: [] },
    };
    const renamed = appReducer(state, {
      type: "updateThreadMetadata",
      threadId: "thread-active",
      metadata: { name: "Renamed", isPinned: true },
    });
    const pinnedArchived = appReducer(renamed, {
      type: "updateThreadMetadata",
      threadId: "thread-archived",
      metadata: { isPinned: true },
    });

    expect(pinnedArchived.threads[0]).toEqual(expect.objectContaining({
      name: "Renamed",
      isPinned: true,
    }));
    expect(pinnedArchived.currentThread).toEqual(expect.objectContaining({
      name: "Renamed",
      isPinned: true,
      turns: [],
    }));
    expect(pinnedArchived.archivedThreads[0]).toEqual(expect.objectContaining({
      name: "Old archived",
      isPinned: true,
    }));
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

  it("moves an active thread to the archived list and clears its selected state", () => {
    const state: AppState = {
      ...initialState,
      threads: [
        { id: "thread-target", name: "Target", updatedAt: 3 },
        { id: "thread-active", name: "Still active", updatedAt: 2 },
      ],
      archivedThreads: [{ id: "thread-archived", name: "Already archived", updatedAt: 1 }],
      selectedThreadId: "thread-target",
      currentThread: {
        id: "thread-target",
        turns: [{ id: "turn-active", status: "inProgress", items: [] }],
      },
      activeTurnId: "turn-active",
      turnHistory: {
        threadId: "thread-target",
        nextCursor: "older-page",
        loadingCursor: "older-page",
        status: "loading",
        error: null,
      },
    };

    const archived = appReducer(state, {
      type: "archiveThread",
      threadId: "thread-target",
    });

    expect(archived.threads.map((thread) => thread.id)).toEqual(["thread-active"]);
    expect(archived.archivedThreads.map((thread) => thread.id)).toEqual([
      "thread-target",
      "thread-archived",
    ]);
    expect(archived.archivedThreads[0]?.turns).toBeUndefined();
    expect(archived.selectedThreadId).toBeNull();
    expect(archived.currentThread).toBeNull();
    expect(archived.activeTurnId).toBeNull();
    expect(archived.turnHistory).toEqual({
      threadId: null,
      nextCursor: null,
      loadingCursor: null,
      status: "idle",
      error: null,
    });
  });

  it("moves an archived thread back to the active list without disturbing other threads", () => {
    const state: AppState = {
      ...initialState,
      threads: [{ id: "thread-active", name: "Still active", updatedAt: 2 }],
      archivedThreads: [
        { id: "thread-target", name: "Restore me", updatedAt: 3 },
        { id: "thread-archived", name: "Keep archived", updatedAt: 1 },
      ],
    };

    const restored = appReducer(state, {
      type: "unarchiveThread",
      threadId: "thread-target",
    });

    expect(restored.threads.map((thread) => thread.id)).toEqual([
      "thread-target",
      "thread-active",
    ]);
    expect(restored.archivedThreads.map((thread) => thread.id)).toEqual([
      "thread-archived",
    ]);
  });

  it("permanently deletes one thread and its pending approval state", () => {
    const targetReason = JSON.stringify(["thread-target", "turn-1", "command-1"]);
    const targetLegacyReason = JSON.stringify(["thread-target", null, "legacy-command"]);
    const retainedReason = JSON.stringify(["thread-active", "turn-2", "command-2"]);
    const state: AppState = {
      ...initialState,
      threads: [
        { id: "thread-target", updatedAt: 3 },
        { id: "thread-active", updatedAt: 2 },
      ],
      archivedThreads: [
        { id: "thread-target", updatedAt: 3 },
        { id: "thread-archived", updatedAt: 1 },
      ],
      selectedThreadId: "thread-target",
      currentThread: {
        id: "thread-target",
        turns: [{ id: "turn-active", status: "inProgress", items: [] }],
      },
      activeTurnId: "turn-active",
      turnHistory: {
        threadId: "thread-target",
        nextCursor: "older-page",
        loadingCursor: null,
        status: "error",
        error: "retry me",
      },
      pendingRequests: [
        { id: "target-modern", method: "approval", params: { threadId: "thread-target" }, receivedAt: 1 },
        { id: "target-legacy", method: "approval", params: { conversationId: "thread-target" }, receivedAt: 2 },
        { id: "other-thread", method: "approval", params: { threadId: "thread-active" }, receivedAt: 3 },
        { id: "unscoped", method: "approval", params: {}, receivedAt: 4 },
      ],
      commandApprovalReasons: {
        [targetReason]: ["Target reason"],
        [targetLegacyReason]: ["Target legacy reason"],
        [retainedReason]: ["Retained reason"],
        "unparseable-key": ["Retained malformed key"],
      },
    };

    const deleted = appReducer(state, {
      type: "deleteThread",
      threadId: "thread-target",
    });

    expect(deleted.threads.map((thread) => thread.id)).toEqual(["thread-active"]);
    expect(deleted.archivedThreads.map((thread) => thread.id)).toEqual(["thread-archived"]);
    expect(deleted.selectedThreadId).toBeNull();
    expect(deleted.currentThread).toBeNull();
    expect(deleted.activeTurnId).toBeNull();
    expect(deleted.turnHistory).toEqual({
      threadId: null,
      nextCursor: null,
      loadingCursor: null,
      status: "idle",
      error: null,
    });
    expect(deleted.pendingRequests.map((request) => request.id)).toEqual([
      "other-thread",
      "unscoped",
    ]);
    expect(deleted.commandApprovalReasons).toEqual({
      [retainedReason]: ["Retained reason"],
      "unparseable-key": ["Retained malformed key"],
    });
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

  it("uses an authoritative plan snapshot and clears only its recovery omission", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          items: [],
          plan: { plan: [{ step: "Old step", status: "inProgress" }] },
          recoveryOmissions: ["turn/plan/updated", "turn/diff/updated"],
        }],
      },
    });
    const reconciled = appReducer(hydrated, {
      type: "reconcileCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          itemsView: "full",
          items: [],
          plan: {
            plan: [{ step: "Recovered step", status: "completed" }],
            emittedAtMs: 1_800_000_000_100,
            gatewayReceivedAtMs: 1_800_000_000_125,
          },
        }],
      },
    });

    expect(reconciled.currentThread?.turns?.[0]?.plan).toEqual({
      plan: [{ step: "Recovered step", status: "completed" }],
      emittedAtMs: 1_800_000_000_100,
      gatewayReceivedAtMs: 1_800_000_000_125,
    });
    expect(reconciled.currentThread?.turns?.[0]?.recoveryOmissions)
      .toEqual(["turn/diff/updated"]);
  });

  it("clears a stale plan for an authoritative null snapshot", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          items: [],
          plan: { plan: [{ step: "Stale step", status: "inProgress" }] },
          recoveryOmissions: ["turn/plan/updated", "turn/diff/updated"],
        }],
      },
    });
    const reconciled = appReducer(hydrated, {
      type: "reconcileCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          itemsView: "full",
          items: [],
          plan: null,
        }],
      },
    });

    expect(reconciled.currentThread?.turns?.[0]?.plan).toBeNull();
    expect(reconciled.currentThread?.turns?.[0]?.recoveryOmissions)
      .toEqual(["turn/diff/updated"]);
  });

  it("keeps an explicit plan omission tombstone with a null snapshot", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          items: [],
          plan: { plan: [{ step: "Stale step", status: "inProgress" }] },
          recoveryOmissions: ["turn/diff/updated"],
        }],
      },
    });
    const reconciled = appReducer(hydrated, {
      type: "reconcileCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          itemsView: "full",
          items: [],
          plan: null,
          recoveryOmissions: ["turn/plan/updated"],
        }],
      },
    });

    expect(reconciled.currentThread?.turns?.[0]?.plan).toBeNull();
    expect(reconciled.currentThread?.turns?.[0]?.recoveryOmissions)
      .toEqual(["turn/diff/updated", "turn/plan/updated"]);
  });

  it("preserves the live plan and omission when a snapshot has no plan field", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          items: [],
          plan: { plan: [{ step: "Live step", status: "inProgress" }] },
          recoveryOmissions: ["turn/plan/updated"],
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
          itemsView: "full",
          items: [],
        }],
      },
    });

    expect(reconciled.currentThread?.turns?.[0]?.plan).toEqual({
      plan: [{ step: "Live step", status: "inProgress" }],
    });
    expect(reconciled.currentThread?.turns?.[0]?.recoveryOmissions)
      .toEqual(["turn/plan/updated"]);
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

  it("promotes notLoaded streamed state to summary without allowing unknown views to downgrade it", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          itemsView: "notLoaded",
          items: [{ id: "partial-item", type: "agentMessage", text: "streamed" }],
        }],
      },
    });
    const summarized = appReducer(hydrated, {
      type: "reconcileCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "completed",
          itemsView: "summary",
          items: [],
          historyDetail: { cursor: "turn-page", status: "idle", error: null },
        }],
      },
    });
    const unknown = appReducer(summarized, {
      type: "reconcileCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "completed",
          itemsView: "futureView",
          items: [],
        }],
      },
    });

    expect(summarized.currentThread?.turns?.[0]).toEqual(expect.objectContaining({
      itemsView: "summary",
      items: [expect.objectContaining({ id: "partial-item", text: "streamed" })],
      historyDetail: { cursor: "turn-page", status: "idle", error: null },
    }));
    expect(unknown.currentThread?.turns?.[0]).toEqual(expect.objectContaining({
      itemsView: "summary",
      items: [expect.objectContaining({ id: "partial-item", text: "streamed" })],
      historyDetail: { cursor: "turn-page", status: "idle", error: null },
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

  it("keeps bounded approval reasons on the exact command item through completion", () => {
    const approved = appReducer(stateWithTurn(), {
      type: "recordCommandApprovalReason",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      reason: "Needs network access to inspect the upstream API",
    });
    const duplicate = appReducer(approved, {
      type: "recordCommandApprovalReason",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      reason: "Needs network access to inspect the upstream API",
    });
    const secondApproval = appReducer(duplicate, {
      type: "recordCommandApprovalReason",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      reason: "Needs access to a second host",
    });
    const started = appReducer(secondApproval, {
      type: "upsertItem",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", status: "inProgress", command: "curl example.com" },
      lifecycle: "started",
    });
    const completed = appReducer(started, {
      type: "upsertItem",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", status: "completed", exitCode: 0 },
      lifecycle: "completed",
    });

    expect(completed.currentThread?.turns?.[0]?.items).toHaveLength(1);
    expect(completed.currentThread?.turns?.[0]?.items[0]).toEqual(expect.objectContaining({
      command: "curl example.com",
      approvalReasons: [
        "Needs network access to inspect the upstream API",
        "Needs access to a second host",
      ],
      exitCode: 0,
    }));
  });

  it("does not leak a modern approval reason across turns that reuse an item id", () => {
    const state: AppState = {
      ...stateWithTurn(),
      currentThread: {
        id: "thread-1",
        turns: [
          { id: "turn-1", items: [{ id: "command", type: "commandExecution", command: "first" }] },
          { id: "turn-2", items: [{ id: "command", type: "commandExecution", command: "second" }] },
        ],
      },
    };
    const approved = appReducer(state, {
      type: "recordCommandApprovalReason",
      threadId: "thread-1",
      turnId: "turn-2",
      itemId: "command",
      reason: "Only the second command needs network access",
    });

    expect(approved.currentThread?.turns?.[0]?.items[0]?.approvalReasons).toBeUndefined();
    expect(approved.currentThread?.turns?.[1]?.items[0]?.approvalReasons).toEqual([
      "Only the second command needs network access",
    ]);
  });

  it("attaches a legacy call reason only when its item id is unique", () => {
    const uniqueState: AppState = {
      ...stateWithTurn(),
      currentThread: {
        id: "thread-1",
        turns: [{ id: "turn-1", items: [{ id: "call-1", type: "commandExecution", command: "git status" }] }],
      },
    };
    const unique = appReducer(uniqueState, {
      type: "recordCommandApprovalReason",
      threadId: "thread-1",
      itemId: "call-1",
      reason: "Inspect repository state",
    });
    expect(unique.currentThread?.turns?.[0]?.items[0]?.approvalReasons).toEqual([
      "Inspect repository state",
    ]);

    const becameAmbiguous = appReducer(unique, {
      type: "upsertTurn",
      threadId: "thread-1",
      turn: {
        id: "turn-2",
        items: [{ id: "call-1", type: "commandExecution", command: "another command" }],
      },
    });
    expect(becameAmbiguous.currentThread?.turns?.[0]?.items[0]?.approvalReasons).toEqual([
      "Inspect repository state",
    ]);
    expect(becameAmbiguous.currentThread?.turns?.[1]?.items[0]?.approvalReasons).toBeUndefined();

    const originalTurnUnloaded = appReducer(unique, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{ id: "turn-2", items: [{ id: "call-1", type: "commandExecution", command: "later" }] }],
      },
    });
    expect(originalTurnUnloaded.currentThread?.turns?.[0]?.items[0]?.approvalReasons).toBeUndefined();

    const originalTurnReloaded = appReducer(originalTurnUnloaded, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{ id: "turn-1", items: [{ id: "call-1", type: "commandExecution", command: "git status" }] }],
      },
    });
    expect(originalTurnReloaded.currentThread?.turns?.[0]?.items[0]?.approvalReasons).toEqual([
      "Inspect repository state",
    ]);

    const ambiguousState: AppState = {
      ...uniqueState,
      currentThread: {
        id: "thread-1",
        turns: [
          { id: "turn-1", items: [{ id: "call-1", type: "commandExecution", command: "first" }] },
          { id: "turn-2", items: [{ id: "call-1", type: "commandExecution", command: "second" }] },
        ],
      },
    };
    const ambiguous = appReducer(ambiguousState, {
      type: "recordCommandApprovalReason",
      threadId: "thread-1",
      itemId: "call-1",
      reason: "A legacy reason with an ambiguous call id",
    });
    expect(ambiguous.currentThread?.turns?.every(
      (turn) => turn.items[0]?.approvalReasons === undefined,
    )).toBe(true);

    const ambiguityCannotRebind = appReducer(ambiguous, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{ id: "turn-2", items: [{ id: "call-1", type: "commandExecution", command: "second" }] }],
      },
    });
    expect(ambiguityCannotRebind.currentThread?.turns?.[0]?.items[0]?.approvalReasons).toBeUndefined();
  });

  it("matches legacy approval ids against command items only", () => {
    const state: AppState = {
      ...stateWithTurn(),
      currentThread: {
        id: "thread-1",
        turns: [
          { id: "turn-command", items: [{ id: "call-1", type: "commandExecution", command: "git status" }] },
          { id: "turn-file", items: [{ id: "call-1", type: "fileChange", changes: [] }] },
        ],
      },
    };
    const approved = appReducer(state, {
      type: "recordCommandApprovalReason",
      threadId: "thread-1",
      itemId: "call-1",
      reason: "Inspect repository state",
    });

    expect(approved.currentThread?.turns?.[0]?.items[0]?.approvalReasons).toEqual([
      "Inspect repository state",
    ]);
    expect(approved.currentThread?.turns?.[1]?.items[0]?.approvalReasons).toBeUndefined();
  });

  it("bounds retained approval rationale by value, item, and session limits", () => {
    let state = stateWithTurn();
    for (let index = 0; index < 5; index += 1) {
      state = appReducer(state, {
        type: "recordCommandApprovalReason",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "bounded-command",
        reason: index === 4 ? "x".repeat(3_000) : `reason-${index}`,
      });
    }

    const boundedReasons = Object.values(state.commandApprovalReasons)[0];
    expect(boundedReasons).toHaveLength(4);
    expect(boundedReasons?.slice(0, 3)).toEqual(["reason-1", "reason-2", "reason-3"]);
    expect(boundedReasons?.[3]).toHaveLength(2_000);

    for (let index = 0; index < 260; index += 1) {
      state = appReducer(state, {
        type: "recordCommandApprovalReason",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: `command-${index}`,
        reason: `reason-${index}`,
      });
    }

    const retainedKeys = Object.keys(state.commandApprovalReasons).map((key) => JSON.parse(key));
    expect(retainedKeys).toHaveLength(256);
    expect(retainedKeys[0]).toEqual(["thread-1", "turn-1", "command-4"]);
    expect(retainedKeys.at(-1)).toEqual(["thread-1", "turn-1", "command-259"]);
  });

  it("rehydrates captured reasons after the same thread is loaded again", () => {
    const approved = appReducer(stateWithTurn(), {
      type: "recordCommandApprovalReason",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      reason: "Run the requested verification",
    });
    const deselected = appReducer(approved, { type: "selectThread", threadId: "thread-2" });
    const reloaded = appReducer(deselected, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          items: [{ id: "command-1", type: "commandExecution", command: "npm test", status: "completed" }],
        }],
      },
    });

    expect(reloaded.currentThread?.turns?.[0]?.items[0]?.approvalReasons).toEqual([
      "Run the requested verification",
    ]);
  });

  it("rehydrates a modern reason after a full resync snapshot replaces item payloads", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          itemsView: "full",
          items: [{ id: "command-1", type: "commandExecution", command: "npm test" }],
        }],
      },
    });
    const approved = appReducer(hydrated, {
      type: "recordCommandApprovalReason",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      reason: "Run the verification requested by the user",
    });
    const reconciled = appReducer(approved, {
      type: "reconcileCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "completed",
          itemsView: "full",
          items: [{ id: "command-1", type: "commandExecution", command: "npm test", exitCode: 0 }],
        }],
      },
    });

    expect(reconciled.currentThread?.turns?.[0]?.items[0]?.approvalReasons).toEqual([
      "Run the verification requested by the user",
    ]);
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

  it("applies the same plan snapshot semantics when full turn detail loads", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-large",
          status: "completed",
          items: [],
          itemsView: "summary",
          plan: { plan: [{ step: "Existing step", status: "inProgress" }] },
          recoveryOmissions: ["turn/plan/updated"],
          historyDetail: { cursor: "page-large", status: "idle", error: null },
        }],
      },
    });
    const load = (
      plan: "updated" | "cleared" | "missing",
    ): AppState => {
      const loading = appReducer(hydrated, {
        type: "loadTurnDetailStarted",
        threadId: "thread-1",
        turnId: "turn-large",
        cursor: "page-large",
      });
      const baseTurn = {
        id: "turn-large",
        status: "completed",
        itemsView: "full",
        items: [{ id: `message-${plan}`, type: "agentMessage", text: plan }],
      };
      const turn = plan === "updated"
        ? {
            ...baseTurn,
            plan: { plan: [{ step: "Recovered detail", status: "completed" }] },
          }
        : plan === "cleared"
          ? { ...baseTurn, plan: null }
          : baseTurn;
      return appReducer(loading, {
        type: "loadTurnDetailSucceeded",
        threadId: "thread-1",
        turnId: "turn-large",
        cursor: "page-large",
        turn,
      });
    };

    const updated = load("updated");
    const cleared = load("cleared");
    const missing = load("missing");

    expect(updated.currentThread?.turns?.[0]).toEqual(expect.objectContaining({
      items: [expect.objectContaining({ text: "updated" })],
      plan: { plan: [{ step: "Recovered detail", status: "completed" }] },
    }));
    expect(updated.currentThread?.turns?.[0]?.recoveryOmissions).toBeUndefined();
    expect(cleared.currentThread?.turns?.[0]?.plan).toBeNull();
    expect(cleared.currentThread?.turns?.[0]?.recoveryOmissions).toBeUndefined();
    expect(missing.currentThread?.turns?.[0]?.plan).toEqual({
      plan: [{ step: "Existing step", status: "inProgress" }],
    });
    expect(missing.currentThread?.turns?.[0]?.recoveryOmissions)
      .toEqual(["turn/plan/updated"]);
  });

  it("does not start history pagination while a summary turn is still running", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-running",
          status: "inProgress",
          items: [{ id: "live", type: "agentMessage", text: "Streaming" }],
          itemsView: "summary",
          historyDetail: { cursor: null, status: "idle", error: null },
        }],
      },
    });

    const ignored = appReducer(hydrated, {
      type: "loadTurnDetailStarted",
      threadId: "thread-1",
      turnId: "turn-running",
      cursor: null,
    });

    expect(ignored.currentThread?.turns?.[0]?.historyDetail?.status).toBe("idle");
    expect(ignored.currentThread?.turns?.[0]?.items[0]).toEqual(expect.objectContaining({
      id: "live",
      text: "Streaming",
    }));
  });

  it("keeps a permanent detail failure unavailable instead of retrying it", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-large",
          items: [],
          itemsView: "summary",
          historyDetail: { cursor: null, status: "idle", error: null },
        }],
      },
    });
    const loading = appReducer(hydrated, {
      type: "loadTurnDetailStarted",
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: null,
    });
    const unavailable = appReducer(loading, {
      type: "loadTurnDetailFailed",
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: null,
      error: "One item is too large",
      unavailable: true,
    });
    const ignored = appReducer(unavailable, {
      type: "loadTurnDetailStarted",
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: null,
    });

    expect(ignored.currentThread?.turns?.[0]?.historyDetail).toEqual(expect.objectContaining({
      status: "unavailable",
      error: "One item is too large",
    }));
  });

  it("hydrates a summary turn through ordered item pages", () => {
    const hydrated = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-large",
          items: [{ id: "summary", type: "agentMessage", text: "Summary only" }],
          itemsView: "summary",
          historyDetail: { cursor: "turn-page", status: "idle", error: null },
        }],
      },
    });
    const firstLoading = appReducer(hydrated, {
      type: "loadTurnDetailStarted",
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "turn-page",
    });
    const firstPage = appReducer(firstLoading, {
      type: "loadTurnItemPageSucceeded",
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "turn-page",
      items: [
        { id: "user", type: "userMessage", text: "Question" },
        { id: "user", type: "userMessage", text: "Duplicate" },
        { id: "agent", type: "agentMessage", text: "Answer" },
      ],
      nextItemCursor: "item-page-2",
    });

    expect(firstPage.currentThread?.turns?.[0]).toEqual(expect.objectContaining({
      itemsView: "summary",
      items: [
        expect.objectContaining({ id: "user", text: "Question" }),
        expect.objectContaining({ id: "agent", text: "Answer" }),
      ],
      historyDetail: expect.objectContaining({
        nextItemCursor: "item-page-2",
        status: "idle",
        error: null,
      }),
    }));

    const afterSummaryNotification = appReducer(firstPage, {
      type: "upsertTurn",
      threadId: "thread-1",
      turn: {
        id: "turn-large",
        status: "completed",
        itemsView: "summary",
        items: [{ id: "summary", type: "agentMessage", text: "Late summary" }],
      },
    });

    expect(afterSummaryNotification.currentThread?.turns?.[0]).toEqual(expect.objectContaining({
      items: [
        expect.objectContaining({ id: "user" }),
        expect.objectContaining({ id: "agent" }),
      ],
      historyDetail: expect.objectContaining({ nextItemCursor: "item-page-2" }),
    }));

    const secondLoading = appReducer(afterSummaryNotification, {
      type: "loadTurnDetailStarted",
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "turn-page",
      itemCursor: "item-page-2",
    });
    const complete = appReducer(secondLoading, {
      type: "loadTurnItemPageSucceeded",
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "turn-page",
      itemCursor: "item-page-2",
      items: [
        { id: "agent", type: "agentMessage", text: "Duplicate anchor" },
        { id: "command", type: "commandExecution", command: "pwd" },
      ],
      nextItemCursor: null,
    });

    expect(complete.currentThread?.turns?.[0]).toEqual(expect.objectContaining({
      itemsView: "full",
      items: [
        expect.objectContaining({ id: "user" }),
        expect.objectContaining({ id: "agent", text: "Answer" }),
        expect.objectContaining({ id: "command" }),
      ],
    }));
    expect(complete.currentThread?.turns?.[0]?.historyDetail).toBeUndefined();
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

  it("tracks reasoning lifecycle independently from canonical item status", () => {
    const started = appReducer(stateWithTurn(), {
      type: "upsertItem",
      turnId: "turn-1",
      item: { id: "reasoning-1", type: "reasoning", summary: [], content: [] },
      lifecycle: "started",
    });
    expect(started.activeReasoningItemIdsByTurn).toEqual({ "turn-1": ["reasoning-1"] });

    const completed = appReducer(started, {
      type: "upsertItem",
      turnId: "turn-1",
      item: { id: "reasoning-1", type: "reasoning", summary: [], content: [] },
      lifecycle: "completed",
    });
    expect(completed.activeReasoningItemIdsByTurn).toEqual({});

    const streaming = appReducer(completed, {
      type: "appendIndexedItemDelta",
      turnId: "turn-1",
      itemId: "reasoning-2",
      itemType: "reasoning",
      field: "summary",
      index: 0,
      delta: "Working",
    });
    expect(streaming.activeReasoningItemIdsByTurn).toEqual({ "turn-1": ["reasoning-2"] });

    const turnCompleted = appReducer(streaming, {
      type: "setTurnStatus",
      turnId: "turn-1",
      status: "completed",
    });
    expect(turnCompleted.activeReasoningItemIdsByTurn).toEqual({});
  });

  it("clears live reasoning state before a resync snapshot", () => {
    const active = {
      ...stateWithTurn(),
      activeReasoningItemIdsByTurn: { "turn-1": ["reasoning-1"] },
    };

    expect(appReducer(active, { type: "clearActiveReasoningItems" }).activeReasoningItemIdsByTurn).toEqual({});
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

  it("projects authoritative cwd updates into matching thread records", () => {
    const selected = {
      ...initialState,
      selectedThreadId: "thread-1",
      currentThread: { id: "thread-1", cwd: "/workspace/old", turns: [] },
      threads: [{ id: "thread-1", cwd: "/workspace/old" }],
      archivedThreads: [{ id: "thread-2", cwd: "/workspace/archive-old" }],
    };
    const currentUpdated = appReducer(selected, {
      type: "threadSettings",
      threadId: "thread-1",
      settings: { cwd: "/workspace/new" },
    });
    const archivedUpdated = appReducer(currentUpdated, {
      type: "threadSettings",
      threadId: "thread-2",
      settings: { cwd: "/workspace/archive-new" },
    });

    expect(currentUpdated.currentThread?.cwd).toBe("/workspace/new");
    expect(currentUpdated.threads[0]?.cwd).toBe("/workspace/new");
    expect(currentUpdated.settings.cwd).toBe("/workspace/new");
    expect(archivedUpdated.archivedThreads[0]?.cwd).toBe("/workspace/archive-new");
    expect(archivedUpdated.settings.cwd).toBe("/workspace/new");
  });

  it("stores plan and diff updates on the matching turn", () => {
    const planned = appReducer(stateWithTurn(), {
      type: "setTurnPlan",
      threadId: "thread-1",
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

  it("ignores a plan update scoped to a different thread", () => {
    const state = stateWithTurn();
    const ignored = appReducer(state, {
      type: "setTurnPlan",
      threadId: "thread-2",
      turnId: "turn-1",
      plan: { plan: [{ step: "Wrong thread", status: "inProgress" }] },
    });

    expect(ignored).toBe(state);
    expect(ignored.currentThread?.turns?.[0]?.plan).toBeUndefined();
  });

  it("keeps streamed items when turn/completed carries a notLoaded turn", () => {
    const streaming = stateWithTurn();
    streaming.currentThread = {
      ...streaming.currentThread!,
      turns: [{
        id: "turn-1",
        status: "inProgress",
        items: [{
          id: "agent-stream",
          type: "agentMessage",
          text: "Visible streamed answer",
          streamOmittedCharacters: { text: 12 },
        }],
      }],
    };
    const completed = appReducer({ ...streaming, activeTurnId: "turn-1" }, {
      type: "upsertTurn",
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", itemsView: "notLoaded", items: [] },
    });

    expect(completed.activeTurnId).toBeNull();
    expect(completed.currentThread?.turns?.[0]).toEqual(expect.objectContaining({
      status: "completed",
      items: [expect.objectContaining({
        id: "agent-stream",
        text: "Visible streamed answer",
        streamOmittedCharacters: { text: 12 },
      })],
    }));
  });

  it("keeps materialized items when resync returns a notLoaded turn", () => {
    const streaming = appReducer(initialState, {
      type: "setCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "inProgress",
          itemsView: "full",
          items: [{ id: "agent-stream", type: "agentMessage", text: "Still here" }],
        }],
      },
    });
    const reconciled = appReducer(streaming, {
      type: "reconcileCurrentThread",
      thread: {
        id: "thread-1",
        turns: [{
          id: "turn-1",
          status: "completed",
          itemsView: "notLoaded",
          items: [],
        }],
      },
    });

    expect(reconciled.currentThread?.turns?.[0]).toEqual(expect.objectContaining({
      status: "completed",
      itemsView: "full",
      items: [expect.objectContaining({ id: "agent-stream", text: "Still here" })],
    }));
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

  it("keeps list recency when hydration and notifications carry older timestamps", () => {
    let state = appReducer(initialState, {
      type: "setThreads",
      threads: [
        { id: "thread-target", recencyAt: 300, updatedAt: 300 },
        { id: "thread-other", recencyAt: 200, updatedAt: 200 },
      ],
    });

    state = appReducer(state, {
      type: "setCurrentThread",
      thread: {
        id: "thread-target",
        createdAt: 100,
        updatedAt: 100,
        recencyAt: 100,
        turns: [],
      },
    });
    expect(state.threads.map((thread) => thread.id)).toEqual(["thread-target", "thread-other"]);
    expect(state.threads[0]?.recencyAt).toBe(300);

    state = appReducer(state, {
      type: "upsertThread",
      thread: { id: "thread-target", updatedAt: 50, status: { type: "idle" } },
    });
    expect(state.threads.map((thread) => thread.id)).toEqual(["thread-target", "thread-other"]);
    expect(state.threads[0]?.recencyAt).toBe(300);

    state = appReducer(state, {
      type: "reconcileCurrentThread",
      thread: { id: "thread-target", updatedAt: 75, recencyAt: 75, turns: [] },
    });
    expect(state.threads.map((thread) => thread.id)).toEqual(["thread-target", "thread-other"]);
    expect(state.threads[0]?.recencyAt).toBe(300);

    state = appReducer(state, {
      type: "upsertThread",
      thread: { id: "thread-other", updatedAt: 400 },
    });
    expect(state.threads.map((thread) => thread.id)).toEqual(["thread-other", "thread-target"]);
    expect(state.threads[0]?.recencyAt).toBe(400);
  });

  it("clears stale approval requests after an app-server failure", () => {
    const state = appReducer({
      ...initialState,
      pendingRequests: [{ id: 1, method: "approval", params: {}, receivedAt: 1 }],
    }, { type: "clearRequests" });

    expect(state.pendingRequests).toEqual([]);
  });
});
