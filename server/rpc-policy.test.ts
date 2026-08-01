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
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: [],
      archived: true,
    })).toEqual({
      cursor: "next-thread-page",
      limit: 100,
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: [],
      archived: true,
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

  it("rejects invalid or expanded archived list filters", () => {
    expect(() => sanitizeBrowserRpcParams("thread/list", { archived: "true" }))
      .toThrow("thread/list archived must be a boolean");
    expect(() => sanitizeBrowserRpcParams("thread/list", {
      archived: true,
      includeArchived: true,
    })).toThrow("thread/list does not allow param: includeArchived");
  });

  it.each(["thread/archive", "thread/unarchive", "thread/delete"])(
    "allows %s and rebuilds its thread-only params",
    (method) => {
      const params = { threadId: "thread-1" };

      expect(ALLOWED_BROWSER_RPC_METHODS.has(method)).toBe(true);
      const sanitized = sanitizeBrowserRpcParams(method, params);
      expect(sanitized).toEqual({ threadId: "thread-1" });
      expect(sanitized).not.toBe(params);
    },
  );

  it.each(["thread/archive", "thread/unarchive", "thread/delete"])(
    "rejects invalid or expanded params for %s",
    (method) => {
      expect(() => sanitizeBrowserRpcParams(method, {}))
        .toThrow(`${method} threadId must be a non-empty string`);
      expect(() => sanitizeBrowserRpcParams(method, { threadId: "" }))
        .toThrow(`${method} threadId must be a non-empty string`);
      expect(() => sanitizeBrowserRpcParams(method, { threadId: 1 }))
        .toThrow(`${method} threadId must be a non-empty string`);
      expect(() => sanitizeBrowserRpcParams(method, {
        threadId: "thread-1",
        includeTurns: true,
      })).toThrow(`${method} does not allow param: includeTurns`);
    },
  );

  it("allows a bounded thread name and projects its empty response", () => {
    const params = { threadId: "thread-1", name: "  Project navigation  " };

    expect(ALLOWED_BROWSER_RPC_METHODS.has("thread/name/set")).toBe(true);
    expect(sanitizeBrowserRpcParams("thread/name/set", params)).toEqual({
      threadId: "thread-1",
      name: "Project navigation",
    });
    expect(sanitizeBrowserRpcResult("thread/name/set", {
      token: "must not reach the browser",
    })).toEqual({});
  });

  it.each([
    [{ name: "Name" }, "threadId must be a non-empty string"],
    [{ threadId: "thread-1", name: "   " }, "name must be a bounded single-line string"],
    [{ threadId: "thread-1", name: "line one\nline two" }, "name must be a bounded single-line string"],
    [{ threadId: "thread-1", name: "x".repeat(201) }, "name must be a bounded single-line string"],
    [{ threadId: "thread-1", name: "Name", cwd: "/tmp" }, "does not allow param: cwd"],
  ])("rejects invalid thread name params %#", (params, message) => {
    expect(() => sanitizeBrowserRpcParams("thread/name/set", params)).toThrow(message);
  });

  it("rebuilds thread metadata patches and projects only updated metadata", () => {
    const params = {
      threadId: "thread-1",
      isPinned: true,
    };

    expect(ALLOWED_BROWSER_RPC_METHODS.has("thread/metadata/update")).toBe(true);
    expect(sanitizeBrowserRpcParams("thread/metadata/update", params)).toEqual(params);
    expect(sanitizeBrowserRpcResult("thread/metadata/update", {
      thread: {
        id: "thread-1",
        isPinned: true,
        gitInfo: {
          sha: null,
          branch: "feature/project-navigation",
          originUrl: "git@example.com:private/project.git",
          credential: "secret",
        },
        path: "/private/session.jsonl",
        turns: [{ secret: true }],
      },
      config: { token: "secret" },
    })).toEqual({
      thread: {
        id: "thread-1",
        isPinned: true,
      },
    });
    expect(sanitizeBrowserRpcResult("thread/metadata/update", {
      thread: { id: "thread-1", isPinned: null },
    })).toEqual({ thread: null });
  });

  it.each([
    [{}, "threadId must be a non-empty string"],
    [{ threadId: "thread-1" }, "isPinned must be a boolean"],
    [{ threadId: "thread-1", isPinned: null }, "isPinned must be a boolean"],
    [{ threadId: "thread-1", isPinned: "true" }, "isPinned must be a boolean"],
    [{ threadId: "thread-1", isPinned: true, gitInfo: null }, "does not allow param: gitInfo"],
    [{ threadId: "thread-1", isPinned: true, name: "Expanded" }, "does not allow param: name"],
  ])("rejects invalid thread metadata params %#", (params, message) => {
    expect(() => sanitizeBrowserRpcParams("thread/metadata/update", params)).toThrow(message);
  });

  it("rebuilds a bounded read-only skills request", () => {
    const cwd = process.cwd();
    const params = { cwds: [cwd], forceReload: true };

    expect(ALLOWED_BROWSER_RPC_METHODS.has("skills/list")).toBe(true);
    expect(sanitizeBrowserRpcParams("skills/list", params)).toEqual(params);
    expect(sanitizeBrowserRpcParams("skills/list", {})).toEqual({});
    expect(sanitizeBrowserRpcParams("skills/list", { cwds: [] })).toEqual({ cwds: [] });
  });

  it.each([
    [{ cwds: null }, "cwds must be an array with at most 16 entries"],
    [{ cwds: ["relative/path"] }, "cwds[0] must be a bounded absolute path"],
    [{ cwds: ["/tmp/project", "/tmp/project"] }, "cwds must not contain duplicates"],
    [{ cwds: ["/" + "x".repeat(4_096)] }, "cwds[0] must be a bounded absolute path"],
    [{ cwds: Array.from({ length: 17 }, (_, index) => `/tmp/project-${index}`) }, "at most 16 entries"],
    [{ forceReload: null }, "forceReload must be a boolean"],
    [{ forceReload: "true" }, "forceReload must be a boolean"],
    [{ perCwdExtraUserRoots: [] }, "does not allow param: perCwdExtraUserRoots"],
  ])("rejects unsafe skills/list params %#", (params, message) => {
    expect(() => sanitizeBrowserRpcParams("skills/list", params)).toThrow(message);
  });

  it("projects skills/list to bounded display metadata without host capability details", () => {
    expect(sanitizeBrowserRpcResult("skills/list", {
      data: [{
        cwd: process.cwd(),
        skills: [{
          name: "skill-creator",
          description: "Create or update a Codex skill",
          shortDescription: "Create skills",
          interface: {
            displayName: "Skill Creator",
            shortDescription: "Scaffold a reusable skill",
            brandColor: "#12ab34",
            iconSmall: "/private/icon.svg",
            iconLargeUrl: "https://private.example/icon.png",
            defaultPrompt: "Read private instructions",
          },
          dependencies: {
            tools: [{ type: "shell", command: "private-command", value: "secret" }],
          },
          path: "/private/skills/skill-creator/SKILL.md",
          scope: "repo",
          enabled: true,
          extra: "secret",
        }, {
          name: "legacy-skill",
          description: "Uses legacy metadata",
          shortDescription: "Legacy summary",
          scope: "user",
          enabled: false,
        }, {
          name: "invalid-skill",
          description: "Missing required metadata",
          scope: "unexpected",
          enabled: true,
        }],
        errors: [{
          path: "/private/skills/broken/SKILL.md",
          message: "Could not parse skill metadata",
        }],
        extra: "secret",
      }, {
        cwd: "relative/path",
        skills: [],
        errors: [],
      }],
      token: "secret",
    })).toEqual({
      data: [{
        cwd: process.cwd(),
        skills: [{
          name: "skill-creator",
          description: "Create or update a Codex skill",
          shortDescription: "Scaffold a reusable skill",
          scope: "repo",
          enabled: true,
        }, {
          name: "legacy-skill",
          description: "Uses legacy metadata",
          shortDescription: "Legacy summary",
          scope: "user",
          enabled: false,
        }],
        errorCount: 1,
      }],
    });
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

  it("uses the app-server history default without browser control", () => {
    expect(sanitizeBrowserRpcParams("thread/start", {
      cwd: "/workspace/project",
    })).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      cwd: "/workspace/project",
    });
    for (const historyMode of ["legacy", "paginated"]) {
      expect(() => sanitizeBrowserRpcParams("thread/start", {
        cwd: "/workspace/project",
        historyMode,
      })).toThrow("does not allow param: historyMode");
    }
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
