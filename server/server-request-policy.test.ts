// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  assertServerRequestRoutable,
  normalizeServerRequestResponse,
} from "./server-request-policy.js";
import type { RequestMessage } from "./types.js";

function request(method: string, params: unknown = {}): RequestMessage {
  return { type: "request", id: 1, method, params };
}

describe("server request response policy", () => {
  it("turns granular permission grants into an empty turn-scoped grant", () => {
    expect(normalizeServerRequestResponse(
      request("item/permissions/requestApproval"),
      {
        type: "response",
        id: 1,
        result: {
          permissions: { network: { enabled: true } },
          scope: "session",
          strictAutoReview: false,
        },
      },
    )).toEqual({
      result: { permissions: {}, scope: "turn" },
    });
  });

  it("uses complete MCP decline and cancel result shapes", () => {
    expect(normalizeServerRequestResponse(
      request("mcpServer/elicitation/request"),
      { type: "response", id: "mcp-1", error: { code: -32601 } },
    )).toEqual({
      result: { action: "decline", content: null, _meta: null },
    });
    expect(normalizeServerRequestResponse(
      request("mcpServer/elicitation/request"),
      {
        type: "response",
        id: "mcp-2",
        result: { action: "cancel", content: { unsafe: true }, _meta: { unsafe: true } },
      },
    )).toEqual({
      result: { action: "cancel", content: null, _meta: null },
    });
  });

  it("leaves unrelated server request errors unchanged", () => {
    const error = { code: -32601, message: "unsupported" };
    expect(normalizeServerRequestResponse(
      request("item/tool/call"),
      { type: "response", id: 3, error },
    )).toEqual({ error });
  });

  it("rebuilds visible approval decisions and rejects policy amendment objects", () => {
    expect(normalizeServerRequestResponse(
      request("item/commandExecution/requestApproval"),
      { type: "response", id: 1, result: { decision: "acceptForSession", extra: true } },
    )).toEqual({ result: { decision: "acceptForSession" } });

    expect(() => normalizeServerRequestResponse(
      request("item/commandExecution/requestApproval"),
      {
        type: "response",
        id: 1,
        result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git"] } } },
      },
    )).toThrow("approval decision is invalid");
  });

  it("limits modern approval responses to decisions offered by the request", () => {
    const amendmentDecision = {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git"] },
    };
    const limitedRequest = request("item/commandExecution/requestApproval", {
      availableDecisions: [
        "accept",
        amendmentDecision,
        "decline",
      ],
    });

    expect(normalizeServerRequestResponse(
      limitedRequest,
      { type: "response", id: 1, result: { decision: "accept", extra: true } },
    )).toEqual({ result: { decision: "accept" } });
    expect(() => normalizeServerRequestResponse(
      limitedRequest,
      { type: "response", id: 1, result: { decision: "acceptForSession" } },
    )).toThrow("approval decision is invalid");
    expect(() => normalizeServerRequestResponse(
      limitedRequest,
      { type: "response", id: 1, result: { decision: amendmentDecision } },
    )).toThrow("approval decision is invalid");
  });

  it("treats a null available decision list as unspecified", () => {
    expect(normalizeServerRequestResponse(
      request("item/commandExecution/requestApproval", { availableDecisions: null }),
      { type: "response", id: 1, result: { decision: "acceptForSession" } },
    )).toEqual({ result: { decision: "acceptForSession" } });
  });

  it("limits legacy approval responses to decisions offered by the request", () => {
    const limitedRequest = request("applyPatchApproval", {
      availableDecisions: ["approved", "abort"],
    });

    expect(normalizeServerRequestResponse(
      limitedRequest,
      { type: "response", id: "legacy-1", result: { decision: "abort", extra: true } },
    )).toEqual({ result: { decision: "abort" } });
    expect(() => normalizeServerRequestResponse(
      limitedRequest,
      { type: "response", id: "legacy-1", result: { decision: "approved_for_session" } },
    )).toThrow("approval decision is invalid");
    expect(() => normalizeServerRequestResponse(
      limitedRequest,
      { type: "response", id: "legacy-1", result: { decision: "denied" } },
    )).toThrow("approval decision is invalid");
  });

  it("uses only current legacy string decisions when no list is provided", () => {
    const legacyRequest = request("execCommandApproval", { conversationId: "thread-1" });
    expect(normalizeServerRequestResponse(
      legacyRequest,
      { type: "response", id: "legacy-2", result: { decision: "abort" } },
    )).toEqual({ result: { decision: "abort" } });
    expect(() => normalizeServerRequestResponse(
      legacyRequest,
      { type: "response", id: "legacy-2", result: { decision: "denied" } },
    )).toThrow("approval decision is invalid");
  });

  it("rejects approval responses when the upstream request params are malformed", () => {
    expect(() => normalizeServerRequestResponse(
      request("item/commandExecution/requestApproval", null),
      { type: "response", id: 1, result: { decision: "accept" } },
    )).toThrow("approval request params are invalid");
  });

  it("rejects malformed approval requests before routing them to a browser", () => {
    expect(() => assertServerRequestRoutable(
      request("item/commandExecution/requestApproval", null),
    )).toThrow("approval request params are invalid");
    expect(() => assertServerRequestRoutable(request(
      "item/commandExecution/requestApproval",
      { availableDecisions: ["accept", { futureDecision: {} }] },
    ))).toThrow("approval availableDecisions is invalid");
  });

  it.each([
    ["item/fileChange/requestApproval", ["approved"]],
    ["execCommandApproval", ["accept"]],
    ["item/commandExecution/requestApproval", "accept"],
    ["applyPatchApproval", ["approved", 1]],
    ["item/commandExecution/requestApproval", [{ acceptWithExecpolicyAmendment: {} }]],
    ["execCommandApproval", [{ denied: { rejection: 1 } }]],
  ])("rejects malformed available decisions for %s", (method, availableDecisions) => {
    expect(() => normalizeServerRequestResponse(
      request(method, { availableDecisions }),
      { type: "response", id: 1, result: { decision: "decline" } },
    )).toThrow("approval availableDecisions is invalid");
  });

  it("fails closed when an approval request offers no supported decisions", () => {
    expect(() => normalizeServerRequestResponse(
      request("item/commandExecution/requestApproval", {
        availableDecisions: [{
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: "example.com", action: "allow" },
          },
        }],
      }),
      { type: "response", id: 1, result: { decision: "decline" } },
    )).toThrow("approval decision is invalid");
  });

  it("rebuilds answers for exactly the requested questions", () => {
    expect(normalizeServerRequestResponse(
      request("item/tool/requestUserInput", { questions: [{ id: "choice" }] }),
      { type: "response", id: 1, result: { answers: { choice: { answers: ["Yes"] } } } },
    )).toEqual({ result: { answers: { choice: { answers: ["Yes"] } } } });
    expect(() => normalizeServerRequestResponse(
      request("item/tool/requestUserInput", { questions: [{ id: "choice" }] }),
      { type: "response", id: 1, result: { answers: { other: { answers: ["Yes"] } } } },
    )).toThrow("invalid");
  });
});
