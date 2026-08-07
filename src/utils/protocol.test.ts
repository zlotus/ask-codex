import { describe, expect, it } from "vitest";
import {
  commandApprovalTarget,
  extractInitialTurnsPage,
  extractModels,
  extractSkillsDirectory,
  itemText,
  normalizeItemsPage,
  normalizeThread,
  normalizeTurn,
  normalizeTurnsPage,
  parseServerMessage,
  sandboxMode,
  userMessageContent,
  userMessageFiles,
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

describe("thread normalization", () => {
  it("preserves boolean pin state and drops malformed values", () => {
    expect(normalizeThread({ id: "pinned", isPinned: true })).toEqual({
      id: "pinned",
      isPinned: true,
    });
    expect(normalizeThread({ id: "unpinned", isPinned: false })).toEqual({
      id: "unpinned",
      isPinned: false,
    });
    expect(normalizeThread({ id: "invalid", isPinned: "yes" })).toEqual({
      id: "invalid",
    });
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

  it("recognizes only the complete gateway file marker without retaining a host path", () => {
    const text = "Attached file: 设计.pdf";
    const marker = {
      type: "askCodexFile",
      name: "设计.pdf",
      mediaType: "application/pdf",
      size: 2048,
    };
    const filePart = {
      type: "text",
      text,
      text_elements: [{
        byteRange: { start: 0, end: new TextEncoder().encode(text).byteLength },
        placeholder: JSON.stringify(marker),
      }],
    };
    const item = { id: "user-file", type: "userMessage", content: [filePart] };

    expect(userMessageFiles(item)).toEqual([{
      type: "file",
      name: "设计.pdf",
      mediaType: "application/pdf",
      size: 2048,
    }]);
    expect(JSON.stringify(userMessageContent(item))).not.toContain("/private");
    expect(userMessageFiles({
      ...item,
      content: [{
        ...filePart,
        text_elements: [{
          ...filePart.text_elements[0],
          placeholder: JSON.stringify({ ...marker, path: "/private/report.pdf" }),
        }],
      }],
    })).toEqual([]);

    for (const invalidMarker of [
      { ...marker, name: `${"a".repeat(256)}.pdf` },
      { ...marker, name: "../report.pdf" },
      { ...marker, mediaType: "APPLICATION/PDF" },
      { ...marker, mediaType: "not-a-media-type" },
      { ...marker, size: 10 * 1024 * 1024 + 1 },
    ]) {
      const invalidText = `Attached file: ${invalidMarker.name}`;
      expect(userMessageFiles({
        ...item,
        content: [{
          type: "text",
          text: invalidText,
          text_elements: [{
            byteRange: { start: 0, end: new TextEncoder().encode(invalidText).byteLength },
            placeholder: JSON.stringify(invalidMarker),
          }],
        }],
      })).toEqual([]);
    }
  });
});

describe("skills directory normalization", () => {
  it("keeps only the minimal browser-visible skill projection", () => {
    const directory = extractSkillsDirectory({
      data: [{
        cwd: "/workspace/project",
        skills: [{
          name: "review",
          description: "Review changes",
          shortDescription: "Review",
          scope: "repo",
          enabled: true,
          path: "/private/skills/review/SKILL.md",
          interface: { displayName: "Private display name" },
          dependencies: { tools: [{ type: "mcp", value: "private-server" }] },
        }],
        errorCount: 2,
        errors: [{ path: "/private/broken-skill", message: "Private parser error" }],
      }],
    });

    expect(directory).toEqual([{
      cwd: "/workspace/project",
      skills: [{
        name: "review",
        description: "Review changes",
        shortDescription: "Review",
        scope: "repo",
        enabled: true,
      }],
      errorCount: 2,
    }]);
    expect(JSON.stringify(directory)).not.toContain("/private/");
    expect(JSON.stringify(directory)).not.toContain("Private parser error");
    expect(JSON.stringify(directory)).not.toContain("displayName");
    expect(JSON.stringify(directory)).not.toContain("dependencies");
  });

  it("filters malformed entries and skills while retaining valid siblings", () => {
    expect(extractSkillsDirectory({
      data: [
        {
          cwd: "/workspace/valid",
          skills: [
            { name: "valid", description: "Works", scope: "user", enabled: false },
            { name: "bad-scope", description: "No", scope: "workspace", enabled: true },
            { name: "bad-enabled", description: "No", scope: "system", enabled: "yes" },
            { name: "bad-short", description: "No", shortDescription: 7, scope: "admin", enabled: true },
          ],
          errorCount: 0,
        },
        { cwd: 7, skills: [], errorCount: 0 },
        { cwd: "/workspace/no-skills", skills: null, errorCount: 0 },
        { cwd: "/workspace/bad-count", skills: [], errorCount: -1 },
      ],
    })).toEqual([{
      cwd: "/workspace/valid",
      skills: [{
        name: "valid",
        description: "Works",
        scope: "user",
        enabled: false,
      }],
      errorCount: 0,
    }]);
  });

  it("returns an empty directory for malformed response envelopes", () => {
    expect(extractSkillsDirectory(null)).toEqual([]);
    expect(extractSkillsDirectory([])).toEqual([]);
    expect(extractSkillsDirectory({ data: "invalid" })).toEqual([]);
  });
});

describe("turn page normalization", () => {
  it("normalizes recoverable plan snapshots and preserves their diagnostic timing", () => {
    expect(normalizeTurn({
      id: "turn-planned",
      items: [],
      askCodexPlanRevision: 7,
      plan: {
        explanation: "Work through the recovery path.",
        plan: [
          { step: "Read the snapshot", status: "completed" },
          { step: "Replay notifications", status: "inProgress" },
          { step: "Verify the result", status: "pending" },
        ],
        emittedAtMs: 1_800_000_000_100,
        gatewayReceivedAtMs: 1_800_000_000_125,
      },
    })).toEqual({
      id: "turn-planned",
      items: [],
      askCodexPlanRevision: 7,
      plan: {
        explanation: "Work through the recovery path.",
        plan: [
          { step: "Read the snapshot", status: "completed" },
          { step: "Replay notifications", status: "inProgress" },
          { step: "Verify the result", status: "pending" },
        ],
        emittedAtMs: 1_800_000_000_100,
        gatewayReceivedAtMs: 1_800_000_000_125,
      },
    });
  });

  it("distinguishes an authoritative null plan from an absent plan and fails malformed plans closed", () => {
    const absent = normalizeTurn({
      id: "turn-absent",
      items: [],
      askCodexPlanRevision: 7,
    });
    const cleared = normalizeTurn({
      id: "turn-cleared",
      items: [],
      plan: null,
      askCodexPlanRevision: 8,
    });
    const malformed = normalizeTurn({
      id: "turn-malformed",
      items: [],
      plan: {
        plan: [
          { step: "Valid step", status: "completed" },
          { step: "Unknown state", status: "unexpected" },
        ],
      },
    });

    expect(Object.hasOwn(absent!, "plan")).toBe(false);
    expect(absent).not.toHaveProperty("askCodexPlanRevision");
    expect(cleared).toEqual({
      id: "turn-cleared",
      items: [],
      plan: null,
      askCodexPlanRevision: 8,
    });
    expect(malformed).toEqual({ id: "turn-malformed", items: [], plan: null });
  });

  it("accepts only positive safe plan revisions on authoritative snapshots", () => {
    for (const askCodexPlanRevision of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
      expect(normalizeTurn({
        id: "turn-invalid-revision",
        items: [],
        plan: null,
        askCodexPlanRevision,
      })).toEqual({ id: "turn-invalid-revision", items: [], plan: null });
    }
  });

  it("rejects plan snapshots outside the browser rendering bounds", () => {
    for (const plan of [
      Array.from({ length: 129 }, (_, index) => ({
        step: `Step ${index}`,
        status: "pending",
      })),
      [{ step: "x".repeat(8 * 1024 + 1), status: "inProgress" }],
      Array.from({ length: 128 }, () => ({
        step: "x".repeat(1_100),
        status: "pending",
      })),
    ]) {
      expect(normalizeTurn({ id: "turn-bounded", items: [], plan: { plan } })?.plan)
        .toBeNull();
    }
    expect(normalizeTurn({
      id: "turn-bounded-explanation",
      items: [],
      plan: { explanation: "x".repeat(32 * 1024 + 1), plan: [] },
    })?.plan).toBeNull();
  });

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

describe("server message normalization", () => {
  it("preserves valid notification diagnostic timestamps", () => {
    expect(parseServerMessage({
      type: "notification",
      method: "turn/plan/updated",
      params: { threadId: "thread-1", turnId: "turn-1", plan: [] },
      emittedAtMs: 1_800_000_000_100,
      gatewayReceivedAtMs: 1_800_000_000_125,
    })).toEqual({
      type: "notification",
      method: "turn/plan/updated",
      params: { threadId: "thread-1", turnId: "turn-1", plan: [] },
      emittedAtMs: 1_800_000_000_100,
      gatewayReceivedAtMs: 1_800_000_000_125,
    });
  });

  it("drops malformed optional timestamps without rejecting the notification", () => {
    expect(parseServerMessage({
      type: "notification",
      method: "turn/plan/updated",
      params: { plan: [] },
      emittedAtMs: -1,
      gatewayReceivedAtMs: 1.5,
    })).toEqual({
      type: "notification",
      method: "turn/plan/updated",
      params: { plan: [] },
    });
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
