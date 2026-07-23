import { describe, expect, it } from "vitest";
import {
  commandApprovalTarget,
  extractInitialTurnsPage,
  normalizeTurnsPage,
  sandboxMode,
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

describe("turn page normalization", () => {
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
