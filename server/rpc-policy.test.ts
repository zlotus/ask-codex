// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  ALLOWED_BROWSER_RPC_METHODS,
  MESSAGE_QUEUE_BROWSER_RPC_METHODS,
  attachmentIdsFromTurnStart,
  materializeTurnExecutionPolicy,
  materializeTurnStartAttachments,
  normalizeGatewaySandboxPolicy,
  sanitizeBrowserNotificationParams,
  sanitizeBrowserRpcParams,
  sanitizeBrowserRpcResult,
  sanitizeBrowserVisibleValue,
  sanitizeMessageQueueRpcParams,
} from "./rpc-policy.js";

describe("browser RPC policy", () => {
  it("rebuilds the local message queue RPCs without upstream parameters", () => {
    expect([...MESSAGE_QUEUE_BROWSER_RPC_METHODS]).toEqual([
      "messageQueue/list",
      "messageQueue/enqueue",
      "messageQueue/cancel",
      "messageQueue/send",
    ]);
    expect(sanitizeMessageQueueRpcParams("messageQueue/list", {
      threadId: "thread-1",
    })).toEqual({ threadId: "thread-1" });
    expect(sanitizeMessageQueueRpcParams("messageQueue/enqueue", {
      threadId: "thread-1",
      text: "  Continue later  ",
      expectedLastTurnId: "turn-1",
    })).toEqual({
      threadId: "thread-1",
      text: "Continue later",
      expectedLastTurnId: "turn-1",
    });
    expect(sanitizeMessageQueueRpcParams("messageQueue/send", {
      id: "a".repeat(32),
      revision: 3,
      confirmReview: true,
    })).toEqual({ id: "a".repeat(32), revision: 3, confirmReview: true });
  });

  it.each([
    ["messageQueue/enqueue", { threadId: "thread-1", text: "", expectedLastTurnId: null }],
    ["messageQueue/enqueue", { threadId: "thread-1", text: "send", expectedLastTurnId: null, cwd: "/tmp" }],
    ["messageQueue/enqueue", { threadId: "thread-1", text: "send", expectedLastTurnId: null, model: "private" }],
    ["messageQueue/send", { id: "short", revision: 1 }],
    ["messageQueue/send", { id: "a".repeat(32), revision: 0 }],
    ["messageQueue/send", { id: "a".repeat(32), revision: 1, confirmReview: "yes" }],
    ["messageQueue/cancel", { id: "a".repeat(32), revision: 1, threadId: "thread-1" }],
  ])("rejects unsafe local queue params for %s %#", (method, params) => {
    expect(() => sanitizeMessageQueueRpcParams(method, params)).toThrow();
  });

  it("exposes a minimal fork request and fixes approval ownership settings", () => {
    expect(ALLOWED_BROWSER_RPC_METHODS.has("thread/fork")).toBe(true);
    expect(sanitizeBrowserRpcParams("thread/fork", {
      threadId: "thread-source",
    })).toEqual({
      threadId: "thread-source",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      excludeTurns: true,
    });

    for (const unsupported of [
      { path: "/private/rollout.jsonl" },
      { cwd: "/private" },
      { lastTurnId: "turn-1" },
      { model: "private-model" },
      { approvalPolicy: "never" },
      { excludeTurns: false },
    ]) {
      expect(() => sanitizeBrowserRpcParams("thread/fork", {
        threadId: "thread-source",
        ...unsupported,
      })).toThrow(/does not allow param/);
    }
  });

  it("strictly projects a fork result without rollout or instruction paths", () => {
    const result = sanitizeBrowserRpcResult("thread/fork", {
      thread: {
        id: "thread-fork",
        forkedFromId: "thread-source",
        cwd: "/workspace/project",
        historyMode: "paginated",
        turns: [],
        name: "Forked work",
        preview: "Continue here",
        status: { type: "idle" },
        path: "/private/rollout.jsonl",
        extra: { secret: true },
      },
      model: "gpt-5",
      cwd: "/workspace/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: ["/private/root"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      reasoningEffort: "high",
      instructionSources: ["/private/AGENTS.md"],
      runtimeWorkspaceRoots: ["/private/root"],
    }, { threadId: "thread-source" });

    expect(result).toEqual({
      thread: {
        id: "thread-fork",
        forkedFromId: "thread-source",
        cwd: "/workspace/project",
        historyMode: "paginated",
        turns: [],
        name: "Forked work",
        preview: "Continue here",
        status: { type: "idle" },
      },
      model: "gpt-5",
      cwd: "/workspace/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite" },
      reasoningEffort: "high",
    });
    expect(JSON.stringify(result)).not.toMatch(/rollout|instruction|writableRoots|secret/);
  });

  it.each([
    ["same thread id", { id: "thread-source", forkedFromId: "thread-source" }],
    ["wrong source", { id: "thread-fork", forkedFromId: "thread-other" }],
    ["unknown history", { id: "thread-fork", forkedFromId: "thread-source", historyMode: "future" }],
  ])("rejects a fork result with %s", (_label, threadOverride) => {
    expect(() => sanitizeBrowserRpcResult("thread/fork", {
      thread: Object.assign({
        id: "thread-fork",
        forkedFromId: "thread-source",
        cwd: "/workspace/project",
        historyMode: "legacy",
        turns: [],
      }, threadOverride),
      model: "gpt-5",
      cwd: "/workspace/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "readOnly" },
    }, { threadId: "thread-source" })).toThrow("thread/fork returned an invalid result");
  });

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

  it.each(["account/rateLimits/read", "account/usage/read"])(
    "allows only empty browser params for %s and rebuilds them as no params",
    (method) => {
      expect(ALLOWED_BROWSER_RPC_METHODS.has(method)).toBe(true);
      expect(sanitizeBrowserRpcParams(method, {})).toBeUndefined();
      expect(() => sanitizeBrowserRpcParams(method, null))
        .toThrow(`${method} params must be an object`);
      expect(() => sanitizeBrowserRpcParams(method, { refreshToken: true }))
        .toThrow(`${method} does not allow param: refreshToken`);
      expect(() => sanitizeBrowserRpcParams(method, { accountId: "private" }))
        .toThrow(`${method} does not allow param: accountId`);
    },
  );

  it("projects account/read without exposing account identity", () => {
    const result = sanitizeBrowserRpcResult("account/read", {
      account: {
        type: "chatgpt",
        email: "private@example.com",
        planType: "plus",
        accountId: "private-account-id",
      },
      requiresOpenaiAuth: true,
      token: "secret",
    });

    expect(result).toEqual({
      account: { type: "chatgpt", planType: "plus" },
      requiresOpenaiAuth: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|email|accountId/i);
    expect(sanitizeBrowserRpcResult("account/read", {
      account: { type: "chatgpt", email: "private@example.com", planType: "invalid" },
      requiresOpenaiAuth: "true",
    })).toEqual({ account: null, requiresOpenaiAuth: false });
  });

  it("projects account usage to JSON-safe summary values and bounded daily buckets", () => {
    const result = sanitizeBrowserRpcResult("account/usage/read", {
      summary: {
        lifetimeTokens: 1_234_567n,
        peakDailyTokens: 56_789,
        longestRunningTurnSec: -1,
        currentStreakDays: 3.5,
        longestStreakDays: Number.MAX_SAFE_INTEGER,
        email: "private@example.com",
      },
      dailyUsageBuckets: [
        { startDate: "2026-08-01", tokens: 42n, accountId: "private-account" },
        { startDate: "2026-08-02", tokens: 0 },
        { startDate: "2026-02-29", tokens: 12 },
        { startDate: "2026-08-03", tokens: Number.MAX_SAFE_INTEGER + 1 },
        { startDate: "secret", tokens: 7 },
      ],
      account: { email: "private@example.com" },
      token: "secret",
    });

    expect(result).toEqual({
      summary: {
        lifetimeTokens: 1_234_567,
        peakDailyTokens: 56_789,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: Number.MAX_SAFE_INTEGER,
      },
      dailyUsageBuckets: [
        { startDate: "2026-08-01", tokens: 42 },
        { startDate: "2026-08-02", tokens: 0 },
      ],
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(JSON.stringify(result)).not.toMatch(/private|secret|email/i);
  });

  it("bounds account usage collections and fails closed for malformed big integers", () => {
    const result = sanitizeBrowserRpcResult("account/usage/read", {
      summary: {
        lifetimeTokens: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        peakDailyTokens: Infinity,
      },
      dailyUsageBuckets: Array.from({ length: 405 }, (_, index) => ({
        startDate: "2026-08-01",
        tokens: BigInt(index),
      })),
    }) as { dailyUsageBuckets: unknown[] };

    expect(result).toMatchObject({
      summary: {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
    });
    expect(result.dailyUsageBuckets).toHaveLength(366);
    expect(result.dailyUsageBuckets.at(0)).toEqual({ startDate: "2026-08-01", tokens: 39 });
    expect(result.dailyUsageBuckets.at(-1)).toEqual({ startDate: "2026-08-01", tokens: 404 });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(sanitizeBrowserRpcResult("account/usage/read", null)).toEqual({
      summary: {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsageBuckets: null,
    });
  });

  it("projects account rate limits without identity or reset-credit details", () => {
    const snapshot = {
      limitId: "codex",
      limitName: "Codex",
      primary: {
        usedPercent: 72.5,
        windowDurationMins: 300,
        resetsAt: 1_800_000_000,
        extra: "secret",
      },
      secondary: null,
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: "12.50",
        email: "private@example.com",
      },
      individualLimit: {
        limit: "100.00",
        used: "25.50",
        remainingPercent: 74.5,
        resetsAt: 1_800_000_001,
        description: "private workspace",
      },
      spendControlReached: false,
      planType: "plus",
      rateLimitReachedType: "rate_limit_reached",
      account: { email: "private@example.com" },
    };
    const expectedSnapshot = {
      limitId: "codex",
      limitName: "Codex",
      primary: {
        usedPercent: 72.5,
        windowDurationMins: 300,
        resetsAt: 1_800_000_000,
      },
      secondary: null,
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: "12.50",
      },
      individualLimit: {
        limit: "100.00",
        used: "25.50",
        remainingPercent: 74.5,
        resetsAt: 1_800_000_001,
      },
      spendControlReached: false,
      planType: "plus",
      rateLimitReachedType: "rate_limit_reached",
    };

    const result = sanitizeBrowserRpcResult("account/rateLimits/read", {
      rateLimits: snapshot,
      rateLimitsByLimitId: { codex: snapshot },
      rateLimitResetCredits: {
        availableCount: 2n,
        credits: [{
          id: "opaque-private-id",
          title: "Private title",
          description: "Private description",
        }],
      },
      account: { id: "private", email: "private@example.com" },
      token: "secret",
    });

    expect(result).toEqual({
      rateLimits: expectedSnapshot,
      rateLimitsByLimitId: { codex: expectedSnapshot },
      rateLimitResetCredits: { availableCount: 2 },
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(JSON.stringify(result)).not.toMatch(/private|secret|opaque|email|description/i);
  });

  it("bounds rate-limit buckets and drops malformed or unsafe values", () => {
    const rateLimitsByLimitId = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`bucket-${index}`, {}]),
    );
    Object.assign(rateLimitsByLimitId, {
      "private@example.com": { limitId: "private@example.com" },
    });
    const result = sanitizeBrowserRpcResult("account/rateLimits/read", {
      rateLimits: {
        limitId: "private@example.com",
        limitName: "x".repeat(257),
        primary: {
          usedPercent: 101,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
        secondary: {
          usedPercent: 50,
          resetsAt: null,
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: "10 USD",
        },
        individualLimit: {
          limit: "9007199254740992",
          used: "1",
          remainingPercent: -1,
          resetsAt: 1,
        },
        spendControlReached: "false",
        planType: "private-plan",
        rateLimitReachedType: "private-reason",
      },
      rateLimitsByLimitId,
      rateLimitResetCredits: {
        availableCount: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        credits: [{ id: "opaque-private-id" }],
      },
    }) as { rateLimitsByLimitId: Record<string, unknown> };

    expect(result).toMatchObject({
      rateLimits: {
        limitId: null,
        limitName: null,
        primary: null,
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: null,
        rateLimitReachedType: null,
      },
      rateLimitResetCredits: null,
    });
    expect(Object.keys(result.rateLimitsByLimitId)).toHaveLength(32);
    expect(result.rateLimitsByLimitId).not.toHaveProperty("private@example.com");
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(sanitizeBrowserRpcResult("account/rateLimits/read", null)).toEqual({
      rateLimits: null,
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    });
  });

  it("strictly projects sparse rate-limit updates without inventing absent fields", () => {
    const result = sanitizeBrowserNotificationParams("account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 73,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
          description: "private window",
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: "8.50",
          email: "private@example.com",
        },
        planType: null,
        rateLimitReachedType: "rate_limit_reached",
        email: "private@example.com",
        accountId: "private-account-id",
        resetCredit: {
          id: "opaque-private-id",
          description: "secret reset credit",
        },
      },
      email: "private@example.com",
      description: "secret account metadata",
    });

    expect(result).toEqual({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 73,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: "8.50",
        },
        planType: null,
        rateLimitReachedType: "rate_limit_reached",
      },
    });
    expect(result).not.toHaveProperty("rateLimits.limitName");
    expect(result).not.toHaveProperty("rateLimits.secondary");
    expect(result).not.toHaveProperty("rateLimits.individualLimit");
    expect(result).not.toHaveProperty("rateLimits.spendControlReached");
    expect(JSON.stringify(result)).not.toMatch(/private|secret|opaque|email|description/i);
  });

  it("preserves valid fields inside sparse rate-limit windows", () => {
    expect(sanitizeBrowserNotificationParams("account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 75,
          description: "private window",
        },
        secondary: {
          resetsAt: null,
          accountId: "private-account-id",
        },
      },
    })).toEqual({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 75 },
        secondary: { resetsAt: null },
      },
    });
  });

  it("drops malformed rate-limit update fields instead of synthesizing a snapshot", () => {
    expect(sanitizeBrowserNotificationParams("account/rateLimits/updated", {
      rateLimits: {
        limitId: "private@example.com",
        primary: { usedPercent: 101 },
        planType: "private-plan",
        unknown: "secret",
      },
    })).toEqual({});
    expect(sanitizeBrowserNotificationParams("account/rateLimits/updated", null)).toEqual({});
  });

  it("removes local image paths at any nesting depth without stripping ordinary paths", () => {
    expect(sanitizeBrowserVisibleValue({
      path: "/workspace/project",
      askCodexFileDownloads: [{
        href: "/private/spoofed.txt",
        capabilityId: "a".repeat(32),
      }],
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
      executionMode: "manual",
    });
  });

  it("defaults direct turns to manual mode and allows one explicit auto mode", () => {
    const input = [{ type: "text", text: "Continue", text_elements: [] }];

    expect(sanitizeBrowserRpcParams("turn/start", {
      threadId: "thread-1",
      input,
    })).toEqual({
      threadId: "thread-1",
      input,
      executionMode: "manual",
    });
    expect(sanitizeBrowserRpcParams("turn/start", {
      threadId: "thread-1",
      input,
      executionMode: "auto",
    })).toEqual({
      threadId: "thread-1",
      input,
      executionMode: "auto",
    });
  });

  it.each([
    [{ executionMode: "automatic" }, "executionMode must be manual or auto"],
    [{ executionMode: { mode: "auto" } }, "executionMode must be manual or auto"],
    [{ approvalPolicy: "on-request" }, "does not allow param: approvalPolicy"],
    [{ approvalsReviewer: "user" }, "does not allow param: approvalsReviewer"],
    [{ sandboxPolicy: { type: "readOnly", networkAccess: false } }, "does not allow param: sandboxPolicy"],
    [{ sandbox: "workspace-write" }, "does not allow param: sandbox"],
    [{ writableRoots: ["/workspace/private"] }, "does not allow param: writableRoots"],
    [{ networkAccess: true }, "does not allow param: networkAccess"],
  ])("rejects an unsupported turn execution-policy override %#", (override, message) => {
    expect(() => sanitizeBrowserRpcParams("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Continue", text_elements: [] }],
      ...override,
    })).toThrow(message);
  });

  it("materializes manual and auto execution policies from authoritative sandbox state", () => {
    const params = {
      threadId: "thread-1",
      input: [{ type: "text", text: "Continue", text_elements: [] }],
      executionMode: "manual",
    };
    const workspaceWrite = {
      type: "workspaceWrite" as const,
      writableRoots: ["/workspace/shared"],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: false,
    };
    const authority = { current: workspaceWrite, workspaceWrite };

    expect(materializeTurnExecutionPolicy(params, authority)).toEqual({
      threadId: "thread-1",
      input: params.input,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(materializeTurnExecutionPolicy({ ...params, executionMode: "auto" }, authority))
      .toEqual({
        threadId: "thread-1",
        input: params.input,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: workspaceWrite,
      });
    expect(materializeTurnExecutionPolicy({ ...params, executionMode: "auto" }, {
      current: { type: "readOnly", networkAccess: false },
    })).toEqual({
      threadId: "thread-1",
      input: params.input,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });

  it("keeps full access and external sandboxes independent from execution mode", () => {
    const params = {
      threadId: "thread-1",
      input: [{ type: "text", text: "Continue", text_elements: [] }],
      executionMode: "manual",
    };
    expect(materializeTurnExecutionPolicy(params, {
      current: { type: "dangerFullAccess" },
    })).toEqual(expect.objectContaining({
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    }));
    const external = materializeTurnExecutionPolicy(params, {
      current: { type: "externalSandbox", networkAccess: "restricted" },
    });
    expect(external).toEqual(expect.objectContaining({
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
    }));
    expect(external).not.toHaveProperty("sandboxPolicy");
    expect(() => materializeTurnExecutionPolicy({ ...params, executionMode: "auto" }, {
      current: { type: "dangerFullAccess" },
    })).toThrow("auto mode is unavailable for dangerFullAccess");
    expect(() => materializeTurnExecutionPolicy({ ...params, executionMode: "auto" }, {
      current: { type: "externalSandbox", networkAccess: "restricted" },
    })).toThrow("auto mode is unavailable for externalSandbox");
  });

  it("strictly normalizes app-server sandbox policies", () => {
    expect(normalizeGatewaySandboxPolicy({
      type: "workspaceWrite",
      writableRoots: ["/workspace/shared"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: true,
      futureField: "ignored",
    })).toEqual({
      type: "workspaceWrite",
      writableRoots: ["/workspace/shared"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: true,
    });
    expect(normalizeGatewaySandboxPolicy({ type: "workspaceWrite" })).toBeNull();
    expect(normalizeGatewaySandboxPolicy({
      type: "externalSandbox",
      networkAccess: false,
    })).toBeNull();
  });

  it("projects only the sandbox type to the browser", () => {
    const sandbox = {
      type: "workspaceWrite",
      writableRoots: ["/workspace/private-root"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
    expect(sanitizeBrowserRpcResult("thread/resume", {
      thread: { id: "thread-1" },
      sandbox,
    })).toEqual({
      thread: { id: "thread-1" },
      sandbox: { type: "workspaceWrite" },
    });
    expect(sanitizeBrowserNotificationParams("thread/settings/updated", {
      threadId: "thread-1",
      threadSettings: { sandboxPolicy: sandbox, model: "gpt-5" },
    })).toEqual({
      threadId: "thread-1",
      threadSettings: {
        sandboxPolicy: { type: "workspaceWrite" },
        model: "gpt-5",
      },
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
    expect(materializeTurnStartAttachments(sanitized, [
      {
        kind: "image",
        mediaType: "image/png",
        path: "/private/first.png",
        size: 100,
      },
      {
        kind: "image",
        mediaType: "image/webp",
        path: "/private/second.webp",
        size: 200,
      },
    ]))
      .toEqual({
        threadId: "thread-1",
        executionMode: "manual",
        input: [
          { type: "localImage", path: "/private/first.png", detail: "high" },
          { type: "text", text: "Compare these images", text_elements: [] },
          { type: "localImage", path: "/private/second.webp" },
        ],
      });
  });

  it("materializes uploaded files as a durable marker plus gateway-owned application context", () => {
    const attachmentId = "f".repeat(32);
    const sanitized = sanitizeBrowserRpcParams("turn/start", {
      threadId: "thread-1",
      input: [
        { type: "text", text: "Inspect the report", text_elements: [] },
        { type: "file", attachmentId },
      ],
    });
    const materialized = materializeTurnStartAttachments(sanitized, [{
      kind: "file",
      mediaType: "application/pdf",
      name: "report.pdf",
      path: "/private/server/report.pdf",
      size: 2048,
    }]) as Record<string, unknown>;
    const markerText = "Attached file: report.pdf";

    expect(attachmentIdsFromTurnStart(sanitized)).toEqual([attachmentId]);
    expect(materialized.input).toEqual([
      { type: "text", text: "Inspect the report", text_elements: [] },
      {
        type: "text",
        text: markerText,
        text_elements: [{
          byteRange: { start: 0, end: Buffer.byteLength(markerText) },
          placeholder: JSON.stringify({
            type: "askCodexFile",
            name: "report.pdf",
            mediaType: "application/pdf",
            size: 2048,
          }),
        }],
      },
    ]);
    expect(materialized.additionalContext).toEqual({
      "ask-codex.uploaded-files": {
        kind: "application",
        value: expect.stringContaining(JSON.stringify([{
          name: "report.pdf",
          path: "/private/server/report.pdf",
        }])),
      },
    });
    expect(() => materializeTurnStartAttachments(sanitized, [{
      kind: "image",
      mediaType: "image/png",
      path: "/private/server/wrong.png",
      size: 10,
    }])).toThrow("metadata does not match");
  });

  it.each([
    [
      [{ type: "localImage", path: "/tmp/browser-path.png" }],
      "does not allow param: path",
    ],
    [
      [{ type: "file", attachmentId: "f".repeat(32), path: "/tmp/browser-file.pdf" }],
      "does not allow param: path",
    ],
    [
      [{ type: "image", url: "https://example.com/image.png" }],
      "must be text or an uploaded attachment",
    ],
    [
      [{ type: "remoteImage", url: "https://example.com/image.png" }],
      "must be text or an uploaded attachment",
    ],
    [
      [{ type: "localAudio", path: "/tmp/audio.wav" }],
      "must be text or an uploaded attachment",
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
      "allows at most 4 attachments",
    ],
  ])("rejects unsafe uploaded attachment input %#", (input, message) => {
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

  it("rebuilds bounded text-only steering input and projects its matching turn id", () => {
    const params = {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{
        type: "text",
        text: "Check the focused test first",
        text_elements: [{
          byteRange: { start: 10, end: 17 },
          placeholder: "focused",
        }],
      }],
    };

    expect(ALLOWED_BROWSER_RPC_METHODS.has("turn/steer")).toBe(true);
    const sanitized = sanitizeBrowserRpcParams("turn/steer", params);
    expect(sanitized).toEqual(params);
    expect(sanitized).not.toBe(params);
    expect(sanitizeBrowserRpcResult("turn/steer", {
      turnId: "turn-1",
      privateMetadata: "must not reach the browser",
    }, sanitized)).toEqual({ turnId: "turn-1" });
  });

  it.each([
    [null, "params must be an object"],
    [
      { expectedTurnId: "turn-1", input: [{ type: "text", text: "Continue" }] },
      "threadId must be a non-empty string",
    ],
    [
      { threadId: "thread-1", input: [{ type: "text", text: "Continue" }] },
      "expectedTurnId must be a non-empty string",
    ],
    [
      { threadId: "thread-1", expectedTurnId: "turn-1", input: [] },
      "input must be a non-empty array",
    ],
    [
      { threadId: "thread-1", expectedTurnId: "turn-1", input: "Continue" },
      "input must be a non-empty array",
    ],
    [
      {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [
          { type: "text", text: "First" },
          { type: "text", text: "Second" },
        ],
      },
      "input must contain exactly one text item",
    ],
    [
      {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "   " }],
      },
      "input[0].text must be a non-empty string",
    ],
    [
      {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "localImage", path: "/private/image.png" }],
      },
      "input[0] must be text",
    ],
    [
      {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Continue", path: "/private/file" }],
      },
      "does not allow param: path",
    ],
    [
      {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{
          type: "text",
          text: "Continue",
          text_elements: [{ byteRange: { start: 0, end: 8 }, placeholder: null, path: "/tmp" }],
        }],
      },
      "does not allow param: path",
    ],
    [
      {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Continue" }],
        additionalContext: { private: { text: "secret" } },
      },
      "does not allow param: additionalContext",
    ],
    [
      {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Continue" }],
        clientUserMessageId: "browser-chosen-id",
      },
      "does not allow param: clientUserMessageId",
    ],
  ])("rejects unsafe turn/steer params %#", (params, message) => {
    expect(() => sanitizeBrowserRpcParams("turn/steer", params)).toThrow(message);
  });

  it.each([
    [undefined, { turnId: "turn-1" }],
    [{ threadId: "thread-1", expectedTurnId: "turn-1", input: [] }, null],
    [{ threadId: "thread-1", expectedTurnId: "turn-1", input: [] }, {}],
    [{ threadId: "thread-1", expectedTurnId: "turn-1", input: [] }, { turnId: "" }],
    [{ threadId: "thread-1", expectedTurnId: "turn-1", input: [] }, { turnId: 1 }],
    [{ threadId: "thread-1", expectedTurnId: "turn-1", input: [] }, { turnId: "turn-2" }],
  ])("fails closed for an invalid or mismatched turn/steer result %#", (params, result) => {
    expect(() => sanitizeBrowserRpcResult("turn/steer", result, params))
      .toThrow("Codex app-server returned an invalid turn/steer result");
  });
});
