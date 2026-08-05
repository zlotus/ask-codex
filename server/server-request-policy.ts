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

type ApprovalDecisionValidator = (value: unknown) => boolean;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => (
    Object.prototype.hasOwnProperty.call(value, key)
  ));
}

function isExecPolicyAmendmentDecision(
  value: unknown,
  decisionKey: string,
  amendmentKey: string,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [decisionKey])) return false;
  const decision = value[decisionKey];
  if (!isRecord(decision) || !hasExactKeys(decision, [amendmentKey])) return false;
  const amendment = decision[amendmentKey];
  return Array.isArray(amendment) && amendment.every((entry) => typeof entry === "string");
}

function isNetworkPolicyAmendmentDecision(value: unknown, decisionKey: string): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [decisionKey])) return false;
  const decision = value[decisionKey];
  if (!isRecord(decision) || !hasExactKeys(decision, ["network_policy_amendment"])) return false;
  const amendment = decision.network_policy_amendment;
  return isRecord(amendment) &&
    hasExactKeys(amendment, ["host", "action"]) &&
    typeof amendment.host === "string" &&
    (amendment.action === "allow" || amendment.action === "deny");
}

function isModernCommandDecision(value: unknown): boolean {
  return (typeof value === "string" && MODERN_DECISIONS.has(value)) ||
    isExecPolicyAmendmentDecision(
      value,
      "acceptWithExecpolicyAmendment",
      "execpolicy_amendment",
    ) ||
    isNetworkPolicyAmendmentDecision(value, "applyNetworkPolicyAmendment");
}

function isModernFileDecision(value: unknown): boolean {
  return typeof value === "string" && MODERN_DECISIONS.has(value);
}

function isLegacyDecision(value: unknown): boolean {
  if (typeof value === "string") return LEGACY_DECISIONS.has(value);
  if (
    isExecPolicyAmendmentDecision(
      value,
      "approved_execpolicy_amendment",
      "proposed_execpolicy_amendment",
    ) ||
    isNetworkPolicyAmendmentDecision(value, "network_policy_amendment")
  ) {
    return true;
  }
  if (!isRecord(value) || !hasExactKeys(value, ["denied"])) return false;
  const denied = value.denied;
  return isRecord(denied) &&
    hasExactKeys(denied, ["rejection"]) &&
    typeof denied.rejection === "string";
}

function requestApprovalDecisions(
  requestParams: unknown,
  protocolDecisions: ReadonlySet<string>,
  isProtocolDecision: ApprovalDecisionValidator,
): ReadonlySet<string> {
  if (!isRecord(requestParams)) {
    throw new ClientInputError("approval request params are invalid");
  }
  if (!Object.prototype.hasOwnProperty.call(requestParams, "availableDecisions")) {
    return protocolDecisions;
  }

  const availableDecisions = requestParams.availableDecisions;
  if (availableDecisions === null) return protocolDecisions;
  if (
    !Array.isArray(availableDecisions) ||
    !availableDecisions.every(isProtocolDecision)
  ) {
    throw new ClientInputError("approval availableDecisions is invalid");
  }
  return new Set(availableDecisions.filter((decision): decision is string => (
    typeof decision === "string" && protocolDecisions.has(decision)
  )));
}

export function assertServerRequestRoutable(request: RequestMessage): void {
  if (MODERN_APPROVAL_METHODS.has(request.method)) {
    requestApprovalDecisions(
      request.params,
      MODERN_DECISIONS,
      request.method === "item/commandExecution/requestApproval"
        ? isModernCommandDecision
        : isModernFileDecision,
    );
  } else if (LEGACY_APPROVAL_METHODS.has(request.method)) {
    requestApprovalDecisions(request.params, LEGACY_DECISIONS, isLegacyDecision);
  }
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
    return {
      result: decisionResult(
        response.result,
        requestApprovalDecisions(
          request.params,
          MODERN_DECISIONS,
          request.method === "item/commandExecution/requestApproval"
            ? isModernCommandDecision
            : isModernFileDecision,
        ),
      ),
    };
  }
  if (LEGACY_APPROVAL_METHODS.has(request.method)) {
    return {
      result: decisionResult(
        response.result,
        requestApprovalDecisions(request.params, LEGACY_DECISIONS, isLegacyDecision),
      ),
    };
  }
  if (request.method === "item/tool/requestUserInput") {
    return { result: userInputResult(response.result, request.params) };
  }
  throw new ClientInputError(`unsupported app-server request must be rejected: ${request.method}`);
}
