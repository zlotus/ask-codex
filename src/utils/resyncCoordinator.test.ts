import { describe, expect, it } from "vitest";
import type { NotificationMessage } from "../types/protocol";
import {
  filterSnapshotCoveredNotifications,
  ResyncCoordinator,
  shouldBufferDuringResync,
} from "./resyncCoordinator";

function notification(method: string, delta = "x"): NotificationMessage {
  return {
    type: "notification",
    method,
    params: { turnId: "turn-1", itemId: "item-1", delta },
  };
}

describe("ResyncCoordinator", () => {
  it("buffers thread and turn state but keeps approval resolution immediate", () => {
    expect(shouldBufferDuringResync(notification("item/agentMessage/delta"))).toBe(true);
    expect(shouldBufferDuringResync(notification("turn/completed"))).toBe(true);
    expect(shouldBufferDuringResync(notification("thread/status/changed"))).toBe(true);
    expect(shouldBufferDuringResync(notification("serverRequest/resolved"))).toBe(false);
  });

  it("coalesces duplicate requests into one current pass and one rerun", () => {
    const coordinator = new ResyncCoordinator();
    coordinator.request();
    expect(coordinator.startCycle()).toBe(true);
    expect(coordinator.startCycle()).toBe(false);

    coordinator.request();
    coordinator.request();
    const first = coordinator.finishPass(true);
    expect(first).toMatchObject({ rerun: true, restart: false });

    coordinator.request();
    const second = coordinator.finishPass(false);
    expect(second).toMatchObject({ rerun: false, restart: true });
    expect(coordinator.startCycle()).toBe(true);
  });

  it("bounds buffered messages and requests a fresh pass after overflow", () => {
    const coordinator = new ResyncCoordinator({ maxMessages: 2, maxBytes: 10_000 });
    coordinator.request();
    expect(coordinator.startCycle()).toBe(true);
    coordinator.buffer(notification("item/agentMessage/delta", "one"));
    coordinator.buffer(notification("item/agentMessage/delta", "two"));
    coordinator.buffer(notification("item/agentMessage/delta", "three"));

    const result = coordinator.finishPass(true);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.params).toEqual(expect.objectContaining({ delta: "three" }));
    expect(result.rerun).toBe(true);
  });

  it("drops a single over-budget message and schedules another snapshot", () => {
    const coordinator = new ResyncCoordinator({ maxMessages: 10, maxBytes: 100 });
    coordinator.request();
    expect(coordinator.startCycle()).toBe(true);
    coordinator.buffer(notification("item/agentMessage/delta", "x".repeat(1_000)));

    const result = coordinator.finishPass(true);
    expect(result.notifications).toEqual([]);
    expect(result.rerun).toBe(true);
  });

  it("replays buffered messages and releases buffering after failure", () => {
    const coordinator = new ResyncCoordinator();
    coordinator.request();
    expect(coordinator.startCycle()).toBe(true);
    const delta = notification("item/agentMessage/delta");
    expect(coordinator.shouldBuffer(delta)).toBe(true);
    coordinator.buffer(delta);

    expect(coordinator.abort()).toEqual([delta]);
    expect(coordinator.shouldBuffer(delta)).toBe(false);
    expect(coordinator.startCycle()).toBe(false);
  });

  it("does not replay append deltas already covered by a full snapshot", () => {
    const baseline = {
      id: "thread-1",
      turns: [{
        id: "turn-1",
        status: "inProgress",
        itemsView: "full",
        items: [{ id: "item-1", type: "agentMessage", text: "before" }],
      }],
    };
    const snapshot = {
      id: "thread-1",
      turns: [{
        id: "turn-1",
        status: "inProgress",
        itemsView: "full",
        items: [{ id: "item-1", type: "agentMessage", text: "before one two" }],
      }],
    };
    const messages = [
      notification("item/agentMessage/delta", " one"),
      notification("item/agentMessage/delta", " two"),
      notification("turn/completed"),
    ];

    expect(filterSnapshotCoveredNotifications(baseline, snapshot, messages)).toEqual([
      notification("turn/completed"),
    ]);
  });

  it("replays only the suffix not yet represented by the snapshot", () => {
    const baseline = {
      id: "thread-1",
      turns: [{
        id: "turn-1",
        status: "inProgress",
        itemsView: "full",
        items: [{ id: "item-1", type: "agentMessage", text: "same" }],
      }],
    };
    const snapshot = {
      id: "thread-1",
      turns: [{
        id: "turn-1",
        status: "inProgress",
        itemsView: "full",
        items: [{ id: "item-1", type: "agentMessage", text: "same one" }],
      }],
    };
    const messages = [
      notification("item/agentMessage/delta", " one"),
      notification("item/agentMessage/delta", " two"),
    ];

    expect(filterSnapshotCoveredNotifications(baseline, snapshot, messages)).toEqual([
      notification("item/agentMessage/delta", " two"),
    ]);
    expect(filterSnapshotCoveredNotifications(baseline, baseline, [
      notification("item/agentMessage/delta", "same"),
    ])).toHaveLength(1);
  });

  it("keeps out-of-range reasoning deltas for explicit omission accounting", () => {
    const message: NotificationMessage = {
      type: "notification",
      method: "item/reasoning/summaryTextDelta",
      params: {
        turnId: "turn-1",
        itemId: "item-1",
        summaryIndex: 16,
        delta: "omitted reasoning",
      },
    };
    const snapshot = {
      id: "thread-1",
      turns: [{
        id: "turn-1",
        status: "completed",
        itemsView: "full",
        items: [{ id: "item-1", type: "reasoning", summary: [] }],
      }],
    };

    expect(filterSnapshotCoveredNotifications(null, snapshot, [message])).toEqual([message]);
  });

  it("drops plan notifications already covered by a plan snapshot or tombstone", () => {
    const planNotification: NotificationMessage = {
      type: "notification",
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        plan: [{ step: "Buffered", status: "inProgress" }],
      },
    };
    const snapshot = {
      id: "thread-1",
      turns: [{
        id: "turn-1",
        items: [],
        plan: { plan: [{ step: "Snapshot", status: "completed" }] },
      }],
    };

    expect(filterSnapshotCoveredNotifications(null, snapshot, [planNotification])).toEqual([]);
    expect(filterSnapshotCoveredNotifications(null, {
      ...snapshot,
      turns: [{ ...snapshot.turns[0], plan: null }],
    }, [planNotification])).toEqual([]);
    expect(filterSnapshotCoveredNotifications(null, {
      ...snapshot,
      turns: [{ id: "turn-1", items: [] }],
    }, [planNotification])).toEqual([planNotification]);
  });
});
