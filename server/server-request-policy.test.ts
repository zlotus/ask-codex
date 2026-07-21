// @vitest-environment node

import { describe, expect, it } from "vitest";

import { normalizeServerRequestResponse } from "./server-request-policy.js";
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
