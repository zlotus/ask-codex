import { ClientInputError } from "./security.js";
import type { BrowserResponseMessage, RequestMessage } from "./types.js";
import { isRecord } from "./types.js";

export interface NormalizedServerResponse {
  result?: unknown;
  error?: unknown;
}

const MODERN_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const MODERN_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const LEGACY_APPROVAL_METHODS = new Set(["execCommandApproval", "applyPatchApproval"]);
const LEGACY_DECISIONS = new Set([
  "approved",
  "approved_for_session",
  "denied",
  "timed_out",
  "abort",
]);

export function deniedPermissionsResult(): Record<string, unknown> {
  return {
    permissions: {},
    scope: "turn",
  };
}

export function declinedMcpElicitationResult(
  action: "decline" | "cancel" = "decline",
): Record<string, unknown> {
  return {
    action,
    content: null,
    _meta: null,
  };
}

function sanitizedError(value: unknown): { code: number; message: string } {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.code) ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.length > 500
  ) {
    throw new ClientInputError("server request error response is invalid");
  }
  return { code: value.code as number, message: value.message };
}

function decisionResult(value: unknown, allowed: ReadonlySet<string>): { decision: string } {
  if (!isRecord(value) || typeof value.decision !== "string" || !allowed.has(value.decision)) {
    throw new ClientInputError("approval decision is invalid");
  }
  return { decision: value.decision };
}

function userInputResult(value: unknown, requestParams: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.answers)) {
    throw new ClientInputError("request_user_input response is invalid");
  }
  const requestedIds = new Set<string>();
  if (isRecord(requestParams) && Array.isArray(requestParams.questions)) {
    for (const question of requestParams.questions) {
      if (isRecord(question) && typeof question.id === "string") requestedIds.add(question.id);
    }
  }
  const answers: Record<string, { answers: string[] }> = {};
  for (const [id, answer] of Object.entries(value.answers)) {
    if (!requestedIds.has(id) || !isRecord(answer) || !Array.isArray(answer.answers)) {
      throw new ClientInputError("request_user_input response is invalid");
    }
    if (!answer.answers.every((entry) => typeof entry === "string" && entry.length <= 100_000)) {
      throw new ClientInputError("request_user_input answer is invalid");
    }
    answers[id] = { answers: [...answer.answers] as string[] };
  }
  if (requestedIds.size === 0 || Object.keys(answers).length !== requestedIds.size) {
    throw new ClientInputError("request_user_input response is incomplete");
  }
  return { answers };
}

export function normalizeServerRequestResponse(
  request: RequestMessage,
  response: BrowserResponseMessage,
): NormalizedServerResponse {
  if (request.method === "item/permissions/requestApproval") {
    // This client does not offer granular grants. Always fail closed.
    return { result: deniedPermissionsResult() };
  }

  if (request.method === "mcpServer/elicitation/request") {
    const result = response.result;
    const action = isRecord(result) && result.action === "cancel"
      ? "cancel"
      : "decline";
    return { result: declinedMcpElicitationResult(action) };
  }

  if (Object.prototype.hasOwnProperty.call(response, "error")) {
    return { error: sanitizedError(response.error) };
  }
  if (MODERN_APPROVAL_METHODS.has(request.method)) {
    return { result: decisionResult(response.result, MODERN_DECISIONS) };
  }
  if (LEGACY_APPROVAL_METHODS.has(request.method)) {
    return { result: decisionResult(response.result, LEGACY_DECISIONS) };
  }
  if (request.method === "item/tool/requestUserInput") {
    return { result: userInputResult(response.result, request.params) };
  }
  throw new ClientInputError(`unsupported app-server request must be rejected: ${request.method}`);
}
