import { isAbsolute } from "node:path";

import { ClientInputError } from "./security.js";
import { isRecord } from "./types.js";

export const ALLOWED_BROWSER_RPC_METHODS: ReadonlySet<string> = new Set([
  "thread/list",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/archive",
  "thread/unarchive",
  "thread/delete",
  "thread/name/set",
  "thread/metadata/update",
  "thread/turns/list",
  "thread/items/list",
  "skills/list",
  "turn/start",
  "turn/interrupt",
  "model/list",
  "config/read",
  "account/read",
  "account/rateLimits/read",
  "account/usage/read",
]);

const MAX_CONFIG_VALUE_CHARACTERS = 512;
const MAX_LOCAL_IMAGES_PER_TURN = 4;
const MAX_THREAD_ID_CHARACTERS = 256;
const MAX_THREAD_NAME_CHARACTERS = 200;
const MAX_SKILLS_CWDS = 16;
const MAX_SKILLS_CWD_CHARACTERS = 4_096;
const MAX_SKILLS_PER_CWD = 256;
const MAX_SKILL_NAME_CHARACTERS = 256;
const MAX_SKILL_DESCRIPTION_CHARACTERS = 4_096;
const MAX_SKILL_SHORT_DESCRIPTION_CHARACTERS = 512;
const MAX_ACCOUNT_USAGE_DAILY_BUCKETS = 366;
const MAX_RATE_LIMIT_BUCKETS = 32;
const MAX_RATE_LIMIT_ID_CHARACTERS = 128;
const MAX_RATE_LIMIT_NAME_CHARACTERS = 256;
const MAX_DECIMAL_CHARACTERS = 64;
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

const SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const SORT_KEYS = new Set(["created_at", "updated_at", "recency_at"]);
const SORT_DIRECTIONS = new Set(["asc", "desc"]);
const TURN_ITEMS_VIEWS = new Set(["notLoaded", "summary", "full"]);
const IMAGE_DETAILS = new Set(["auto", "low", "high", "original"]);
const SKILL_SCOPES = new Set(["user", "repo", "system", "admin"]);
const PLAN_TYPES = new Set([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown",
]);
const RATE_LIMIT_REACHED_TYPES = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);
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

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function requiredBoundedString(
  method: string,
  params: Record<string, unknown>,
  key: string,
  maximum: number,
  trim = false,
): string {
  const value = requiredString(method, params, key);
  const normalized = trim ? value.trim() : value;
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    containsControlCharacters(normalized) ||
    (!trim && normalized.trim() !== normalized)
  ) {
    throw new ClientInputError(
      `${method} ${key} must be a bounded single-line string`,
    );
  }
  return normalized;
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
  maximum = 1_000,
): number | undefined {
  const value = params.limit;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new ClientInputError(
      `${method} limit must be an integer between 1 and ${maximum}`,
    );
  }
  return value as number;
}

function optionalNullableLimit(
  method: string,
  params: Record<string, unknown>,
  maximum = 1_000,
): number | null | undefined {
  if (params.limit === null) {
    return null;
  }
  return optionalLimit(method, params, maximum);
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
    "archived",
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
  assignDefined(output, "archived", optionalBoolean(method, input, "archived"));
  return output;
}

function sanitizeThreadNameSet(params: unknown): Record<string, unknown> {
  const method = "thread/name/set";
  const input = paramsObject(method, params);
  assertOnlyKeys(method, input, ["threadId", "name"]);
  return {
    threadId: requiredBoundedString(
      method,
      input,
      "threadId",
      MAX_THREAD_ID_CHARACTERS,
    ),
    name: requiredBoundedString(
      method,
      input,
      "name",
      MAX_THREAD_NAME_CHARACTERS,
      true,
    ),
  };
}

function sanitizeThreadMetadataUpdate(params: unknown): Record<string, unknown> {
  const method = "thread/metadata/update";
  const input = paramsObject(method, params);
  assertOnlyKeys(method, input, ["threadId", "isPinned"]);
  const threadId = requiredBoundedString(
    method,
    input,
    "threadId",
    MAX_THREAD_ID_CHARACTERS,
  );
  if (typeof input.isPinned !== "boolean") {
    throw new ClientInputError(`${method} isPinned must be a boolean`);
  }
  return {
    threadId,
    isPinned: input.isPinned,
  };
}

function sanitizeSkillsList(params: unknown): Record<string, unknown> {
  const method = "skills/list";
  const input = paramsObject(method, params);
  assertOnlyKeys(method, input, ["cwds", "forceReload"]);
  const output: Record<string, unknown> = {};

  if (input.cwds !== undefined) {
    if (!Array.isArray(input.cwds) || input.cwds.length > MAX_SKILLS_CWDS) {
      throw new ClientInputError(
        `${method} cwds must be an array with at most ${MAX_SKILLS_CWDS} entries`,
      );
    }
    const seen = new Set<string>();
    output.cwds = input.cwds.map((cwd, index) => {
      if (
        typeof cwd !== "string" ||
        cwd.length === 0 ||
        cwd.length > MAX_SKILLS_CWD_CHARACTERS ||
        cwd.trim() !== cwd ||
        containsControlCharacters(cwd) ||
        !isAbsolute(cwd)
      ) {
        throw new ClientInputError(
          `${method} cwds[${index}] must be a bounded absolute path`,
        );
      }
      if (seen.has(cwd)) {
        throw new ClientInputError(`${method} cwds must not contain duplicates`);
      }
      seen.add(cwd);
      return cwd;
    });
  }

  if (input.forceReload !== undefined) {
    if (typeof input.forceReload !== "boolean") {
      throw new ClientInputError(`${method} forceReload must be a boolean`);
    }
    output.forceReload = input.forceReload;
  }
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

function sanitizeThreadItemsList(params: unknown): Record<string, unknown> {
  const method = "thread/items/list";
  const input = paramsObject(method, params);
  assertOnlyKeys(method, input, [
    "threadId",
    "turnId",
    "cursor",
    "limit",
    "sortDirection",
  ]);

  const output: Record<string, unknown> = {
    threadId: requiredString(method, input, "threadId"),
    turnId: requiredString(method, input, "turnId"),
  };
  const cursor = input.cursor;
  if (cursor !== undefined) {
    if (cursor !== null && typeof cursor !== "string") {
      throw new ClientInputError(`${method} cursor must be a string or null`);
    }
    output.cursor = cursor;
  }
  assignDefined(output, "limit", optionalNullableLimit(method, input, 100));
  assignDefined(
    output,
    "sortDirection",
    optionalNullableEnum(method, input, "sortDirection", SORT_DIRECTIONS),
  );
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

  let imageCount = 0;
  const attachmentIds = new Set<string>();
  const sanitizedInput = input.input.map((item, index) => {
    if (!isRecord(item)) {
      throw new ClientInputError(`${method} input[${index}] must be an object`);
    }
    if (item.type === "text") {
      if (typeof item.text !== "string") {
        throw new ClientInputError(`${method} input[${index}].text must be a string`);
      }
      assertOnlyKeys(method, item, ["type", "text", "text_elements"]);
      return {
        type: "text",
        text: item.text,
        text_elements: sanitizeTextElements(method, item.text_elements),
      };
    }
    if (item.type !== "localImage") {
      throw new ClientInputError(`${method} input[${index}] must be text or an uploaded image`);
    }
    assertOnlyKeys(method, item, ["type", "attachmentId", "detail"]);
    const attachmentId = requiredString(method, item, "attachmentId");
    if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
      throw new ClientInputError(`${method} input[${index}].attachmentId is invalid`);
    }
    if (attachmentIds.has(attachmentId)) {
      throw new ClientInputError(`${method} input contains a duplicate attachmentId`);
    }
    attachmentIds.add(attachmentId);
    imageCount += 1;
    if (imageCount > MAX_LOCAL_IMAGES_PER_TURN) {
      throw new ClientInputError(
        `${method} input allows at most ${MAX_LOCAL_IMAGES_PER_TURN} images`,
      );
    }
    const detail = optionalString(method, item, "detail");
    if (detail !== undefined && !IMAGE_DETAILS.has(detail)) {
      throw new ClientInputError(`${method} input[${index}].detail is invalid`);
    }
    return {
      type: "localImage",
      attachmentId,
      ...(detail === undefined ? {} : { detail }),
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

export function attachmentIdsFromTurnStart(params: unknown): string[] {
  if (!isRecord(params) || !Array.isArray(params.input)) return [];
  return params.input.flatMap((item) => (
    isRecord(item) && item.type === "localImage" && typeof item.attachmentId === "string"
      ? [item.attachmentId]
      : []
  ));
}

export function materializeTurnStartAttachments(
  params: unknown,
  paths: readonly string[],
): unknown {
  if (!isRecord(params) || !Array.isArray(params.input)) {
    throw new Error("Cannot materialize attachments for invalid turn/start params");
  }
  let pathIndex = 0;
  const turnInput = params.input.map((item) => {
    if (!isRecord(item) || item.type !== "localImage") return item;
    const path = paths[pathIndex];
    pathIndex += 1;
    if (path === undefined) {
      throw new Error("Attachment path count does not match turn/start input");
    }
    return {
      type: "localImage",
      path,
      ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
    };
  });
  if (pathIndex !== paths.length) {
    throw new Error("Attachment path count does not match turn/start input");
  }
  return { ...params, input: turnInput };
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
    case "thread/archive":
    case "thread/unarchive":
    case "thread/delete": {
      const input = paramsObject(method, params);
      assertOnlyKeys(method, input, ["threadId"]);
      return {
        threadId: requiredString(method, input, "threadId"),
      };
    }
    case "thread/name/set":
      return sanitizeThreadNameSet(params);
    case "thread/metadata/update":
      return sanitizeThreadMetadataUpdate(params);
    case "thread/turns/list":
      return sanitizeThreadTurnsList(params);
    case "thread/items/list":
      return sanitizeThreadItemsList(params);
    case "skills/list":
      return sanitizeSkillsList(params);
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
    case "account/rateLimits/read":
    case "account/usage/read": {
      const input = paramsObject(method, params);
      assertOnlyKeys(method, input, []);
      return undefined;
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

function projectedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || containsControlCharacters(trimmed)) return undefined;
  return trimmed.slice(0, maximum);
}

function projectThreadMetadataUpdateResult(result: unknown): Record<string, unknown> {
  const thread = isRecord(result) && isRecord(result.thread) ? result.thread : null;
  const id = projectedString(thread?.id, MAX_THREAD_ID_CHARACTERS);
  if (!thread || !id || typeof thread.isPinned !== "boolean") {
    return { thread: null };
  }
  return { thread: { id, isPinned: thread.isPinned } };
}

function projectSkill(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const name = projectedString(value.name, MAX_SKILL_NAME_CHARACTERS);
  const description = projectedString(
    value.description,
    MAX_SKILL_DESCRIPTION_CHARACTERS,
  );
  const skillInterface = isRecord(value.interface) ? value.interface : null;
  const shortDescription = projectedString(
    skillInterface?.shortDescription,
    MAX_SKILL_SHORT_DESCRIPTION_CHARACTERS,
  ) ?? projectedString(
    value.shortDescription,
    MAX_SKILL_SHORT_DESCRIPTION_CHARACTERS,
  );
  if (
    !name ||
    !description ||
    typeof value.enabled !== "boolean" ||
    typeof value.scope !== "string" ||
    !SKILL_SCOPES.has(value.scope)
  ) {
    return null;
  }
  const output: Record<string, unknown> = {
    name,
    description,
    scope: value.scope,
    enabled: value.enabled,
  };
  assignDefined(output, "shortDescription", shortDescription);
  return output;
}

function projectSkillsListResult(result: unknown): Record<string, unknown> {
  const data = isRecord(result) && Array.isArray(result.data) ? result.data : [];
  return {
    data: data.slice(0, MAX_SKILLS_CWDS).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const cwd = projectedString(entry.cwd, MAX_SKILLS_CWD_CHARACTERS);
      if (!cwd || !isAbsolute(cwd)) return [];
      const skills = Array.isArray(entry.skills)
        ? entry.skills
            .slice(0, MAX_SKILLS_PER_CWD)
            .map(projectSkill)
            .filter((skill): skill is Record<string, unknown> => skill !== null)
        : [];
      const errorCount = Array.isArray(entry.errors) ? entry.errors.length : 0;
      return [{ cwd, skills, errorCount }];
    }),
  };
}

function projectedNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function projectedPercentage(value: unknown): number | null {
  return typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 100
    ? value
    : null;
}

function projectedBoundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 &&
      trimmed.length <= maximum &&
      !containsControlCharacters(trimmed)
    ? trimmed
    : null;
}

function projectedRateLimitId(value: unknown): string | null {
  const projected = projectedBoundedString(value, MAX_RATE_LIMIT_ID_CHARACTERS);
  return projected && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(projected)
    ? projected
    : null;
}

function projectedDecimalString(value: unknown): string | null {
  const projected = projectedBoundedString(value, MAX_DECIMAL_CHARACTERS);
  if (!projected || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(projected)) return null;
  const numeric = Number(projected);
  return Number.isFinite(numeric) && numeric <= Number.MAX_SAFE_INTEGER
    ? projected
    : null;
}

function projectedUsageDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth ? value : null;
}

function projectAccountUsageResult(result: unknown): Record<string, unknown> {
  const summary = isRecord(result) && isRecord(result.summary) ? result.summary : {};
  const dailyUsageBuckets = isRecord(result) ? result.dailyUsageBuckets : null;
  return {
    summary: {
      lifetimeTokens: projectedNonNegativeInteger(summary.lifetimeTokens),
      peakDailyTokens: projectedNonNegativeInteger(summary.peakDailyTokens),
      longestRunningTurnSec: projectedNonNegativeInteger(summary.longestRunningTurnSec),
      currentStreakDays: projectedNonNegativeInteger(summary.currentStreakDays),
      longestStreakDays: projectedNonNegativeInteger(summary.longestStreakDays),
    },
    dailyUsageBuckets: Array.isArray(dailyUsageBuckets)
      ? dailyUsageBuckets
          .slice(-MAX_ACCOUNT_USAGE_DAILY_BUCKETS)
          .flatMap((bucket) => {
            if (!isRecord(bucket)) return [];
            const startDate = projectedUsageDate(bucket.startDate);
            const tokens = projectedNonNegativeInteger(bucket.tokens);
            return startDate && tokens !== null ? [{ startDate, tokens }] : [];
          })
      : null,
  };
}

function projectAccountReadResult(result: unknown): Record<string, unknown> {
  const account = isRecord(result) && isRecord(result.account) ? result.account : null;
  let projectedAccount: Record<string, unknown> | null = null;
  if (account?.type === "apiKey") {
    projectedAccount = { type: "apiKey" };
  } else if (
    account?.type === "chatgpt" &&
    typeof account.planType === "string" &&
    PLAN_TYPES.has(account.planType)
  ) {
    projectedAccount = { type: "chatgpt", planType: account.planType };
  } else if (
    account?.type === "amazonBedrock" &&
    typeof account.usesCodexManagedCredentials === "boolean"
  ) {
    projectedAccount = {
      type: "amazonBedrock",
      usesCodexManagedCredentials: account.usesCodexManagedCredentials,
    };
  }
  return {
    account: projectedAccount,
    requiresOpenaiAuth: isRecord(result) && typeof result.requiresOpenaiAuth === "boolean"
      ? result.requiresOpenaiAuth
      : false,
  };
}

function projectRateLimitWindow(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const usedPercent = projectedPercentage(value.usedPercent);
  const windowDurationMins = value.windowDurationMins === null
    ? null
    : projectedNonNegativeInteger(value.windowDurationMins);
  const resetsAt = value.resetsAt === null
    ? null
    : projectedNonNegativeInteger(value.resetsAt);
  if (
    usedPercent === null ||
    (windowDurationMins === null && value.windowDurationMins !== null)
  ) {
    return null;
  }
  if (resetsAt === null && value.resetsAt !== null) return null;
  return { usedPercent, windowDurationMins, resetsAt };
}

function projectSparseRateLimitWindow(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const output: Record<string, unknown> = {};

  if (Object.hasOwn(value, "usedPercent")) {
    assignDefined(output, "usedPercent", projectedPercentage(value.usedPercent) ?? undefined);
  }
  for (const key of ["windowDurationMins", "resetsAt"] as const) {
    if (!Object.hasOwn(value, key)) continue;
    if (value[key] === null) output[key] = null;
    else {
      assignDefined(
        output,
        key,
        projectedNonNegativeInteger(value[key]) ?? undefined,
      );
    }
  }

  return Object.keys(output).length > 0 ? output : null;
}

function projectCredits(value: unknown): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    typeof value.hasCredits !== "boolean" ||
    typeof value.unlimited !== "boolean"
  ) {
    return null;
  }
  const balance = value.balance === null ? null : projectedDecimalString(value.balance);
  if (balance === null && value.balance !== null) return null;
  return {
    hasCredits: value.hasCredits,
    unlimited: value.unlimited,
    balance,
  };
}

function projectSpendControl(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const limit = projectedDecimalString(value.limit);
  const used = projectedDecimalString(value.used);
  const remainingPercent = projectedPercentage(value.remainingPercent);
  const resetsAt = projectedNonNegativeInteger(value.resetsAt);
  if (!limit || !used || remainingPercent === null || resetsAt === null) return null;
  return { limit, used, remainingPercent, resetsAt };
}

function projectedNullableEnum(
  value: unknown,
  allowed: ReadonlySet<string>,
): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function projectRateLimitSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return {
    limitId: value.limitId === null ? null : projectedRateLimitId(value.limitId),
    limitName: value.limitName === null
      ? null
      : projectedBoundedString(value.limitName, MAX_RATE_LIMIT_NAME_CHARACTERS),
    primary: projectRateLimitWindow(value.primary),
    secondary: projectRateLimitWindow(value.secondary),
    credits: projectCredits(value.credits),
    individualLimit: projectSpendControl(value.individualLimit),
    spendControlReached: typeof value.spendControlReached === "boolean"
      ? value.spendControlReached
      : null,
    planType: projectedNullableEnum(value.planType, PLAN_TYPES),
    rateLimitReachedType: projectedNullableEnum(
      value.rateLimitReachedType,
      RATE_LIMIT_REACHED_TYPES,
    ),
  };
}

function projectAccountRateLimitsResult(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) {
    return {
      rateLimits: null,
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    };
  }

  const rateLimitsByLimitId = result.rateLimitsByLimitId === null
    ? null
    : isRecord(result.rateLimitsByLimitId)
      ? Object.fromEntries(
          Object.entries(result.rateLimitsByLimitId)
            .slice(0, MAX_RATE_LIMIT_BUCKETS)
            .flatMap(([limitId, snapshot]) => {
              const projectedId = projectedRateLimitId(limitId);
              const projectedSnapshot = projectRateLimitSnapshot(snapshot);
              return projectedId && projectedSnapshot
                ? [[projectedId, projectedSnapshot]]
                : [];
            }),
        )
      : null;

  const resetCredits = isRecord(result.rateLimitResetCredits)
    ? projectedNonNegativeInteger(result.rateLimitResetCredits.availableCount)
    : null;
  return {
    rateLimits: projectRateLimitSnapshot(result.rateLimits),
    rateLimitsByLimitId,
    rateLimitResetCredits: resetCredits === null
      ? null
      : { availableCount: resetCredits },
  };
}

function projectSparseRateLimitSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const output: Record<string, unknown> = {};

  if (Object.hasOwn(value, "limitId")) {
    if (value.limitId === null) output.limitId = null;
    else assignDefined(output, "limitId", projectedRateLimitId(value.limitId) ?? undefined);
  }
  if (Object.hasOwn(value, "limitName")) {
    if (value.limitName === null) output.limitName = null;
    else {
      assignDefined(
        output,
        "limitName",
        projectedBoundedString(value.limitName, MAX_RATE_LIMIT_NAME_CHARACTERS) ?? undefined,
      );
    }
  }

  for (const [key, projector] of [
    ["primary", projectSparseRateLimitWindow],
    ["secondary", projectSparseRateLimitWindow],
    ["credits", projectCredits],
    ["individualLimit", projectSpendControl],
  ] as const) {
    if (!Object.hasOwn(value, key)) continue;
    if (value[key] === null) output[key] = null;
    else assignDefined(output, key, projector(value[key]) ?? undefined);
  }

  if (Object.hasOwn(value, "spendControlReached")) {
    if (value.spendControlReached === null) output.spendControlReached = null;
    else if (typeof value.spendControlReached === "boolean") {
      output.spendControlReached = value.spendControlReached;
    }
  }
  for (const [key, allowed] of [
    ["planType", PLAN_TYPES],
    ["rateLimitReachedType", RATE_LIMIT_REACHED_TYPES],
  ] as const) {
    if (!Object.hasOwn(value, key)) continue;
    if (value[key] === null) output[key] = null;
    else assignDefined(output, key, projectedNullableEnum(value[key], allowed) ?? undefined);
  }

  return output;
}

function projectAccountRateLimitsUpdatedNotification(params: unknown): Record<string, unknown> {
  if (!isRecord(params)) return {};
  const rateLimits = projectSparseRateLimitSnapshot(params.rateLimits);
  return rateLimits && Object.keys(rateLimits).length > 0 ? { rateLimits } : {};
}

export function sanitizeBrowserNotificationParams(method: string, params: unknown): unknown {
  return method === "account/rateLimits/updated"
    ? projectAccountRateLimitsUpdatedNotification(params)
    : sanitizeBrowserVisibleValue(params);
}

export function sanitizeBrowserRpcResult(method: string, result: unknown): unknown {
  switch (method) {
    case "config/read": {
      const config = isRecord(result) && isRecord(result.config) ? result.config : {};
      return {
        model: configuredValue(config.model),
        effort: configuredValue(config.model_reasoning_effort),
      };
    }
    case "thread/name/set":
      return {};
    case "thread/metadata/update":
      return projectThreadMetadataUpdateResult(result);
    case "skills/list":
      return projectSkillsListResult(result);
    case "account/read":
      return projectAccountReadResult(result);
    case "account/usage/read":
      return projectAccountUsageResult(result);
    case "account/rateLimits/read":
      return projectAccountRateLimitsResult(result);
    default:
      return sanitizeBrowserVisibleValue(result);
  }
}

export function sanitizeBrowserVisibleValue(value: unknown, depth = 0): unknown {
  if (depth > 64) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeBrowserVisibleValue(entry, depth + 1));
  }
  if (!isRecord(value)) return value;
  const localImage = value.type === "localImage";
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (
    localImage && key === "path"
      ? []
      : [[key, sanitizeBrowserVisibleValue(entry, depth + 1)]]
  )));
}
