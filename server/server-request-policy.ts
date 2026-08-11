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
const PERMISSION_DECISIONS = new Set(["accept", "decline"]);
const MCP_ELICITATION_ACTIONS = new Set(["accept", "decline", "cancel"]);
const MAX_PERMISSION_ENTRIES = 128;
const MAX_PERMISSION_STRING_CHARACTERS = 8_192;
const MAX_MCP_FORM_FIELDS = 64;
const MAX_MCP_FIELD_NAME_CHARACTERS = 128;
const MAX_MCP_OPTION_COUNT = 128;
const MAX_MCP_STRING_CHARACTERS = 100_000;

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

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function boundedNonEmptyString(value: unknown, maximum: number, message: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new ClientInputError(message);
  }
  return value;
}

function nullableBoundedStrings(value: unknown, message: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_PERMISSION_ENTRIES) {
    throw new ClientInputError(message);
  }
  return value.map((entry) => boundedNonEmptyString(
    entry,
    MAX_PERMISSION_STRING_CHARACTERS,
    message,
  ));
}

function sanitizedFileSystemSpecialPath(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new ClientInputError("permission filesystem special path is invalid");
  }
  if (["root", "minimal", "tmpdir", "slash_tmp"].includes(value.kind)) {
    if (!hasExactKeys(value, ["kind"])) {
      throw new ClientInputError("permission filesystem special path is invalid");
    }
    return { kind: value.kind };
  }
  if (value.kind === "project_roots") {
    if (
      !hasExactKeys(value, ["kind", "subpath"]) ||
      (value.subpath !== null && typeof value.subpath !== "string")
    ) {
      throw new ClientInputError("permission filesystem special path is invalid");
    }
    return { kind: "project_roots", subpath: value.subpath };
  }
  if (value.kind === "unknown") {
    if (
      !hasExactKeys(value, ["kind", "path", "subpath"]) ||
      (value.subpath !== null && typeof value.subpath !== "string")
    ) {
      throw new ClientInputError("permission filesystem special path is invalid");
    }
    return {
      kind: "unknown",
      path: boundedNonEmptyString(
        value.path,
        MAX_PERMISSION_STRING_CHARACTERS,
        "permission filesystem special path is invalid",
      ),
      subpath: value.subpath,
    };
  }
  throw new ClientInputError("permission filesystem special path is invalid");
}

function sanitizedFileSystemEntry(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["path", "access"]) ||
    !["read", "write", "deny"].includes(String(value.access)) ||
    !isRecord(value.path) ||
    typeof value.path.type !== "string"
  ) {
    throw new ClientInputError("permission filesystem entry is invalid");
  }
  let path: Record<string, unknown>;
  if (value.path.type === "path") {
    if (!hasExactKeys(value.path, ["type", "path"])) {
      throw new ClientInputError("permission filesystem entry is invalid");
    }
    path = {
      type: "path",
      path: boundedNonEmptyString(
        value.path.path,
        MAX_PERMISSION_STRING_CHARACTERS,
        "permission filesystem entry is invalid",
      ),
    };
  } else if (value.path.type === "glob_pattern") {
    if (!hasExactKeys(value.path, ["type", "pattern"])) {
      throw new ClientInputError("permission filesystem entry is invalid");
    }
    path = {
      type: "glob_pattern",
      pattern: boundedNonEmptyString(
        value.path.pattern,
        MAX_PERMISSION_STRING_CHARACTERS,
        "permission filesystem entry is invalid",
      ),
    };
  } else if (value.path.type === "special") {
    if (!hasExactKeys(value.path, ["type", "value"])) {
      throw new ClientInputError("permission filesystem entry is invalid");
    }
    path = { type: "special", value: sanitizedFileSystemSpecialPath(value.path.value) };
  } else {
    throw new ClientInputError("permission filesystem entry is invalid");
  }
  return { path, access: value.access };
}

function requestedPermissionGrant(params: unknown): Record<string, unknown> {
  if (
    !isRecord(params) ||
    typeof params.threadId !== "string" ||
    params.threadId.length === 0 ||
    !isRecord(params.permissions) ||
    !hasOnlyKeys(params.permissions, ["network", "fileSystem"])
  ) {
    throw new ClientInputError("permission request params are invalid");
  }
  const granted: Record<string, unknown> = {};
  const network = params.permissions.network;
  if (network !== null && network !== undefined) {
    if (
      !isRecord(network) ||
      !hasExactKeys(network, ["enabled"]) ||
      (network.enabled !== null && typeof network.enabled !== "boolean")
    ) {
      throw new ClientInputError("permission network request is invalid");
    }
    granted.network = { enabled: network.enabled };
  }
  const fileSystem = params.permissions.fileSystem;
  if (fileSystem !== null && fileSystem !== undefined) {
    if (
      !isRecord(fileSystem) ||
      !hasOnlyKeys(fileSystem, ["read", "write", "globScanMaxDepth", "entries"]) ||
      !Object.hasOwn(fileSystem, "read") ||
      !Object.hasOwn(fileSystem, "write")
    ) {
      throw new ClientInputError("permission filesystem request is invalid");
    }
    const sanitized: Record<string, unknown> = {
      read: nullableBoundedStrings(
        fileSystem.read,
        "permission filesystem read paths are invalid",
      ),
      write: nullableBoundedStrings(
        fileSystem.write,
        "permission filesystem write paths are invalid",
      ),
    };
    if (fileSystem.globScanMaxDepth !== undefined) {
      if (
        !Number.isSafeInteger(fileSystem.globScanMaxDepth) ||
        (fileSystem.globScanMaxDepth as number) < 0 ||
        (fileSystem.globScanMaxDepth as number) > 1_024
      ) {
        throw new ClientInputError("permission filesystem glob depth is invalid");
      }
      sanitized.globScanMaxDepth = fileSystem.globScanMaxDepth;
    }
    if (fileSystem.entries !== undefined) {
      if (!Array.isArray(fileSystem.entries) || fileSystem.entries.length > MAX_PERMISSION_ENTRIES) {
        throw new ClientInputError("permission filesystem entries are invalid");
      }
      sanitized.entries = fileSystem.entries.map(sanitizedFileSystemEntry);
    }
    granted.fileSystem = sanitized;
  }
  return granted;
}

function stringOptions(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MCP_OPTION_COUNT) {
    throw new ClientInputError(message);
  }
  const options = value.map((entry) => boundedNonEmptyString(
    entry,
    MAX_MCP_STRING_CHARACTERS,
    message,
  ));
  if (new Set(options).size !== options.length) throw new ClientInputError(message);
  return options;
}

function mcpConstOptions(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MCP_OPTION_COUNT) {
    throw new ClientInputError(message);
  }
  const options = value.map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["const", "title"])) {
      throw new ClientInputError(message);
    }
    boundedNonEmptyString(entry.title, MAX_MCP_STRING_CHARACTERS, message);
    return boundedNonEmptyString(entry.const, MAX_MCP_STRING_CHARACTERS, message);
  });
  if (new Set(options).size !== options.length) throw new ClientInputError(message);
  return options;
}

function validateMcpFieldSchema(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new ClientInputError("MCP elicitation field schema is invalid");
  }
  const commonKeys = ["type", "title", "description", "default"];
  for (const metadata of [value.title, value.description]) {
    if (metadata !== undefined && (typeof metadata !== "string" || metadata.length > MAX_MCP_STRING_CHARACTERS)) {
      throw new ClientInputError("MCP elicitation field schema is invalid");
    }
  }
  if (value.type === "string") {
    let options: string[] | undefined;
    if (value.oneOf !== undefined) {
      if (!hasOnlyKeys(value, [...commonKeys, "oneOf"])) {
        throw new ClientInputError("MCP elicitation field schema is invalid");
      }
      options = mcpConstOptions(value.oneOf, "MCP elicitation options are invalid");
    } else if (value.enum !== undefined) {
      if (!hasOnlyKeys(value, [...commonKeys, "enum", "enumNames"])) {
        throw new ClientInputError("MCP elicitation field schema is invalid");
      }
      options = stringOptions(value.enum, "MCP elicitation options are invalid");
      if (
        value.enumNames !== undefined &&
        (!Array.isArray(value.enumNames) ||
          value.enumNames.length !== options.length ||
          value.enumNames.some((entry) => (
            typeof entry !== "string" || entry.length > MAX_MCP_STRING_CHARACTERS
          )))
      ) {
        throw new ClientInputError("MCP elicitation option names are invalid");
      }
    } else {
      if (!hasOnlyKeys(value, [...commonKeys, "minLength", "maxLength", "format"])) {
        throw new ClientInputError("MCP elicitation field schema is invalid");
      }
      for (const bound of [value.minLength, value.maxLength]) {
        if (bound !== undefined && (!Number.isSafeInteger(bound) || (bound as number) < 0)) {
          throw new ClientInputError("MCP elicitation string bounds are invalid");
        }
      }
      if (
        typeof value.minLength === "number" &&
        (
          value.minLength > MAX_MCP_STRING_CHARACTERS ||
          (typeof value.maxLength === "number" && value.minLength > value.maxLength)
        )
      ) {
        throw new ClientInputError("MCP elicitation string bounds are invalid");
      }
      if (
        value.format !== undefined &&
        !["email", "uri", "date", "date-time"].includes(String(value.format))
      ) {
        throw new ClientInputError("MCP elicitation string format is invalid");
      }
    }
    if (value.default !== undefined) {
      if (
        typeof value.default !== "string" ||
        value.default.length > MAX_MCP_STRING_CHARACTERS ||
        (options !== undefined && !options.includes(value.default)) ||
        (typeof value.minLength === "number" && value.default.length < value.minLength) ||
        (typeof value.maxLength === "number" && value.default.length > value.maxLength)
      ) {
        throw new ClientInputError("MCP elicitation default is invalid");
      }
    }
    return value;
  }
  if (value.type === "number" || value.type === "integer") {
    if (!hasOnlyKeys(value, [...commonKeys, "minimum", "maximum"])) {
      throw new ClientInputError("MCP elicitation field schema is invalid");
    }
    for (const bound of [value.minimum, value.maximum, value.default]) {
      if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound))) {
        throw new ClientInputError("MCP elicitation number bounds are invalid");
      }
    }
    if (
      (typeof value.minimum === "number" &&
        typeof value.maximum === "number" &&
        value.minimum > value.maximum) ||
      (value.type === "integer" &&
        value.default !== undefined &&
        !Number.isInteger(value.default)) ||
      (typeof value.default === "number" &&
        typeof value.minimum === "number" &&
        value.default < value.minimum) ||
      (typeof value.default === "number" &&
        typeof value.maximum === "number" &&
        value.default > value.maximum)
    ) {
      throw new ClientInputError("MCP elicitation number bounds are invalid");
    }
    return value;
  }
  if (value.type === "boolean") {
    if (!hasOnlyKeys(value, commonKeys) || (value.default !== undefined && typeof value.default !== "boolean")) {
      throw new ClientInputError("MCP elicitation boolean schema is invalid");
    }
    return value;
  }
  if (value.type === "array") {
    if (!hasOnlyKeys(value, [...commonKeys, "minItems", "maxItems", "items"]) || !isRecord(value.items)) {
      throw new ClientInputError("MCP elicitation array schema is invalid");
    }
    let options: string[];
    if (value.items.anyOf !== undefined) {
      if (!hasExactKeys(value.items, ["anyOf"])) {
        throw new ClientInputError("MCP elicitation array options are invalid");
      }
      options = mcpConstOptions(value.items.anyOf, "MCP elicitation array options are invalid");
    } else {
      if (!hasExactKeys(value.items, ["type", "enum"]) || value.items.type !== "string") {
        throw new ClientInputError("MCP elicitation array options are invalid");
      }
      options = stringOptions(value.items.enum, "MCP elicitation array options are invalid");
    }
    for (const bound of [value.minItems, value.maxItems]) {
      if (
        bound !== undefined &&
        (!Number.isSafeInteger(bound) || (bound as number) < 0 || (bound as number) > MAX_MCP_OPTION_COUNT)
      ) {
        throw new ClientInputError("MCP elicitation array bounds are invalid");
      }
    }
    if (
      (typeof value.minItems === "number" && value.minItems > options.length) ||
      (typeof value.minItems === "number" &&
        typeof value.maxItems === "number" &&
        value.minItems > value.maxItems)
    ) {
      throw new ClientInputError("MCP elicitation array bounds are invalid");
    }
    if (
      value.default !== undefined &&
      (!Array.isArray(value.default) ||
        value.default.length > MAX_MCP_OPTION_COUNT ||
        value.default.some((entry) => typeof entry !== "string" || !options.includes(entry)) ||
        new Set(value.default).size !== value.default.length ||
        (typeof value.minItems === "number" && value.default.length < value.minItems) ||
        (typeof value.maxItems === "number" && value.default.length > value.maxItems))
    ) {
      throw new ClientInputError("MCP elicitation default is invalid");
    }
    return value;
  }
  throw new ClientInputError("MCP elicitation field type is unsupported");
}

interface McpFormDefinition {
  properties: Map<string, Record<string, unknown>>;
  required: Set<string>;
}

function mcpFormDefinition(value: unknown): McpFormDefinition {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["$schema", "type", "properties", "required"]) ||
    value.type !== "object" ||
    !isRecord(value.properties)
  ) {
    throw new ClientInputError("MCP elicitation form schema is invalid");
  }
  if (
    value.$schema !== undefined &&
    (typeof value.$schema !== "string" || value.$schema.length > MAX_MCP_STRING_CHARACTERS)
  ) {
    throw new ClientInputError("MCP elicitation form schema is invalid");
  }
  const entries = Object.entries(value.properties);
  if (entries.length > MAX_MCP_FORM_FIELDS) {
    throw new ClientInputError("MCP elicitation form has too many fields");
  }
  const properties = new Map<string, Record<string, unknown>>();
  for (const [name, schema] of entries) {
    boundedNonEmptyString(name, MAX_MCP_FIELD_NAME_CHARACTERS, "MCP elicitation field name is invalid");
    properties.set(name, validateMcpFieldSchema(schema));
  }
  let requiredValues: string[] = [];
  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      value.required.length > MAX_MCP_FORM_FIELDS ||
      value.required.some((entry) => (
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > MAX_MCP_FIELD_NAME_CHARACTERS
      ))
    ) {
      throw new ClientInputError("MCP elicitation required fields are invalid");
    }
    requiredValues = [...value.required] as string[];
    if (new Set(requiredValues).size !== requiredValues.length) {
      throw new ClientInputError("MCP elicitation required fields are invalid");
    }
  }
  if (requiredValues.some((name) => !properties.has(name))) {
    throw new ClientInputError("MCP elicitation required field is unknown");
  }
  return { properties, required: new Set(requiredValues) };
}

function mcpFieldOptions(schema: Record<string, unknown>): string[] | undefined {
  if (schema.oneOf !== undefined) {
    return mcpConstOptions(schema.oneOf, "MCP elicitation options are invalid");
  }
  if (schema.enum !== undefined) {
    return stringOptions(schema.enum, "MCP elicitation options are invalid");
  }
  if (schema.type === "array" && isRecord(schema.items)) {
    return schema.items.anyOf !== undefined
      ? mcpConstOptions(schema.items.anyOf, "MCP elicitation array options are invalid")
      : stringOptions(schema.items.enum, "MCP elicitation array options are invalid");
  }
  return undefined;
}

function sanitizedMcpFieldValue(schema: Record<string, unknown>, value: unknown): unknown {
  if (schema.type === "string") {
    if (typeof value !== "string" || value.length > MAX_MCP_STRING_CHARACTERS) {
      throw new ClientInputError("MCP elicitation string value is invalid");
    }
    const options = mcpFieldOptions(schema);
    if (options && !options.includes(value)) {
      throw new ClientInputError("MCP elicitation option is invalid");
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      throw new ClientInputError("MCP elicitation string value is too short");
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      throw new ClientInputError("MCP elicitation string value is too long");
    }
    return value;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isInteger(value)) ||
      (typeof schema.minimum === "number" && value < schema.minimum) ||
      (typeof schema.maximum === "number" && value > schema.maximum)
    ) {
      throw new ClientInputError("MCP elicitation number value is invalid");
    }
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new ClientInputError("MCP elicitation boolean value is invalid");
    }
    return value;
  }
  if (schema.type === "array") {
    const options = mcpFieldOptions(schema) ?? [];
    if (
      !Array.isArray(value) ||
      value.some((entry) => typeof entry !== "string" || !options.includes(entry)) ||
      new Set(value).size !== value.length ||
      (typeof schema.minItems === "number" && value.length < schema.minItems) ||
      (typeof schema.maxItems === "number" && value.length > schema.maxItems)
    ) {
      throw new ClientInputError("MCP elicitation array value is invalid");
    }
    return [...value];
  }
  throw new ClientInputError("MCP elicitation field type is unsupported");
}

function sanitizedMcpFormContent(schema: unknown, value: unknown): Record<string, unknown> {
  const definition = mcpFormDefinition(schema);
  if (!isRecord(value) || Object.keys(value).some((key) => !definition.properties.has(key))) {
    throw new ClientInputError("MCP elicitation form content is invalid");
  }
  for (const required of definition.required) {
    if (!Object.hasOwn(value, required)) {
      throw new ClientInputError("MCP elicitation form response is incomplete");
    }
  }
  return Object.fromEntries(Object.entries(value).map(([name, fieldValue]) => [
    name,
    sanitizedMcpFieldValue(definition.properties.get(name)!, fieldValue),
  ]));
}

function assertMcpElicitationRequest(params: unknown): void {
  if (
    !isRecord(params) ||
    typeof params.threadId !== "string" ||
    params.threadId.length === 0 ||
    (params.turnId !== undefined && params.turnId !== null && typeof params.turnId !== "string") ||
    (params.serverName !== undefined && (
      typeof params.serverName !== "string" ||
      params.serverName.length > MAX_MCP_STRING_CHARACTERS
    )) ||
    typeof params.mode !== "string" ||
    typeof params.message !== "string" ||
    params.message.length > MAX_MCP_STRING_CHARACTERS
  ) {
    throw new ClientInputError("MCP elicitation request params are invalid");
  }
  if (params.mode === "form") {
    mcpFormDefinition(params.requestedSchema);
    return;
  }
  if (params.mode === "openai/form") {
    return;
  }
  if (params.mode === "url") {
    const url = boundedNonEmptyString(params.url, 8_192, "MCP elicitation URL is invalid");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ClientInputError("MCP elicitation URL is invalid");
    }
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
      throw new ClientInputError("MCP elicitation URL is invalid");
    }
    boundedNonEmptyString(
      params.elicitationId,
      MAX_PERMISSION_STRING_CHARACTERS,
      "MCP elicitation ID is invalid",
    );
    return;
  }
  throw new ClientInputError("MCP elicitation mode is unsupported");
}

function simpleDecision(value: unknown, allowed: ReadonlySet<string>, message: string): string {
  if (!isRecord(value) || typeof value.decision !== "string" || !allowed.has(value.decision)) {
    throw new ClientInputError(message);
  }
  return value.decision;
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
  } else if (request.method === "item/permissions/requestApproval") {
    requestedPermissionGrant(request.params);
  } else if (request.method === "mcpServer/elicitation/request") {
    assertMcpElicitationRequest(request.params);
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
    const decision = simpleDecision(
      response.result,
      PERMISSION_DECISIONS,
      "permission approval decision is invalid",
    );
    return {
      result: decision === "accept"
        ? { permissions: requestedPermissionGrant(request.params), scope: "turn" }
        : deniedPermissionsResult(),
    };
  }

  if (request.method === "mcpServer/elicitation/request") {
    if (Object.prototype.hasOwnProperty.call(response, "error")) {
      return { result: declinedMcpElicitationResult() };
    }
    const result = response.result;
    if (!isRecord(result) || typeof result.action !== "string" || !MCP_ELICITATION_ACTIONS.has(result.action)) {
      throw new ClientInputError("MCP elicitation action is invalid");
    }
    if (result.action === "decline" || result.action === "cancel") {
      return { result: declinedMcpElicitationResult(result.action) };
    }
    assertMcpElicitationRequest(request.params);
    const params = request.params as Record<string, unknown>;
    if (params.mode === "openai/form") {
      throw new ClientInputError("openai/form MCP elicitation cannot be accepted by this client");
    }
    return {
      result: {
        action: "accept",
        content: params.mode === "form"
          ? sanitizedMcpFormContent(params.requestedSchema, result.content)
          : null,
        _meta: null,
      },
    };
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
