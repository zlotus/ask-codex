import { describe, expect, it } from "vitest";

import { extractMessageQueueItem, extractMessageQueueSnapshot } from "./messageQueue";

const item = {
  id: "a".repeat(32),
  threadId: "thread-1",
  text: "Continue later",
  expectedLastTurnId: "turn-1",
  status: "queued",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 2,
};

describe("message queue protocol", () => {
  it("parses bounded snapshots and item responses", () => {
    expect(extractMessageQueueSnapshot({ revision: 4, items: [item] })).toEqual({
      revision: 4,
      items: [item],
    });
    expect(extractMessageQueueItem({ item: { ...item, status: "needsReview", reviewReason: "contextChanged" } }))
      .toEqual({ ...item, status: "needsReview", reviewReason: "contextChanged" });
  });

  it.each([
    { ...item, id: "short" },
    { ...item, revision: 0 },
    { ...item, status: "unknown" },
    { ...item, reviewReason: "raw-upstream-error" },
    { ...item, text: "x".repeat(64 * 1024 + 1) },
  ])("rejects malformed queue items %#", (candidate) => {
    expect(extractMessageQueueItem({ item: candidate })).toBeNull();
  });
});
