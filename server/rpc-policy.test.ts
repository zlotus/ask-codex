// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  ALLOWED_BROWSER_RPC_METHODS,
  attachmentIdsFromTurnStart,
  materializeTurnStartAttachments,
  sanitizeBrowserRpcParams,
  sanitizeBrowserRpcResult,
  sanitizeBrowserVisibleValue,
} from "./rpc-policy.js";

describe("browser RPC policy", () => {
  it("preserves opaque pagination cursors for list methods", () => {
    expect(sanitizeBrowserRpcParams("thread/list", {
      cursor: "next-thread-page",
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: [],
    })).toEqual({
      cursor: "next-thread-page",
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: [],
    });
    expect(sanitizeBrowserRpcParams("model/list", {
      cursor: "next-model-page",
      limit: 100,
    })).toEqual({ cursor: "next-model-page", limit: 100 });
  });

  it("still rejects unrecognized list parameters", () => {
    expect(() => sanitizeBrowserRpcParams("thread/list", { config: {} }))
      .toThrow("does not allow param: config");
  });

  it("allows a parameter-free effective model settings read", () => {
    expect(ALLOWED_BROWSER_RPC_METHODS.has("config/read")).toBe(true);
    expect(sanitizeBrowserRpcParams("config/read", {})).toEqual({ includeLayers: false });
    expect(() => sanitizeBrowserRpcParams("config/read", { includeLayers: true }))
      .toThrow("does not allow param: includeLayers");
    expect(() => sanitizeBrowserRpcParams("config/read", { cwd: "/workspace/project" }))
      .toThrow("does not allow param: cwd");
  });

  it("projects config/read results to bounded model settings only", () => {
    expect(sanitizeBrowserRpcResult("config/read", {
      config: {
        model: "gpt-configured",
        model_reasoning_effort: "max",
        instructions: "must not reach the browser",
        mcp_servers: { private: { token: "secret" } },
      },
      layers: [{ name: "user" }],
    })).toEqual({ model: "gpt-configured", effort: "max" });
    expect(sanitizeBrowserRpcResult("config/read", {
      config: {
        model: "x".repeat(513),
        model_reasoning_effort: false,
      },
    })).toEqual({ model: null, effort: null });
  });

  it("removes local image paths at any nesting depth without stripping ordinary paths", () => {
    expect(sanitizeBrowserVisibleValue({
      path: "/workspace/project",
      nested: {
        image: {
          type: "localImage",
          path: "/private/nested.png",
          detail: "high",
        },
      },
      entries: [
        { type: "file", path: "/workspace/keep.txt" },
        [{ type: "localImage", path: "/private/array.webp" }],
      ],
    })).toEqual({
      path: "/workspace/project",
      nested: {
        image: {
          type: "localImage",
          detail: "high",
        },
      },
      entries: [
        { type: "file", path: "/workspace/keep.txt" },
        [{ type: "localImage" }],
      ],
    });
  });

  it("allows bounded turn pagination with explicit item detail", () => {
    expect(ALLOWED_BROWSER_RPC_METHODS.has("thread/turns/list")).toBe(true);
    expect(sanitizeBrowserRpcParams("thread/turns/list", {
      threadId: "thread-1",
      cursor: "next-turn-page",
      limit: 25,
      sortDirection: "desc",
      itemsView: "full",
    })).toEqual({
      threadId: "thread-1",
      cursor: "next-turn-page",
      limit: 25,
      sortDirection: "desc",
      itemsView: "full",
    });

    expect(sanitizeBrowserRpcParams("thread/turns/list", {
      threadId: "thread-1",
      cursor: null,
      limit: null,
      sortDirection: null,
      itemsView: null,
    })).toEqual({
      threadId: "thread-1",
      cursor: null,
      limit: null,
      sortDirection: null,
      itemsView: null,
    });
  });

  it("allows bounded item pagination for one explicit turn", () => {
    expect(ALLOWED_BROWSER_RPC_METHODS.has("thread/items/list")).toBe(true);
    expect(sanitizeBrowserRpcParams("thread/items/list", {
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "next-item-page",
      limit: 100,
      sortDirection: "asc",
    })).toEqual({
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "next-item-page",
      limit: 100,
      sortDirection: "asc",
    });

    expect(sanitizeBrowserRpcParams("thread/items/list", {
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "",
      limit: null,
      sortDirection: "desc",
    })).toEqual({
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "",
      limit: null,
      sortDirection: "desc",
    });

    expect(sanitizeBrowserRpcParams("thread/items/list", {
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: null,
    })).toEqual({
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: null,
    });
  });

  it("allows resume to exclude turns or request an initial turn page", () => {
    expect(sanitizeBrowserRpcParams("thread/resume", {
      threadId: "thread-1",
      excludeTurns: true,
      initialTurnsPage: {
        limit: 25,
        sortDirection: "desc",
        itemsView: "full",
      },
    })).toEqual({
      threadId: "thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      excludeTurns: true,
      initialTurnsPage: {
        limit: 25,
        sortDirection: "desc",
        itemsView: "full",
      },
    });

    expect(sanitizeBrowserRpcParams("thread/resume", {
      threadId: "thread-1",
      initialTurnsPage: null,
    })).toEqual({
      threadId: "thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      initialTurnsPage: null,
    });
  });

  it("enforces paginated history for new threads without browser control", () => {
    expect(sanitizeBrowserRpcParams("thread/start", {
      cwd: "/workspace/project",
    })).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      historyMode: "paginated",
      cwd: "/workspace/project",
    });
    expect(() => sanitizeBrowserRpcParams("thread/start", {
      cwd: "/workspace/project",
      historyMode: "legacy",
    })).toThrow("does not allow param: historyMode");
  });

  it.each([
    ["thread/start", { approvalPolicy: "never" }, "approvalPolicy must be on-request"],
    ["thread/start", { approvalsReviewer: "model" }, "approvalsReviewer must be user"],
    [
      "thread/resume",
      { threadId: "thread-1", approvalPolicy: "never" },
      "approvalPolicy must be on-request",
    ],
    [
      "thread/resume",
      { threadId: "thread-1", approvalsReviewer: "model" },
      "approvalsReviewer must be user",
    ],
  ])("rejects unsafe thread policy override for %s", (method, params, message) => {
    expect(() => sanitizeBrowserRpcParams(method, params)).toThrow(message);
  });

  it.each([
    [{ threadId: "", limit: 25 }, "threadId must be a non-empty string"],
    [{ threadId: "thread-1", cursor: 1 }, "cursor must be a string or null"],
    [{ threadId: "thread-1", limit: 0 }, "limit must be an integer between 1 and 1000"],
    [{ threadId: "thread-1", limit: 1.5 }, "limit must be an integer between 1 and 1000"],
    [{ threadId: "thread-1", limit: 1_001 }, "limit must be an integer between 1 and 1000"],
    [{ threadId: "thread-1", sortDirection: "newest" }, "sortDirection is invalid"],
    [{ threadId: "thread-1", itemsView: "raw" }, "itemsView is invalid"],
    [{ threadId: "thread-1", includeTurns: true }, "does not allow param: includeTurns"],
  ])("rejects invalid turn pagination params %#", (params, message) => {
    expect(() => sanitizeBrowserRpcParams("thread/turns/list", params)).toThrow(message);
  });

  it.each([
    [{ turnId: "turn-1" }, "threadId must be a non-empty string"],
    [{ threadId: "", turnId: "turn-1" }, "threadId must be a non-empty string"],
    [{ threadId: "thread-1" }, "turnId must be a non-empty string"],
    [{ threadId: "thread-1", turnId: null }, "turnId must be a non-empty string"],
    [{ threadId: "thread-1", turnId: "" }, "turnId must be a non-empty string"],
    [{ threadId: "thread-1", turnId: "turn-1", cursor: 1 }, "cursor must be a string or null"],
    [{ threadId: "thread-1", turnId: "turn-1", limit: 0 }, "limit must be an integer between 1 and 100"],
    [{ threadId: "thread-1", turnId: "turn-1", limit: 1.5 }, "limit must be an integer between 1 and 100"],
    [{ threadId: "thread-1", turnId: "turn-1", limit: 101 }, "limit must be an integer between 1 and 100"],
    [{ threadId: "thread-1", turnId: "turn-1", sortDirection: "newest" }, "sortDirection is invalid"],
    [{ threadId: "thread-1", turnId: "turn-1", itemsView: "full" }, "does not allow param: itemsView"],
    [{ threadId: "thread-1", turnId: "turn-1", includeTurns: true }, "does not allow param: includeTurns"],
  ])("rejects invalid item pagination params %#", (params, message) => {
    expect(() => sanitizeBrowserRpcParams("thread/items/list", params)).toThrow(message);
  });

  it.each([
    [{ threadId: "thread-1", excludeTurns: null }, "excludeTurns must be a boolean"],
    [{ threadId: "thread-1", initialTurnsPage: [] }, "params must be an object"],
    [{ threadId: "thread-1", initialTurnsPage: { cursor: "page" } }, "does not allow param: cursor"],
    [{ threadId: "thread-1", initialTurnsPage: { limit: -1 } }, "limit must be an integer between 1 and 1000"],
    [{ threadId: "thread-1", initialTurnsPage: { sortDirection: "newest" } }, "sortDirection is invalid"],
    [{ threadId: "thread-1", initialTurnsPage: { itemsView: "raw" } }, "itemsView is invalid"],
    [{ threadId: "thread-1", initialTurnsPage: {}, history: [] }, "does not allow param: history"],
  ])("rejects invalid resume pagination params %#", (params, message) => {
    expect(() => sanitizeBrowserRpcParams("thread/resume", params)).toThrow(message);
  });

  it("treats null turn settings as absent rather than a reset", () => {
    expect(sanitizeBrowserRpcParams("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Continue", text_elements: [] }],
      cwd: "/workspace/project",
      model: null,
      effort: null,
    })).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Continue", text_elements: [] }],
      cwd: "/workspace/project",
    });
  });

  it("rebuilds ordered text and uploaded-image input without accepting browser paths", () => {
    const firstId = "a".repeat(32);
    const secondId = "b".repeat(32);
    const sanitized = sanitizeBrowserRpcParams("turn/start", {
      threadId: "thread-1",
      input: [
        { type: "localImage", attachmentId: firstId, detail: "high" },
        { type: "text", text: "Compare these images", text_elements: [] },
        { type: "localImage", attachmentId: secondId },
      ],
    });

    expect(attachmentIdsFromTurnStart(sanitized)).toEqual([firstId, secondId]);
    expect(materializeTurnStartAttachments(sanitized, ["/private/first.png", "/private/second.webp"]))
      .toEqual({
        threadId: "thread-1",
        input: [
          { type: "localImage", path: "/private/first.png", detail: "high" },
          { type: "text", text: "Compare these images", text_elements: [] },
          { type: "localImage", path: "/private/second.webp" },
        ],
      });
  });

  it.each([
    [
      [{ type: "localImage", path: "/tmp/browser-path.png" }],
      "does not allow param: path",
    ],
    [
      [{ type: "image", url: "https://example.com/image.png" }],
      "must be text or an uploaded image",
    ],
    [
      [{ type: "remoteImage", url: "https://example.com/image.png" }],
      "must be text or an uploaded image",
    ],
    [
      [{ type: "localAudio", path: "/tmp/audio.wav" }],
      "must be text or an uploaded image",
    ],
    [
      [{ type: "localImage", attachmentId: "too-short" }],
      "attachmentId is invalid",
    ],
    [
      [{ type: "localImage", attachmentId: "a".repeat(32), detail: "maximum" }],
      "detail is invalid",
    ],
    [
      [
        { type: "localImage", attachmentId: "a".repeat(32) },
        { type: "localImage", attachmentId: "a".repeat(32) },
      ],
      "duplicate attachmentId",
    ],
    [
      Array.from({ length: 5 }, (_, index) => ({
        type: "localImage",
        attachmentId: String(index).repeat(32),
      })),
      "allows at most 4 images",
    ],
  ])("rejects unsafe uploaded-image input %#", (input, message) => {
    expect(() => sanitizeBrowserRpcParams("turn/start", {
      threadId: "thread-1",
      input,
    })).toThrow(message);
  });

  it.each([
    ["model", 7],
    ["effort", false],
  ])("rejects a non-string turn %s override", (field, value) => {
    expect(() => sanitizeBrowserRpcParams("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Continue", text_elements: [] }],
      [field]: value,
    })).toThrow(`turn/start ${field} must be a string`);
  });
});
