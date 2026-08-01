import { describe, expect, it } from "vitest";
import {
  commandApprovalTarget,
  extractInitialTurnsPage,
  extractModels,
  itemText,
  normalizeItemsPage,
  normalizeTurn,
  normalizeTurnsPage,
  sandboxMode,
  userMessageContent,
  userMessageImages,
} from "./protocol";

describe("commandApprovalTarget", () => {
  it("uses modern turn and item identifiers without matching command text", () => {
    expect(commandApprovalTarget("item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      approvalId: "approval-for-one-subcommand",
      command: "curl https://example.com",
      reason: "Needs network access",
    })).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      reason: "Needs network access",
    });
  });

  it("uses the legacy call id and ignores requests without a reason", () => {
    expect(commandApprovalTarget("execCommandApproval", {
      conversationId: "thread-legacy",
      callId: "call-1",
      reason: "Inspect repository metadata",
    })).toEqual({
      threadId: "thread-legacy",
      turnId: undefined,
      itemId: "call-1",
      reason: "Inspect repository metadata",
    });
    expect(commandApprovalTarget("execCommandApproval", {
      conversationId: "thread-legacy",
      callId: "call-1",
      reason: null,
    })).toBeNull();
    expect(commandApprovalTarget("item/fileChange/requestApproval", {
      itemId: "item-1",
      reason: "Apply changes",
    })).toBeNull();
    expect(commandApprovalTarget("item/commandExecution/requestApproval", {
      threadId: "thread-1",
      itemId: "item-1",
      reason: "Missing the required turn id",
    })).toBeNull();
  });

  it("rejects oversized identifiers before retaining an approval reason", () => {
    const oversized = "x".repeat(513);
    expect(commandApprovalTarget("item/commandExecution/requestApproval", {
      threadId: oversized,
      turnId: "turn-1",
      itemId: "item-1",
      reason: "Needs network access",
    })).toBeNull();
    expect(commandApprovalTarget("execCommandApproval", {
      conversationId: "thread-1",
      callId: oversized,
      reason: "Inspect repository metadata",
    })).toBeNull();
  });
});

describe("sandboxMode", () => {
  it("maps every current app-server sandbox policy", () => {
    expect(sandboxMode({ type: "workspaceWrite" })).toBe("workspace-write");
    expect(sandboxMode({ type: "readOnly" })).toBe("read-only");
    expect(sandboxMode({ type: "dangerFullAccess" })).toBe("danger-full-access");
    expect(sandboxMode({ type: "externalSandbox" })).toBe("external");
  });
});

describe("multimodal protocol normalization", () => {
  it("preserves supported model input modalities and drops unknown values", () => {
    expect(extractModels({
      data: [{
        model: "vision-model",
        displayName: "Vision Model",
        supportedReasoningEfforts: [],
        inputModalities: ["text", "image", "video", 7],
      }],
    })).toEqual([expect.objectContaining({
      model: "vision-model",
      inputModalities: ["text", "image"],
    })]);
  });

  it("extracts user text and safe image metadata without retaining image locations", () => {
    const item = {
      id: "user-1",
      type: "userMessage",
      content: [
        { type: "text", text: "Inspect both", text_elements: [] },
        { type: "localImage", path: "/private/image.png", detail: "original" },
        { type: "image", url: "https://private.example/image.jpg", detail: "invalid" },
      ],
    };

    expect(itemText(item)).toBe("Inspect both");
    expect(userMessageImages(item)).toEqual([
      { type: "localImage", detail: "original" },
      { type: "image", detail: undefined },
    ]);
    expect(JSON.stringify(userMessageImages(item))).not.toContain("/private/image.png");
    expect(JSON.stringify(userMessageImages(item))).not.toContain("private.example");
    expect(userMessageContent(item)).toEqual([
      { type: "text", text: "Inspect both" },
      { type: "localImage", detail: "original" },
      { type: "image", detail: undefined },
    ]);
  });
});

describe("turn page normalization", () => {
  it("keeps valid turn timing and drops malformed values", () => {
    expect(normalizeTurn({
      id: "turn-timed",
      items: [],
      startedAt: 1_800_000_000,
      completedAt: null,
      durationMs: 2_450,
    })).toEqual(expect.objectContaining({
      startedAt: 1_800_000_000,
      completedAt: null,
      durationMs: 2_450,
    }));
    expect(normalizeTurn({
      id: "turn-invalid-timing",
      items: [],
      startedAt: "yesterday",
      completedAt: Number.POSITIVE_INFINITY,
      durationMs: -1,
    })).toEqual({ id: "turn-invalid-timing", items: [] });
  });

  it("normalizes an initial resume page without changing protocol order", () => {
    expect(extractInitialTurnsPage({
      initialTurnsPage: {
        data: [
          { id: "newer", status: "completed", items: [{ id: "message", type: "agentMessage" }] },
          { id: "older", status: "completed", items: [] },
          { status: "completed", items: [] },
        ],
        nextCursor: "older-page",
        backwardsCursor: "newer-page",
      },
    })).toEqual({
      data: [
        expect.objectContaining({ id: "newer", items: [expect.objectContaining({ id: "message" })] }),
        expect.objectContaining({ id: "older", items: [] }),
      ],
      nextCursor: "older-page",
      backwardsCursor: "newer-page",
    });
  });

  it("rejects malformed pages and normalizes absent cursors to null", () => {
    expect(normalizeTurnsPage({ data: [] })).toEqual({
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });
    expect(normalizeTurnsPage({ data: "not-an-array" })).toBeNull();
    expect(extractInitialTurnsPage({ initialTurnsPage: null })).toBeNull();
  });
});

describe("item page normalization", () => {
  it("normalizes item entries without changing protocol order", () => {
    expect(normalizeItemsPage({
      data: [
        { turnId: "turn-1", item: { id: "user-1", type: "userMessage" } },
        { turnId: "turn-1", item: { id: "agent-1", type: "agentMessage" } },
      ],
      nextCursor: "next-item-page",
      backwardsCursor: "newer-item-page",
    })).toEqual({
      data: [
        { turnId: "turn-1", item: { id: "user-1", type: "userMessage" } },
        { turnId: "turn-1", item: { id: "agent-1", type: "agentMessage" } },
      ],
      nextCursor: "next-item-page",
      backwardsCursor: "newer-item-page",
    });
  });

  it("rejects malformed entries and cursors instead of treating a partial page as complete", () => {
    expect(normalizeItemsPage({
      data: [{ turnId: 2, item: { id: "invalid-turn", type: "agentMessage" } }],
      nextCursor: null,
      backwardsCursor: null,
    })).toBeNull();
    expect(normalizeItemsPage({
      data: [{ turnId: "turn-1", item: { type: "missing-id" } }],
      nextCursor: null,
      backwardsCursor: null,
    })).toBeNull();
    expect(normalizeItemsPage({ data: [], nextCursor: 2, backwardsCursor: null })).toBeNull();
    expect(normalizeItemsPage({ data: [], nextCursor: null })).toBeNull();
    expect(normalizeItemsPage({ data: "not-an-array" })).toBeNull();
  });
});
