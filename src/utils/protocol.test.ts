import { describe, expect, it } from "vitest";
import { extractInitialTurnsPage, normalizeTurnsPage, sandboxMode } from "./protocol";

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
