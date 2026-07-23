import { ClientInputError } from "./security.js";
import { isRecord } from "./types.js";

export const ALLOWED_BROWSER_RPC_METHODS: ReadonlySet<string> = new Set([
  "thread/list",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/turns/list",
  "turn/start",
  "turn/interrupt",
  "model/list",
  "config/read",
  "account/read",
]);

const MAX_CONFIG_VALUE_CHARACTERS = 512;

const SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const SORT_KEYS = new Set(["created_at", "updated_at", "recency_at"]);
const SORT_DIRECTIONS = new Set(["asc", "desc"]);
const TURN_ITEMS_VIEWS = new Set(["notLoaded", "summary", "full"]);
const SOURCE_KINDS = new Set([
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);

function paramsObject(method: string, params: unknown): Record<string, unknown> {
  if (!isRecord(params)) {
    throw new ClientInputError(`${method} params must be an object`);
  }
  return params;
}

function assertOnlyKeys(
  method: string,
  params: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(params).find((key) => !allowedSet.has(key));
  if (unsupported) {
    throw new ClientInputError(`${method} does not allow param: ${unsupported}`);
  }
}

function requiredString(
  method: string,
  params: Record<string, unknown>,
  key: string,
): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ClientInputError(`${method} ${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  method: string,
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ClientInputError(`${method} ${key} must be a string`);
  }
  return value;
}

function optionalBoolean(
  method: string,
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ClientInputError(`${method} ${key} must be a boolean`);
  }
  return value;
}

function optionalLimit(
  method: string,
  params: Record<string, unknown>,
): number | undefined {
  const value = params.limit;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1_000) {
    throw new ClientInputError(`${method} limit must be an integer between 1 and 1000`);
  }
  return value as number;
}

function optionalNullableLimit(
  method: string,
  params: Record<string, unknown>,
): number | null | undefined {
  if (params.limit === null) {
    return null;
  }
  return optionalLimit(method, params);
}

function optionalNullableEnum(
  method: string,
  params: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
): string | null | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new ClientInputError(`${method} ${key} is invalid`);
  }
  return value;
}

function assignDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function sanitizeThreadList(params: unknown): Record<string, unknown> {
  const method = "thread/list";
  const input = paramsObject(method, params);
  assertOnlyKeys(method, input, [
    "cursor",
    "limit",
    "sortKey",
    "sortDirection",
    "sourceKinds",
    "searchTerm",
  ]);
  const output: Record<string, unknown> = {};
  assignDefined(output, "cursor", optionalString(method, input, "cursor"));
  assignDefined(output, "limit", optionalLimit(method, input));

  const sortKey = optionalString(method, input, "sortKey");
  if (sortKey !== undefined && !SORT_KEYS.has(sortKey)) {
    throw new ClientInputError(`${method} sortKey is invalid`);
  }
  assignDefined(output, "sortKey", sortKey);

  const sortDirection = optionalString(method, input, "sortDirection");
  if (sortDirection !== undefined && !SORT_DIRECTIONS.has(sortDirection)) {
    throw new ClientInputError(`${method} sortDirection is invalid`);
  }
  assignDefined(output, "sortDirection", sortDirection);

  if (input.sourceKinds !== undefined && input.sourceKinds !== null) {
    if (
      !Array.isArray(input.sourceKinds) ||
      !input.sourceKinds.every((kind) => typeof kind === "string" && SOURCE_KINDS.has(kind))
    ) {
      throw new ClientInputError(`${method} sourceKinds is invalid`);
    }
    output.sourceKinds = [...input.sourceKinds];
  }
  assignDefined(output, "searchTerm", optionalString(method, input, "searchTerm"));
  return output;
}

function sanitizeTurnPageOptions(
  method: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  assignDefined(output, "limit", optionalNullableLimit(method, input));
  assignDefined(
    output,
    "sortDirection",
    optionalNullableEnum(method, input, "sortDirection", SORT_DIRECTIONS),
  );
  assignDefined(
    output,
    "itemsView",
    optionalNullableEnum(method, input, "itemsView", TURN_ITEMS_VIEWS),
  );
  return output;
}

function sanitizeThreadTurnsList(params: unknown): Record<string, unknown> {
  const method = "thread/turns/list";
  const input = paramsObject(method, params);
  assertOnlyKeys(method, input, [
    "threadId",
    "cursor",
    "limit",
    "sortDirection",
    "itemsView",
  ]);

  const output: Record<string, unknown> = {
    threadId: requiredString(method, input, "threadId"),
    ...sanitizeTurnPageOptions(method, input),
  };
  const cursor = input.cursor;
  if (cursor !== undefined) {
    if (cursor !== null && typeof cursor !== "string") {
      throw new ClientInputError(`${method} cursor must be a string or null`);
    }
    output.cursor = cursor;
  }
  return output;
}

function sanitizeInitialTurnsPage(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }

  const method = "thread/resume initialTurnsPage";
  const input = paramsObject(method, value);
  assertOnlyKeys(method, input, ["limit", "sortDirection", "itemsView"]);
  return sanitizeTurnPageOptions(method, input);
}

function sanitizeThreadSettings(
  method: "thread/start" | "thread/resume",
  params: unknown,
): Record<string, unknown> {
  const input = paramsObject(method, params);
  const allowed = method === "thread/resume"
    ? [
        "threadId",
        "cwd",
        "model",
        "sandbox",
        "approvalPolicy",
        "approvalsReviewer",
        "excludeTurns",
        "initialTurnsPage",
      ]
    : ["cwd", "model", "sandbox", "approvalPolicy", "approvalsReviewer"];
  assertOnlyKeys(method, input, allowed);

  if (input.approvalPolicy !== undefined && input.approvalPolicy !== "on-request") {
    throw new ClientInputError(`${method} approvalPolicy must be on-request`);
  }
  if (input.approvalsReviewer !== undefined && input.approvalsReviewer !== "user") {
    throw new ClientInputError(`${method} approvalsReviewer must be user`);
  }

  const output: Record<string, unknown> = {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  };
  if (method === "thread/resume") {
    output.threadId = requiredString(method, input, "threadId");
    if (input.excludeTurns !== undefined) {
      if (typeof input.excludeTurns !== "boolean") {
        throw new ClientInputError(`${method} excludeTurns must be a boolean`);
      }
      output.excludeTurns = input.excludeTurns;
    }
    assignDefined(
      output,
      "initialTurnsPage",
      sanitizeInitialTurnsPage(input.initialTurnsPage),
    );
  }
  assignDefined(output, "cwd", optionalString(method, input, "cwd"));
  assignDefined(output, "model", optionalString(method, input, "model"));

  const sandbox = optionalString(method, input, "sandbox");
  if (sandbox !== undefined && !SANDBOX_MODES.has(sandbox)) {
    throw new ClientInputError(`${method} sandbox is invalid`);
  }
  assignDefined(output, "sandbox", sandbox);
  return output;
}

function sanitizeTextElements(method: string, value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ClientInputError(`${method} text_elements must be an array`);
  }
  return value.map((element, index) => {
    if (!isRecord(element)) {
      throw new ClientInputError(`${method} text_elements[${index}] must be an object`);
    }
    assertOnlyKeys(method, element, ["byteRange", "placeholder"]);
    if (!isRecord(element.byteRange)) {
      throw new ClientInputError(`${method} text_elements[${index}].byteRange is invalid`);
    }
    assertOnlyKeys(method, element.byteRange, ["start", "end"]);
    const { start, end } = element.byteRange;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      (start as number) < 0 ||
      (end as number) < (start as number)
    ) {
      throw new ClientInputError(`${method} text_elements[${index}].byteRange is invalid`);
    }
    if (element.placeholder !== null && typeof element.placeholder !== "string") {
      throw new ClientInputError(`${method} text_elements[${index}].placeholder is invalid`);
    }
    return {
      byteRange: { start, end },
      placeholder: element.placeholder,
    };
  });
}

function sanitizeTurnStart(params: unknown): Record<string, unknown> {
  const method = "turn/start";
  const input = paramsObject(method, params);
  assertOnlyKeys(method, input, ["threadId", "input", "cwd", "model", "effort"]);
  if (!Array.isArray(input.input) || input.input.length === 0) {
    throw new ClientInputError(`${method} input must be a non-empty array`);
  }

  const sanitizedInput = input.input.map((item, index) => {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
      throw new ClientInputError(`${method} input[${index}] must be text input`);
    }
    assertOnlyKeys(method, item, ["type", "text", "text_elements"]);
    return {
      type: "text",
      text: item.text,
      text_elements: sanitizeTextElements(method, item.text_elements),
    };
  });

  const output: Record<string, unknown> = {
    threadId: requiredString(method, input, "threadId"),
    input: sanitizedInput,
  };
  assignDefined(output, "cwd", optionalString(method, input, "cwd"));
  assignDefined(output, "model", optionalString(method, input, "model"));
  assignDefined(output, "effort", optionalString(method, input, "effort"));
  return output;
}

export function sanitizeBrowserRpcParams(method: string, params: unknown): unknown {
  switch (method) {
    case "thread/list":
      return sanitizeThreadList(params);
    case "thread/start":
    case "thread/resume":
      return sanitizeThreadSettings(method, params);
    case "thread/read": {
      const input = paramsObject(method, params);
      assertOnlyKeys(method, input, ["threadId", "includeTurns"]);
      const output: Record<string, unknown> = {
        threadId: requiredString(method, input, "threadId"),
      };
      assignDefined(output, "includeTurns", optionalBoolean(method, input, "includeTurns"));
      return output;
    }
    case "thread/turns/list":
      return sanitizeThreadTurnsList(params);
    case "turn/start":
      return sanitizeTurnStart(params);
    case "turn/interrupt": {
      const input = paramsObject(method, params);
      assertOnlyKeys(method, input, ["threadId", "turnId"]);
      return {
        threadId: requiredString(method, input, "threadId"),
        turnId: requiredString(method, input, "turnId"),
      };
    }
    case "model/list": {
      const input = paramsObject(method, params);
      assertOnlyKeys(method, input, ["cursor", "limit", "includeHidden"]);
      const output: Record<string, unknown> = {};
      assignDefined(output, "cursor", optionalString(method, input, "cursor"));
      assignDefined(output, "limit", optionalLimit(method, input));
      assignDefined(output, "includeHidden", optionalBoolean(method, input, "includeHidden"));
      return output;
    }
    case "config/read": {
      const input = paramsObject(method, params);
      assertOnlyKeys(method, input, []);
      return { includeLayers: false };
    }
    case "account/read": {
      const input = paramsObject(method, params);
      assertOnlyKeys(method, input, ["refreshToken"]);
      const output: Record<string, unknown> = {};
      assignDefined(output, "refreshToken", optionalBoolean(method, input, "refreshToken"));
      return output;
    }
    default:
      throw new ClientInputError(`${method} has no browser RPC policy`);
  }
}

function configuredValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_CONFIG_VALUE_CHARACTERS ? trimmed : null;
}

export function sanitizeBrowserRpcResult(method: string, result: unknown): unknown {
  if (method !== "config/read") return result;
  const config = isRecord(result) && isRecord(result.config) ? result.config : {};
  return {
    model: configuredValue(config.model),
    effort: configuredValue(config.model_reasoning_effort),
  };
}
