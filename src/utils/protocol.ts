import type {
  CodexItem,
  CodexItemEntry,
  CodexItemsPage,
  CodexThread,
  CodexTurn,
  CodexTurnsPage,
  ImageDetail,
  InputModality,
  ModelInfo,
  PlanStep,
  ServerMessage,
  TurnPlan,
  ThreadSettings,
  UserQuestion,
} from "../types/protocol";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface CommandApprovalTarget {
  threadId: string;
  turnId?: string;
  itemId: string;
  reason: string;
}

const COMMAND_APPROVAL_IDENTIFIER_LIMIT = 512;

function commandApprovalIdentifier(value: unknown): string | undefined {
  const identifier = readString(value);
  return identifier && identifier.trim() && identifier.length <= COMMAND_APPROVAL_IDENTIFIER_LIMIT
    ? identifier
    : undefined;
}

export function commandApprovalTarget(method: string, value: unknown): CommandApprovalTarget | null {
  if (
    method !== "item/commandExecution/requestApproval" &&
    method !== "execCommandApproval"
  ) {
    return null;
  }
  if (!isRecord(value)) return null;
  const itemId = method === "item/commandExecution/requestApproval"
    ? commandApprovalIdentifier(value.itemId)
    : commandApprovalIdentifier(value.callId);
  const threadId = method === "item/commandExecution/requestApproval"
    ? commandApprovalIdentifier(value.threadId)
    : commandApprovalIdentifier(value.conversationId);
  const turnId = method === "item/commandExecution/requestApproval"
    ? commandApprovalIdentifier(value.turnId)
    : undefined;
  const reason = readString(value.reason);
  if (!threadId || !itemId || !reason?.trim()) return null;
  if (method === "item/commandExecution/requestApproval" && !turnId) return null;
  return {
    threadId,
    turnId,
    itemId,
    reason,
  };
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function errorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (isRecord(value)) {
    const message = readString(value.message);
    if (message) return message;
    const nested = value.error;
    if (nested !== undefined && nested !== value) return errorMessage(nested);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown error";
  }
}

export function parseServerMessage(value: unknown): ServerMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "status":
      return (value.status === "starting" || value.status === "ready" || value.status === "error") &&
        typeof value.defaultCwd === "string" &&
        (value.error === undefined || (isRecord(value.error) && typeof value.error.message === "string"))
        ? (value as unknown as ServerMessage)
        : null;
    case "rpcResult":
      return typeof value.id === "string" && "result" in value
        ? (value as unknown as ServerMessage)
        : null;
    case "rpcError":
      return typeof value.id === "string" && "error" in value
        ? (value as unknown as ServerMessage)
        : null;
    case "notification":
      return typeof value.method === "string"
        ? (value as unknown as ServerMessage)
        : null;
    case "request":
      return (typeof value.id === "string" || typeof value.id === "number") &&
        typeof value.method === "string"
        ? (value as unknown as ServerMessage)
        : null;
    default:
      return null;
  }
}

export function normalizeItem(value: unknown): CodexItem | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") {
    return null;
  }
  return { ...value, id: value.id, type: value.type };
}

export function normalizeTurn(value: unknown): CodexTurn | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const rawItems = Array.isArray(value.items) ? value.items : [];
  const items = rawItems.map(normalizeItem).filter((item): item is CodexItem => item !== null);
  return { ...value, id: value.id, items };
}

export function normalizeThread(value: unknown): CodexThread | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const rawTurns = Array.isArray(value.turns) ? value.turns : undefined;
  const turns = rawTurns
    ?.map(normalizeTurn)
    .filter((turn): turn is CodexTurn => turn !== null);
  return { ...value, id: value.id, ...(turns ? { turns } : {}) };
}

export function extractThreads(result: unknown): CodexThread[] {
  const candidate = isRecord(result) && Array.isArray(result.data) ? result.data : result;
  if (!Array.isArray(candidate)) return [];
  return candidate.map(normalizeThread).filter((thread): thread is CodexThread => thread !== null);
}

export function extractThread(result: unknown): CodexThread | null {
  const candidate = isRecord(result) && "thread" in result ? result.thread : result;
  return normalizeThread(candidate);
}

export function extractTurn(result: unknown): CodexTurn | null {
  const candidate = isRecord(result) && "turn" in result ? result.turn : result;
  return normalizeTurn(candidate);
}

export function normalizeTurnsPage(value: unknown): CodexTurnsPage | null {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  const data = value.data
    .map(normalizeTurn)
    .filter((turn): turn is CodexTurn => turn !== null);
  return {
    data,
    nextCursor: readString(value.nextCursor) ?? null,
    backwardsCursor: readString(value.backwardsCursor) ?? null,
  };
}

function normalizeItemEntry(value: unknown): CodexItemEntry | null {
  if (!isRecord(value) || typeof value.turnId !== "string") return null;
  const item = normalizeItem(value.item);
  return item ? { turnId: value.turnId, item } : null;
}

export function normalizeItemsPage(value: unknown): CodexItemsPage | null {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  if (
    (value.nextCursor !== null && typeof value.nextCursor !== "string") ||
    (value.backwardsCursor !== null && typeof value.backwardsCursor !== "string")
  ) {
    return null;
  }
  const data = value.data.map(normalizeItemEntry);
  if (!data.every((entry): entry is CodexItemEntry => entry !== null)) return null;
  return {
    data,
    nextCursor: value.nextCursor,
    backwardsCursor: value.backwardsCursor,
  };
}

export function extractInitialTurnsPage(result: unknown): CodexTurnsPage | null {
  return isRecord(result) ? normalizeTurnsPage(result.initialTurnsPage) : null;
}

export function extractModels(result: unknown): ModelInfo[] {
  const candidate = isRecord(result) && Array.isArray(result.data) ? result.data : result;
  if (!Array.isArray(candidate)) return [];
  return candidate.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const model = readString(entry.model) ?? readString(entry.id);
    if (!model) return [];
    const rawEfforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts
      : [];
    const supportedReasoningEfforts = rawEfforts.flatMap((effort) => {
      if (typeof effort === "string") return [{ reasoningEffort: effort }];
      if (!isRecord(effort)) return [];
      const reasoningEffort = readString(effort.reasoningEffort) ?? readString(effort.effort);
      return reasoningEffort
        ? [{ reasoningEffort, description: readString(effort.description) }]
        : [];
    });
    const inputModalities = Array.isArray(entry.inputModalities)
      ? entry.inputModalities.filter((modality): modality is InputModality => (
          modality === "text" || modality === "image" || modality === "audio"
        ))
      : undefined;
    return [{
      model,
      displayName: readString(entry.displayName) ?? model,
      supportedReasoningEfforts,
      inputModalities,
      defaultReasoningEffort: readString(entry.defaultReasoningEffort),
      isDefault: typeof entry.isDefault === "boolean" ? entry.isDefault : undefined,
    }];
  });
}

export function sandboxMode(value: unknown): ThreadSettings["sandbox"] | undefined {
  if (value === "workspace-write" || value === "read-only" || value === "danger-full-access") {
    return value;
  }
  if (!isRecord(value)) return undefined;
  if (value.type === "workspaceWrite") return "workspace-write";
  if (value.type === "readOnly") return "read-only";
  if (value.type === "dangerFullAccess") return "danger-full-access";
  if (value.type === "externalSandbox") return "external";
  return undefined;
}

export function textParts(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map(contentPartText).filter(Boolean).join("\n");
}

function contentPartText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!isRecord(part)) return "";
  return readString(part.text) ?? readString(part.content) ?? "";
}

export interface UserMessageImage {
  type: "localImage" | "image";
  detail?: ImageDetail;
}

export type UserMessageContentPart =
  | { type: "text"; text: string }
  | UserMessageImage;

export function userMessageContent(item: CodexItem): UserMessageContentPart[] {
  if (!Array.isArray(item.content)) return [];
  return item.content.flatMap<UserMessageContentPart>((part) => {
    if (isRecord(part) && (part.type === "localImage" || part.type === "image")) {
      const detail: ImageDetail | undefined = part.detail === "auto" ||
          part.detail === "low" ||
          part.detail === "high" ||
          part.detail === "original"
        ? part.detail
        : undefined;
      return [{ type: part.type, detail }];
    }
    const text = contentPartText(part);
    return text ? [{ type: "text" as const, text }] : [];
  });
}

export function userMessageImages(item: CodexItem): UserMessageImage[] {
  return userMessageContent(item).filter(
    (part): part is UserMessageImage => part.type === "localImage" || part.type === "image",
  );
}

export function itemText(item: CodexItem): string {
  const direct =
    readString(item.text) ??
    readString(item.message) ??
    readString(item.summaryText) ??
    readString(item.aggregatedOutput) ??
    readString(item.output);
  if (direct !== undefined) return direct;
  if (Array.isArray(item.content)) return textParts(item.content);
  if (Array.isArray(item.summary)) return textParts(item.summary);
  return "";
}

export function commandText(item: CodexItem): string {
  if (typeof item.command === "string") return item.command;
  if (Array.isArray(item.command)) return item.command.filter((part): part is string => typeof part === "string").join(" ");
  return "Command";
}

export function parsePlan(value: unknown): TurnPlan | undefined {
  if (!isRecord(value) || !Array.isArray(value.plan)) return undefined;
  const plan: PlanStep[] = value.plan.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.step !== "string" || typeof entry.status !== "string") return [];
    return [{ step: entry.step, status: entry.status }];
  });
  return { explanation: readString(value.explanation), plan };
}

export function parseQuestions(params: Record<string, unknown>): UserQuestion[] {
  if (!Array.isArray(params.questions)) return [];
  return params.questions.flatMap((question) => {
    if (!isRecord(question) || typeof question.id !== "string" || typeof question.question !== "string") {
      return [];
    }
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (!isRecord(option) || typeof option.label !== "string") return [];
          return [{ label: option.label, description: readString(option.description) }];
        })
      : undefined;
    return [{
      ...question,
      id: question.id,
      question: question.question,
      header: readString(question.header),
      options,
      isOther: typeof question.isOther === "boolean" ? question.isOther : undefined,
      isSecret: typeof question.isSecret === "boolean" ? question.isSecret : undefined,
    }];
  });
}

export function formatTimestamp(value: unknown): string {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
  const normalized = numeric !== undefined
    ? Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1000 : numeric
    : value;
  const date = typeof normalized === "number" || typeof normalized === "string" ? new Date(normalized) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function stripAnsi(value: string): string {
  // Browsers do not render terminal control sequences. Preserve the readable payload.
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
}
