import express from "express";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import WebSocket, { WebSocketServer } from "ws";
import type { RawData } from "ws";

import {
  AttachmentStore,
  AttachmentStoreError,
  DEFAULT_ATTACHMENT_STORE_LIMITS,
  type AttachmentLease,
} from "./attachments.js";

import {
  CodexAppServer,
  CodexRpcError,
  type CodexGateway,
  type CodexStatusEvent,
} from "./codex-app-server.js";
import {
  FileDownloadError,
  FileDownloadStore,
  type FileDownloadLease,
} from "./file-downloads.js";
import {
  MessageQueueError,
  MessageQueueStore,
  type MessageQueueItem,
} from "./message-queue.js";
import {
  assertSafeBind,
  ClientInputError,
  ClientRpcError,
  isAllowedOrigin,
  isHttpAuthorized,
  MethodNotAllowedError,
  normalizePublicOrigin,
  tokenMatches,
  validateRpcCwd,
} from "./security.js";
import {
  ThreadOwnership,
  threadIdFromParams,
  threadIdFromStartResult,
} from "./thread-ownership.js";
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
  sanitizeMessageQueueRpcParams,
  type GatewaySandboxPolicy,
  type TurnSandboxAuthority,
} from "./rpc-policy.js";
import {
  assertServerRequestRoutable,
  normalizeServerRequestResponse,
} from "./server-request-policy.js";
import { TurnPlanCache } from "./turn-plan-cache.js";
import {
  isRecord,
  isRpcId,
  parseBrowserMessage,
  type BrowserMessage,
  type RequestMessage,
  type RpcId,
  type ServerMessage,
  type StatusMessage,
} from "./types.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const MAX_IN_FLIGHT_RPC_PER_CLIENT = 32;
const MAX_IN_FLIGHT_RPC_GLOBAL = 128;
const MAX_WS_CONNECTIONS = 32;
const MAX_PENDING_SERVER_REQUESTS = 128;
const MAX_IN_FLIGHT_ATTACHMENT_UPLOADS = 4;
const MAX_COMPLETED_ATTACHMENT_TURNS = 256;
const MAX_HTTP_CONNECTIONS = 64;
const HTTP_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const FILE_DOWNLOAD_TRANSFER_TIMEOUT_MS = HTTP_REQUEST_TIMEOUT_MS;
const HTTP_HEADERS_TIMEOUT_MS = 10 * 1000;
const MAX_BROWSER_MESSAGE_BYTES = 1024 * 1024;
const MAX_SERVER_MESSAGE_BYTES = 1024 * 1024;
const MAX_WS_BUFFERED_BYTES = 2 * 1024 * 1024;
const WS_AUTH_TIMEOUT_MS = 5_000;
const MAX_RESYNC_METHOD_CHARACTERS = 128;
const MAX_RESYNC_ID_CHARACTERS = 256;
const MAX_THREAD_SANDBOX_AUTHORITIES = 4_096;
const MAX_OVERSIZED_NOTIFICATION_TEXT_CHARACTERS = 20_000;
const MAX_OVERSIZED_NOTIFICATION_ERROR_CHARACTERS = 2_000;
const MAX_NOTIFICATION_SIZE_SCAN_NODES = 100_000;
const NOTIFICATION_SIZE_MARGIN_BYTES = 16 * 1024;
const MAX_COMPACT_RPC_TURNS = 16;
const MAX_COMPACT_RPC_PAGE_TURNS = 100;
const MAX_COMPACT_RPC_ITEMS = 16;
const MAX_COMPACT_RPC_TEXT_CHARACTERS = 1_024;
const MAX_COMPACT_RPC_CURSOR_CHARACTERS = 4_096;

function logLargeStdoutLine(diagnostic: {
  byteLength: number;
  direction: string;
  method?: string;
  id?: string | number;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  itemType?: string;
  largestString?: {
    path: string;
    characters: number;
    utf8Bytes: number;
    category: string;
  };
  topLevelStringBytes: Array<{ field: string; utf8Bytes: number }>;
  hasImageData: boolean;
  hasBase64Data: boolean;
  scannedNodes: number;
  scanTruncated: boolean;
  parseError?: boolean;
}): void {
  // Deliberately log metadata only; command/MCP contents and credentials stay out of logs.
  console.error(`[ask-codex] large app-server stdout JSONL line ${JSON.stringify(diagnostic)}`);
}

function logOversizedServerMessage(message: ServerMessage, byteLength: number, estimated = false): void {
  const params = message.type === "notification" || message.type === "request"
    ? message.params
    : undefined;
  const record = isRecord(params) ? params : {};
  const item = isRecord(record.item) ? record.item : {};
  const turn = isRecord(record.turn) ? record.turn : {};
  const id = message.type === "request" ? message.id : undefined;
  const metadata = {
    byteLength,
    ...(estimated ? { estimated: true } : {}),
    messageType: message.type,
    ...(message.type === "notification" || message.type === "request"
      ? { method: message.method.slice(0, MAX_RESYNC_METHOD_CHARACTERS) }
      : {}),
    ...(id === undefined ? {} : { id }),
    ...(typeof record.threadId === "string" ? { threadId: record.threadId.slice(0, MAX_RESYNC_ID_CHARACTERS) } : {}),
    ...(typeof record.turnId === "string"
      ? { turnId: record.turnId.slice(0, MAX_RESYNC_ID_CHARACTERS) }
      : typeof turn.id === "string"
        ? { turnId: turn.id.slice(0, MAX_RESYNC_ID_CHARACTERS) }
        : {}),
    ...(typeof record.itemId === "string"
      ? { itemId: record.itemId.slice(0, MAX_RESYNC_ID_CHARACTERS) }
      : typeof item.id === "string"
        ? { itemId: item.id.slice(0, MAX_RESYNC_ID_CHARACTERS) }
        : {}),
    ...(typeof item.type === "string" ? { itemType: item.type.slice(0, 128) } : {}),
  };
  console.error(`[ask-codex] oversized browser message ${JSON.stringify(metadata)}`);
}
export { ALLOWED_BROWSER_RPC_METHODS } from "./rpc-policy.js";

class OversizedCodexResultError extends Error {
  constructor(readonly method: string) {
    super("Codex response exceeded the 1 MiB gateway message limit");
    this.name = "OversizedCodexResultError";
  }
}

export interface AskCodexConfig {
  host: string;
  port: number;
  defaultCwd: string;
  token?: string;
  publicOrigin?: string;
  production: boolean;
  distDir: string;
  messageQueuePath?: string;
}

export interface StartedServer {
  host: string;
  port: number;
  url: string;
}

interface PendingServerRequest {
  message: RequestMessage;
  recipients: Set<WebSocket>;
}

interface FileDownloadTransferTimeout {
  signal: AbortSignal;
  clear(): void;
}

type CreateFileDownloadTransferTimeout = (
  timeoutMs: number,
) => FileDownloadTransferTimeout;

function createFileDownloadTransferTimeout(
  timeoutMs: number,
): FileDownloadTransferTimeout {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

function waitForFirstFileDownloadChunk(
  source: Readable,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolveChunk, rejectChunk) => {
    let settled = false;

    const cleanup = (): void => {
      source.off("readable", onReadable);
      source.off("end", onEnd);
      source.off("close", onClose);
      source.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) {
        resolveChunk();
      } else {
        rejectChunk(error);
      }
    };
    const onReadable = (): void => {
      try {
        const chunk = source.read();
        if (chunk === null) return;
        source.unshift(chunk);
        settle();
      } catch (error) {
        settle(error);
      }
    };
    const onEnd = (): void => settle(new Error("File download ended before its first byte"));
    const onClose = (): void => settle(new Error("File download closed before its first byte"));
    const onError = (error: Error): void => settle(error);
    const onAbort = (): void => {
      const reason = signal.reason instanceof Error
        ? signal.reason
        : new Error("File download transfer timed out");
      settle(reason);
      source.destroy();
    };

    source.on("readable", onReadable);
    source.once("end", onEnd);
    source.once("close", onClose);
    source.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    } else {
      onReadable();
    }
  });
}

function turnIdFromStartResult(result: unknown): string | undefined {
  const turn = isRecord(result) && isRecord(result.turn) ? result.turn : undefined;
  return turn && typeof turn.id === "string" && turn.id
    ? turn.id
    : undefined;
}

function turnIdFromNotification(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  if (typeof params.turnId === "string" && params.turnId) return params.turnId;
  return isRecord(params.turn) && typeof params.turn.id === "string" && params.turn.id
    ? params.turn.id
    : undefined;
}

function resultSandboxPolicy(
  result: unknown,
  threadId: string,
  errorMessage: string,
): GatewaySandboxPolicy {
  const response = isRecord(result) ? result : undefined;
  const thread = response && isRecord(response.thread) ? response.thread : undefined;
  if (thread?.id !== threadId) {
    throw new ClientInputError(errorMessage);
  }

  const sandbox = normalizeGatewaySandboxPolicy(response?.sandbox);
  if (!sandbox) {
    throw new ClientInputError(errorMessage);
  }
  return sandbox;
}

function resumeResultSandboxPolicy(result: unknown, threadId: string): GatewaySandboxPolicy {
  return resultSandboxPolicy(
    result,
    threadId,
    "thread/resume could not verify the existing sandbox",
  );
}

function attachmentTurnKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

function attachmentHttpError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof AttachmentStoreError) {
    return { status: error.statusCode, code: error.code, message: error.message };
  }
  if (isRecord(error) && error.type === "entity.too.large") {
    return {
      status: 413,
      code: "attachmentTooLarge",
      message: "Attachment exceeds the per-file size limit",
    };
  }
  if (isRecord(error) && error.type === "encoding.unsupported") {
    return {
      status: 415,
      code: "unsupportedEncoding",
      message: "Compressed attachment uploads are not supported",
    };
  }
  if (isRecord(error) && (error.type === "request.aborted" || error.type === "entity.parse.failed")) {
    return {
      status: 400,
      code: "invalidPayload",
      message: "Attachment upload was incomplete",
    };
  }
  if (isRecord(error) && error.type === "request.size.invalid") {
    return {
      status: 400,
      code: "invalidPayload",
      message: "Attachment size did not match Content-Length",
    };
  }
  if (error instanceof URIError) {
    return {
      status: 400,
      code: "invalidAttachmentId",
      message: "Attachment ID is invalid",
    };
  }
  return {
    status: 500,
    code: "storageUnavailable",
    message: "Attachment storage is unavailable",
  };
}

function closeRejectedAttachmentRequest(
  request: express.Request,
  response: express.Response,
): void {
  response.setHeader("Connection", "close");
  response.once("finish", () => request.socket.destroy());
}

function decodedAttachmentFileName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    return undefined;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function fileDownloadHttpError(error: unknown): {
  status: number;
  code: string;
  message: string;
} {
  if (error instanceof FileDownloadError) {
    return { status: error.statusCode, code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: "fileDownloadsUnavailable",
    message: "File downloads are unavailable",
  };
}

function encodedHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function contentDispositionAttachment(fileName: string): string {
  const fallback = [...fileName]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint <= 0x7e && character !== '"' && character !== "\\"
        ? character
        : "_";
    })
    .join("")
    .slice(0, 200) || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodedHeaderValue(fileName)}`;
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 4173 : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("ASK_CODEX_PORT must be an integer between 0 and 65535");
  }
  return port;
}

function messageQueuePath(environment: NodeJS.ProcessEnv): string {
  const configured = environment.ASK_CODEX_QUEUE_PATH?.trim();
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error("ASK_CODEX_QUEUE_PATH must be an absolute path");
    }
    return configured;
  }
  const configuredStateHome = environment.XDG_STATE_HOME?.trim();
  if (configuredStateHome && !isAbsolute(configuredStateHome)) {
    throw new Error("XDG_STATE_HOME must be an absolute path");
  }
  const stateHome = configuredStateHome || join(homedir(), ".local", "state");
  return join(stateHome, "ask-codex", "message-queue.json");
}

function assertDirectory(path: string, label: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  let metadata;
  try {
    metadata = statSync(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label} must be a directory: ${path}`);
  }
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory: string = process.cwd(),
): AskCodexConfig {
  const host = environment.ASK_CODEX_HOST?.trim() || "127.0.0.1";
  const token = environment.ASK_CODEX_TOKEN || undefined;
  const publicOrigin = normalizePublicOrigin(environment.ASK_CODEX_PUBLIC_ORIGIN);
  const defaultCwd = environment.ASK_CODEX_WORKSPACE || currentDirectory;
  assertSafeBind(host, token, publicOrigin);
  assertDirectory(defaultCwd, "ASK_CODEX_WORKSPACE");

  return {
    host,
    port: parsePort(environment.ASK_CODEX_PORT),
    defaultCwd,
    token,
    publicOrigin,
    production: environment.NODE_ENV === "production",
    distDir: resolve(moduleDirectory, "../dist"),
    messageQueuePath: messageQueuePath(environment),
  };
}

interface QueuedThreadSnapshot {
  busy: boolean;
  lastTurnId: string | null;
  systemError: boolean;
}

function queuedThreadSnapshot(result: unknown, threadId: string): QueuedThreadSnapshot {
  const thread = isRecord(result) && isRecord(result.thread) ? result.thread : undefined;
  if (thread?.id !== threadId || !Array.isArray(thread.turns) || !isRecord(thread.status)) {
    throw new MessageQueueError("Queued message thread state is unavailable");
  }
  const statusType = thread.status.type;
  if (
    statusType !== "active" &&
    statusType !== "idle" &&
    statusType !== "notLoaded" &&
    statusType !== "systemError"
  ) {
    throw new MessageQueueError("Queued message thread state is unavailable");
  }
  const lastTurn = thread.turns.at(-1);
  if (lastTurn !== undefined && (!isRecord(lastTurn) || typeof lastTurn.id !== "string" || !lastTurn.id)) {
    throw new MessageQueueError("Queued message thread context is unavailable");
  }
  return {
    busy: statusType === "active" || (isRecord(lastTurn) && lastTurn.status === "inProgress"),
    lastTurnId: isRecord(lastTurn) ? lastTurn.id as string : null,
    systemError: statusType === "systemError",
  };
}

function rpcIdKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

const FIXED_APP_SERVER_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "skills/list": "Codex app-server could not list skills",
  "account/read": "Codex app-server could not read account status",
  "account/rateLimits/read": "Codex app-server could not read rate limits",
  "account/usage/read": "Codex app-server could not read account usage",
};

function errorPayload(method: string, error: unknown): unknown {
  if (error instanceof ClientRpcError) {
    return { code: error.code, message: error.message };
  }
  const fixedMessage = FIXED_APP_SERVER_ERROR_MESSAGES[method];
  if (fixedMessage) {
    const rawCode = error instanceof CodexRpcError && isRecord(error.rpcError)
      ? error.rpcError.code
      : undefined;
    return {
      code: typeof rawCode === "number" && Number.isSafeInteger(rawCode)
        ? rawCode
        : -32_000,
      message: fixedMessage,
    };
  }
  if (error instanceof CodexRpcError) {
    return error.rpcError;
  }
  if (error instanceof Error) {
    return { code: -32_000, message: error.message };
  }
  return { code: -32_000, message: String(error) };
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return data.toString("utf8");
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maximum) : undefined;
}

function resyncRequiredNotification(
  message: Extract<ServerMessage, { type: "notification" }>,
): ServerMessage {
  const source = isRecord(message.params) ? message.params : {};
  const threadId = boundedString(source.threadId, MAX_RESYNC_ID_CHARACTERS);
  const turnId = boundedString(source.turnId, MAX_RESYNC_ID_CHARACTERS);
  const itemId = boundedString(source.itemId, MAX_RESYNC_ID_CHARACTERS);
  return {
    type: "notification",
    method: "gateway/resyncRequired",
    params: {
      reason: "messageTooLarge",
      lostMethod: message.method.slice(0, MAX_RESYNC_METHOD_CHARACTERS),
      ...(threadId === undefined ? {} : { threadId }),
      ...(turnId === undefined ? {} : { turnId }),
      ...(itemId === undefined ? {} : { itemId }),
    },
  };
}

function boundedOversizedNotificationText(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, maximum)
    : undefined;
}

function boundedOversizedNotificationNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function boundedOversizedNotificationBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function boundedOversizedNotificationOmissions(
  value: unknown,
): Record<string, number> {
  if (!isRecord(value)) return {};
  const output: Record<string, number> = {};
  for (const [key, count] of Object.entries(value).slice(0, 32)) {
    if (
      key.length <= 128 &&
      Number.isSafeInteger(count) &&
      (count as number) >= 0
    ) {
      output[key] = count as number;
    }
  }
  return output;
}

function omittedCountForValue(value: unknown): number {
  if (typeof value === "string") return Math.min(Number.MAX_SAFE_INTEGER, value.length);
  if (Array.isArray(value)) return value.length;
  return value === undefined ? 0 : 1;
}

function addOversizedNotificationOmission(
  omissions: Record<string, number>,
  key: string,
  value: unknown,
): void {
  if (typeof value !== "string" || value.length <= MAX_OVERSIZED_NOTIFICATION_TEXT_CHARACTERS) {
    return;
  }
  omissions[key] = Math.min(Number.MAX_SAFE_INTEGER, value.length);
}

function copyOversizedNotificationString(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  omissions: Record<string, number>,
): void {
  const value = source[key];
  if (typeof value !== "string") return;
  if (value.length > MAX_OVERSIZED_NOTIFICATION_TEXT_CHARACTERS) {
    addOversizedNotificationOmission(omissions, key, value);
    return;
  }
  target[key] = value;
}

function compactOversizedItem(
  method: string,
  params: Record<string, unknown>,
): ServerMessage | null {
  const source = isRecord(params.item) ? params.item : params;
  const id = typeof source.id === "string"
    ? source.id
    : typeof params.itemId === "string" ? params.itemId : undefined;
  const type = typeof source.type === "string" ? source.type : undefined;
  if (!id || !type) return null;

  const item: Record<string, unknown> = {
    id: id.slice(0, MAX_RESYNC_ID_CHARACTERS),
    type: type.slice(0, 128),
    status: typeof source.status === "string"
      ? source.status.slice(0, 128)
      : method === "item/completed" ? "completed" : "inProgress",
  };
  const omissions = boundedOversizedNotificationOmissions(source.streamOmittedCharacters);

  // Keep identifiers and small display metadata, but never replace already streamed
  // content with a short suffix/prefix from a compact completion payload.
  for (const key of [
    "command",
    "cwd",
    "processId",
    "source",
    "server",
    "serverName",
    "tool",
    "toolName",
    "namespace",
    "query",
    "name",
    "phase",
  ] as const) {
    copyOversizedNotificationString(item, source, key, omissions);
  }
  for (const key of ["exitCode", "durationMs"] as const) {
    const value = boundedOversizedNotificationNumber(source[key]);
    if (value !== undefined) item[key] = value;
  }
  for (const key of ["success", "readOnlyHint"] as const) {
    const value = boundedOversizedNotificationBoolean(source[key]);
    if (value !== undefined) item[key] = value;
  }

  for (const key of [
    "aggregatedOutput",
    "output",
    "text",
    "summaryText",
    "contentText",
    "prompt",
    "arguments",
    "result",
    "error",
    "summary",
    "content",
    "commandActions",
    "contentItems",
    "agentsStates",
  ] as const) {
    const value = source[key];
    if (typeof value === "string") {
      if (value.length <= MAX_OVERSIZED_NOTIFICATION_TEXT_CHARACTERS) item[key] = value;
      else addOversizedNotificationOmission(omissions, key, value);
    } else if (Array.isArray(value) && value.length > 0) {
      // The exact JSON size is intentionally not retained in browser state; a
      // positive count tells the UI that this field was omitted from the lifecycle
      // projection while preserving the streamed prefix, when one exists.
      omissions[key] = omittedCountForValue(value);
    } else if (value !== undefined && isRecord(value)) {
      omissions[key] = omittedCountForValue(value);
    }
  }
  const fileDownloads = Array.isArray(source.askCodexFileDownloads)
    ? source.askCodexFileDownloads
        .slice(0, 32)
        .flatMap((entry) => {
          if (!isRecord(entry)) return [];
          const href = typeof entry.href === "string" ? entry.href.slice(0, 4_096) : undefined;
          const capabilityId = typeof entry.capabilityId === "string"
            ? entry.capabilityId.slice(0, 128)
            : undefined;
          return href && capabilityId ? [{ href, capabilityId }] : [];
        })
    : [];
  if (fileDownloads.length > 0) item.askCodexFileDownloads = fileDownloads;
  if (Object.keys(omissions).length > 0) item.streamOmittedCharacters = omissions;

  const output: Record<string, unknown> = {
    ...(typeof params.threadId === "string" ? { threadId: params.threadId.slice(0, MAX_RESYNC_ID_CHARACTERS) } : {}),
    ...(typeof params.turnId === "string" ? { turnId: params.turnId.slice(0, MAX_RESYNC_ID_CHARACTERS) } : {}),
    ...(typeof params.startedAtMs === "number" && Number.isSafeInteger(params.startedAtMs)
      ? { startedAtMs: params.startedAtMs }
      : {}),
    ...(typeof params.completedAtMs === "number" && Number.isSafeInteger(params.completedAtMs)
      ? { completedAtMs: params.completedAtMs }
      : {}),
    item,
  };
  return { type: "notification", method, params: output };
}

function oversizedItemNotification(
  method: string,
  params: Record<string, unknown>,
): ServerMessage | null {
  return compactOversizedItem(method, params);
}

function oversizedTurnNotification(
  method: string,
  params: Record<string, unknown>,
): ServerMessage | null {
  const source = isRecord(params.turn) ? params.turn : params;
  const id = typeof source.id === "string"
    ? source.id
    : typeof params.turnId === "string" ? params.turnId : undefined;
  if (!id) return null;
  const status = typeof source.status === "string"
    ? source.status.slice(0, 128)
    : typeof params.status === "string"
      ? params.status.slice(0, 128)
      : method === "turn/completed" ? "completed" : "inProgress";
  const turn: Record<string, unknown> = {
    id: id.slice(0, MAX_RESYNC_ID_CHARACTERS),
    status,
    items: [],
    itemsView: "notLoaded",
  };
  for (const key of ["startedAt", "completedAt", "durationMs"] as const) {
    const value = boundedOversizedNotificationNumber(source[key]);
    if (value !== undefined) turn[key] = value;
  }
  const error = boundedOversizedNotificationText(source.error, MAX_OVERSIZED_NOTIFICATION_ERROR_CHARACTERS);
  if (error !== undefined) turn.error = error;
  return {
    type: "notification",
    method,
    params: {
      ...(typeof params.threadId === "string" ? { threadId: params.threadId.slice(0, MAX_RESYNC_ID_CHARACTERS) } : {}),
      turnId: id.slice(0, MAX_RESYNC_ID_CHARACTERS),
      turn,
    },
  };
}

function recoverableOversizedNotification(
  message: Extract<ServerMessage, { type: "notification" }>,
): ServerMessage | null {
  if (!isRecord(message.params)) return null;
  if (message.method === "turn/started" || message.method === "turn/completed") {
    return oversizedTurnNotification(message.method, message.params);
  }
  if (message.method === "item/started" || message.method === "item/completed") {
    return oversizedItemNotification(message.method, message.params);
  }
  return null;
}

interface SizeScanState {
  nodes: number;
  active: Set<object>;
}

function estimatedJsonStringBytes(value: string, limit: number): number {
  let total = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit === 0x22 ||
      codeUnit === 0x5c ||
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    ) {
      total += 2;
    } else if (codeUnit <= 0x1f) {
      total += 6;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        total += 4;
        index += 1;
      } else {
        total += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      total += 6;
    } else if (codeUnit <= 0x7f) {
      total += 1;
    } else if (codeUnit <= 0x7ff) {
      total += 2;
    } else {
      total += 3;
    }
    if (total > limit) return limit + 1;
  }
  return total;
}

function estimatedJsonBytes(
  value: unknown,
  limit: number,
  state: SizeScanState = { nodes: 0, active: new Set() },
): number {
  if (limit < 0 || state.nodes >= MAX_NOTIFICATION_SIZE_SCAN_NODES) return limit + 1;
  state.nodes += 1;
  if (value === null) return 4;
  if (typeof value === "string") return estimatedJsonStringBytes(value, limit);
  if (typeof value === "number") return Number.isFinite(value) ? 24 : 4;
  if (typeof value === "boolean") return 5;
  if (typeof value !== "object") return 4;
  if (state.active.has(value)) return limit + 1;
  state.active.add(value);
  let total = Array.isArray(value) ? 2 : 2;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) total += 1;
      const child = estimatedJsonBytes(value[index], limit - total, state);
      total += child;
      if (total > limit) break;
    }
  } else {
    let index = 0;
    for (const [key, childValue] of Object.entries(value)) {
      if (index > 0) total += 1;
      total += estimatedJsonStringBytes(key, limit - total) + 1;
      if (total > limit) break;
      total += estimatedJsonBytes(childValue, limit - total, state);
      index += 1;
      if (total > limit) break;
    }
  }
  state.active.delete(value);
  return total;
}

function notificationMayExceedGatewayLimit(
  method: string,
  params: unknown,
  emittedAtMs: number | undefined,
  gatewayReceivedAtMs: number,
): boolean {
  const limit = MAX_SERVER_MESSAGE_BYTES - NOTIFICATION_SIZE_MARGIN_BYTES;
  return estimatedJsonBytes({
    type: "notification",
    method,
    params,
    ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
    gatewayReceivedAtMs,
  }, limit) > limit;
}

function boundedRpcProjectionString(value: unknown, maximum = MAX_COMPACT_RPC_TEXT_CHARACTERS): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maximum) : undefined;
}

function boundedRpcProjectionInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function compactTurnError(value: unknown): unknown {
  if (typeof value === "string") {
    return boundedRpcProjectionString(value, MAX_OVERSIZED_NOTIFICATION_ERROR_CHARACTERS);
  }
  if (!isRecord(value)) return undefined;
  const message = boundedRpcProjectionString(
    value.message,
    MAX_OVERSIZED_NOTIFICATION_ERROR_CHARACTERS,
  );
  return message === undefined ? undefined : { message };
}

function compactRpcItem(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") {
    return null;
  }
  const item: Record<string, unknown> = {
    id: value.id.slice(0, MAX_RESYNC_ID_CHARACTERS),
    type: value.type.slice(0, 128),
  };
  for (const key of ["status", "command", "cwd", "processId", "source", "server", "tool", "namespace"] as const) {
    const projected = boundedRpcProjectionString(value[key]);
    if (projected !== undefined) item[key] = projected;
  }
  for (const key of ["exitCode", "durationMs"] as const) {
    const projected = boundedRpcProjectionInteger(value[key]);
    if (projected !== undefined) item[key] = projected;
  }
  for (const key of ["success", "readOnlyHint"] as const) {
    if (typeof value[key] === "boolean") item[key] = value[key];
  }

  const omissions = boundedOversizedNotificationOmissions(value.streamOmittedCharacters);
  const largeFields = [
    "aggregatedOutput",
    "output",
    "text",
    "summary",
    "content",
    "arguments",
    "result",
    "error",
    "commandActions",
    "contentItems",
    "agentsStates",
  ] as const;
  for (const key of largeFields) {
    const source = value[key];
    if (typeof source === "string") {
      // Command output is already streamed separately. Never duplicate it in a
      // compact history response; keep only an omission count.
      if (key !== "aggregatedOutput" && key !== "output") {
        const projected = boundedRpcProjectionString(source);
        if (projected !== undefined) item[key] = projected;
      }
      if (source.length > MAX_COMPACT_RPC_TEXT_CHARACTERS || key === "aggregatedOutput" || key === "output") {
        omissions[key] = Math.max(
          omissions[key] ?? 0,
          key === "aggregatedOutput" || key === "output"
            ? source.length
            : source.length - MAX_COMPACT_RPC_TEXT_CHARACTERS,
        );
      }
    } else if (Array.isArray(source)) {
      const projected = source
        .slice(0, 16)
        .flatMap((entry) => typeof entry === "string" ? [entry.slice(0, MAX_COMPACT_RPC_TEXT_CHARACTERS)] : []);
      if (projected.length > 0) item[key] = projected;
      if (source.length > projected.length) {
        omissions[key] = Math.max(omissions[key] ?? 0, source.length - projected.length);
      }
    } else if (source !== undefined) {
      omissions[key] = Math.max(omissions[key] ?? 0, omittedCountForValue(source));
    }
  }
  if (Object.keys(omissions).length > 0) item.streamOmittedCharacters = omissions;
  return item;
}

function compactRpcTurn(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const items = Array.isArray(value.items)
    ? value.items.slice(0, MAX_COMPACT_RPC_ITEMS).flatMap((entry) => {
        const item = compactRpcItem(entry);
        return item ? [item] : [];
      })
    : [];
  const turn: Record<string, unknown> = {
    id: value.id.slice(0, MAX_RESYNC_ID_CHARACTERS),
    items,
    itemsView: "summary",
    status: typeof value.status === "string" ? value.status.slice(0, 128) : "inProgress",
  };
  for (const key of ["startedAt", "completedAt", "durationMs"] as const) {
    const projected = boundedRpcProjectionInteger(value[key]);
    if (projected !== undefined) turn[key] = projected;
  }
  const error = compactTurnError(value.error);
  if (error !== undefined) turn.error = error;
  if (Array.isArray(value.items) && value.items.length > items.length) {
    turn.streamOmittedItems = value.items.length - items.length;
  }
  return turn;
}

function compactRpcTurnShell(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const turn: Record<string, unknown> = {
    id: value.id.slice(0, MAX_RESYNC_ID_CHARACTERS),
    items: [],
    itemsView: "summary",
    status: typeof value.status === "string" ? value.status.slice(0, 128) : "inProgress",
  };
  for (const key of ["startedAt", "completedAt", "durationMs"] as const) {
    const projected = boundedRpcProjectionInteger(value[key]);
    if (projected !== undefined) turn[key] = projected;
  }
  const error = compactTurnError(value.error);
  if (error !== undefined) turn.error = error;
  if (Array.isArray(value.items) && value.items.length > 0) {
    turn.streamOmittedItems = value.items.length;
  }
  return turn;
}

function compactRpcThreadMetadata(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const thread: Record<string, unknown> = {
    id: value.id.slice(0, MAX_RESYNC_ID_CHARACTERS),
  };
  for (const key of [
    "cwd",
    "name",
    "preview",
    "model",
    "modelProvider",
    "historyMode",
    "source",
    "cliVersion",
    "status",
  ] as const) {
    const projected = boundedRpcProjectionString(value[key], key === "preview" ? 10_000 : MAX_COMPACT_RPC_TEXT_CHARACTERS);
    if (projected !== undefined) thread[key] = projected;
  }
  for (const key of ["createdAt", "updatedAt", "recencyAt"] as const) {
    const projected = boundedRpcProjectionInteger(value[key]);
    if (projected !== undefined) thread[key] = projected;
  }
  for (const key of ["isPinned", "ephemeral", "canAcceptDirectInput"] as const) {
    if (typeof value[key] === "boolean") thread[key] = value[key];
  }
  if (isRecord(value.status) && typeof value.status.type === "string") {
    thread.status = {
      type: value.status.type.slice(0, 128),
      ...(Array.isArray(value.status.activeFlags)
        ? {
            activeFlags: value.status.activeFlags
              .slice(0, 32)
              .flatMap((entry) => typeof entry === "string" ? [entry.slice(0, 128)] : []),
          }
        : {}),
    };
  }
  return thread;
}

function compactRpcThread(value: unknown): Record<string, unknown> | null {
  const thread = compactRpcThreadMetadata(value);
  if (!thread || !isRecord(value)) return thread;
  if (Array.isArray(value.turns)) {
    thread.turns = value.turns.slice(-MAX_COMPACT_RPC_TURNS).flatMap((entry) => {
      const turn = compactRpcTurn(entry);
      return turn ? [turn] : [];
    });
    if (value.turns.length > MAX_COMPACT_RPC_TURNS) {
      thread.turnsOmitted = value.turns.length - MAX_COMPACT_RPC_TURNS;
    }
  }
  return thread;
}

function compactRpcThreadShell(value: unknown): Record<string, unknown> | null {
  const thread = compactRpcThreadMetadata(value);
  if (!thread) return null;
  if (!isRecord(value) || !Array.isArray(value.turns)) return thread;
  thread.turns = value.turns.slice(-MAX_COMPACT_RPC_TURNS).flatMap((entry) => {
    const turn = compactRpcTurnShell(entry);
    return turn ? [turn] : [];
  });
  return thread;
}

function compactRpcTurnsPage(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !Array.isArray(value.data)) return null;
  if (value.data.length > MAX_COMPACT_RPC_PAGE_TURNS) return null;
  if (value.data.length > MAX_COMPACT_RPC_TURNS) return compactRpcTurnsPageShell(value);
  const data = value.data.slice(0, MAX_COMPACT_RPC_TURNS).flatMap((entry) => {
    const turn = compactRpcTurn(entry);
    return turn ? [turn] : [];
  });
  return {
    data,
    nextCursor: boundedRpcProjectionString(value.nextCursor, MAX_COMPACT_RPC_CURSOR_CHARACTERS) ?? null,
    backwardsCursor: boundedRpcProjectionString(value.backwardsCursor, MAX_COMPACT_RPC_CURSOR_CHARACTERS) ?? null,
  };
}

function compactRpcTurnsPageShell(value: unknown): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    value.data.length > MAX_COMPACT_RPC_PAGE_TURNS
  ) {
    return null;
  }
  return {
    data: value.data.flatMap((entry) => {
      const turn = compactRpcTurnShell(entry);
      return turn ? [turn] : [];
    }),
    nextCursor: boundedRpcProjectionString(value.nextCursor, MAX_COMPACT_RPC_CURSOR_CHARACTERS) ?? null,
    backwardsCursor: boundedRpcProjectionString(value.backwardsCursor, MAX_COMPACT_RPC_CURSOR_CHARACTERS) ?? null,
  };
}

function compactOversizedRpcResult(
  method: string,
  result: unknown,
): unknown | null {
  if (!isRecord(result)) return null;
  if (method === "thread/read" || method === "thread/resume") {
    const thread = compactRpcThread(result.thread);
    if (!thread) return null;
    const output: Record<string, unknown> = { thread };
    for (const key of [
      "model",
      "modelProvider",
      "serviceTier",
      "cwd",
      "approvalPolicy",
      "approvalsReviewer",
      "reasoningEffort",
    ] as const) {
      const projected = boundedRpcProjectionString(result[key]);
      if (projected !== undefined) output[key] = projected;
    }
    if (isRecord(result.sandbox) && typeof result.sandbox.type === "string") {
      output.sandbox = { type: result.sandbox.type.slice(0, 128) };
    }
    const initialTurnsPage = compactRpcTurnsPage(result.initialTurnsPage);
    if (initialTurnsPage) output.initialTurnsPage = initialTurnsPage;
    for (const key of ["turnsBackwardsCursor", "itemsBackwardsCursor"] as const) {
      const projected = boundedRpcProjectionString(result[key], MAX_COMPACT_RPC_CURSOR_CHARACTERS);
      if (projected !== undefined) output[key] = projected;
    }
    return output;
  }
  if (method === "thread/turns/list") return compactRpcTurnsPage(result);
  if (method === "turn/start") {
    const turn = compactRpcTurn(result.turn);
    return turn ? { turn } : null;
  }
  return null;
}

function compactOversizedRpcResultShell(
  method: string,
  result: unknown,
): unknown | null {
  if (!isRecord(result)) return null;
  if (method === "thread/read" || method === "thread/resume") {
    const thread = compactRpcThreadShell(result.thread);
    if (!thread) return null;
    const output: Record<string, unknown> = { thread };
    for (const key of [
      "model",
      "modelProvider",
      "serviceTier",
      "cwd",
      "approvalPolicy",
      "approvalsReviewer",
      "reasoningEffort",
    ] as const) {
      const projected = boundedRpcProjectionString(result[key]);
      if (projected !== undefined) output[key] = projected;
    }
    if (isRecord(result.sandbox) && typeof result.sandbox.type === "string") {
      output.sandbox = { type: result.sandbox.type.slice(0, 128) };
    }
    const initialTurnsPage = compactRpcTurnsPageShell(result.initialTurnsPage);
    if (initialTurnsPage) output.initialTurnsPage = initialTurnsPage;
    for (const key of ["turnsBackwardsCursor", "itemsBackwardsCursor"] as const) {
      const projected = boundedRpcProjectionString(result[key], MAX_COMPACT_RPC_CURSOR_CHARACTERS);
      if (projected !== undefined) output[key] = projected;
    }
    return output;
  }
  if (method === "thread/turns/list") return compactRpcTurnsPageShell(result);
  if (method === "turn/start") {
    const turn = compactRpcTurnShell(result.turn);
    return turn ? { turn } : null;
  }
  return null;
}

function rpcResultMayExceedGatewayLimit(method: string, result: unknown): boolean {
  const limit = MAX_SERVER_MESSAGE_BYTES - NOTIFICATION_SIZE_MARGIN_BYTES;
  return estimatedJsonBytes({ type: "rpcResult", id: "result", result }, limit) > limit;
}

function serverMessageMayExceedGatewayLimit(message: ServerMessage): boolean {
  const limit = MAX_SERVER_MESSAGE_BYTES - NOTIFICATION_SIZE_MARGIN_BYTES;
  return estimatedJsonBytes(message, limit) > limit;
}

function logOversizedRpcResult(method: string): void {
  console.error(`[ask-codex] oversized app-server RPC result ${JSON.stringify({
    method: method.slice(0, MAX_RESYNC_METHOD_CHARACTERS),
    action: "compactProjection",
  })}`);
}

function boundedRpcResultForProcessing(method: string, result: unknown): unknown {
  if (!rpcResultMayExceedGatewayLimit(method, result)) return result;
  logOversizedRpcResult(method);
  const compact = compactOversizedRpcResult(method, result);
  if (compact === null) throw new OversizedCodexResultError(method);
  if (!rpcResultMayExceedGatewayLimit(method, compact)) return compact;
  const shell = compactOversizedRpcResultShell(method, result);
  if (shell === null || rpcResultMayExceedGatewayLimit(method, shell)) {
    throw new OversizedCodexResultError(method);
  }
  return shell;
}

export class AskCodexServer {
  readonly app = express();
  readonly httpServer = createServer(this.app);
  readonly webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BROWSER_MESSAGE_BYTES,
  });

  private readonly clients = new Set<WebSocket>();
  private readonly authenticatingClients = new Set<WebSocket>();
  private readonly ownership = new ThreadOwnership();
  private readonly attachmentOwnerId = randomBytes(24).toString("base64url");
  private readonly activeAttachmentLeases = new Map<string, AttachmentLease[]>();
  private readonly completedAttachmentTurns = new Set<string>();
  private readonly pendingAttachmentStarts = new Map<string, number>();
  private readonly attachments: AttachmentStore;
  private readonly fileDownloads: FileDownloadStore;
  private readonly messageQueue: MessageQueueStore;
  private readonly turnPlans = new TurnPlanCache();
  private readonly createFileDownloadTransferTimeout: CreateFileDownloadTransferTimeout;
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly inFlightRpc = new Map<WebSocket, number>();
  private readonly threadOwnershipRpcTails = new Map<string, Promise<boolean>>();
  private readonly threadSandboxAuthorities = new Map<string, TurnSandboxAuthority>();
  private totalInFlightRpc = 0;
  private inFlightAttachmentUploads = 0;
  private codexErrorRevision = 0;
  private started = false;

  constructor(
    readonly config: AskCodexConfig,
    readonly codex: CodexGateway = new CodexAppServer({
      command: process.env.CODEX_BIN || "codex",
      onStdoutLineDiagnostic: logLargeStdoutLine,
    }),
    attachments?: AttachmentStore,
    fileDownloads?: FileDownloadStore,
    downloadTimeoutFactory: CreateFileDownloadTransferTimeout = createFileDownloadTransferTimeout,
    messageQueue?: MessageQueueStore,
  ) {
    assertSafeBind(config.host, config.token, config.publicOrigin);
    assertDirectory(config.defaultCwd, "defaultCwd");
    this.attachments = attachments ?? new AttachmentStore();
    this.fileDownloads = fileDownloads ?? new FileDownloadStore();
    this.messageQueue = messageQueue ?? new MessageQueueStore({
      filePath: config.messageQueuePath,
    });
    this.createFileDownloadTransferTimeout = downloadTimeoutFactory;
    this.httpServer.maxConnections = MAX_HTTP_CONNECTIONS;
    this.httpServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
    this.httpServer.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
    this.httpServer.keepAliveTimeout = 5_000;
    this.httpServer.maxRequestsPerSocket = 100;
    this.configureHttp();
    this.configureWebSocket();
    this.configureCodexEvents();
  }

  async start(): Promise<StartedServer> {
    if (this.started) {
      return this.address();
    }

    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => rejectListen(error);
      this.httpServer.once("error", onError);
      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.httpServer.off("error", onError);
        resolveListen();
      });
    });
    this.started = true;

    // The web server remains usable when Codex cannot initialize. A later RPC retries it.
    void this.codex.start().catch(() => undefined);
    return this.address();
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    try {
      this.codex.close();
    } catch (error) {
      failures.push(error);
    }
    this.pendingServerRequests.clear();
    for (const client of this.clients) {
      client.terminate();
    }
    for (const client of this.authenticatingClients) {
      client.terminate();
    }
    this.clients.clear();
    this.authenticatingClients.clear();
    this.activeAttachmentLeases.clear();
    this.completedAttachmentTurns.clear();
    this.pendingAttachmentStarts.clear();
    const fileDownloadsClose = this.fileDownloads.close();

    const webSocketClose = new Promise<void>((resolveClose) => {
      this.webSocketServer.close(() => resolveClose());
    });
    const httpClose = this.httpServer.listening
      ? new Promise<void>((resolveClose, rejectClose) => {
        this.httpServer.close((error) => {
          if (error) {
            rejectClose(error);
          } else {
            resolveClose();
          }
        });
      })
      : Promise.resolve();
    const networkResults = await Promise.allSettled([webSocketClose, httpClose]);
    for (const result of networkResults) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    const storageResults = await Promise.allSettled([
      this.attachments.close(),
      fileDownloadsClose,
    ]);
    for (const result of storageResults) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    this.started = false;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Ask Codex server did not close cleanly");
    }
  }

  private configureHttp(): void {
    this.app.disable("x-powered-by");
    this.app.use((request, response, next) => {
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; base-uri 'self'; connect-src 'self' ws: wss:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' blob: data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
      );
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Frame-Options", "DENY");
      if (!isAllowedOrigin(
        request.headers.origin,
        request.headers.host,
        this.config.host,
        this.config.production,
        this.config.publicOrigin,
      )) {
        if (
          request.path.startsWith("/api/attachments") ||
          request.path.startsWith("/api/file-attachments") ||
          request.path.startsWith("/api/file-downloads")
        ) {
          closeRejectedAttachmentRequest(request, response);
        }
        response.status(403).json({ error: "Origin not allowed" });
        return;
      }
      next();
    });
    this.app.use("/api", (request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      if (!isHttpAuthorized(request, this.config.token)) {
        if (
          request.path.startsWith("/attachments") ||
          request.path.startsWith("/file-attachments") ||
          request.path.startsWith("/file-downloads")
        ) {
          closeRejectedAttachmentRequest(request, response);
        }
        response.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
    });

    this.app.get("/api/bootstrap", (_request, response) => {
      const body: {
        ready: boolean;
        defaultCwd: string;
        authRequired: boolean;
        codexVersion?: string;
      } = {
        ready: this.codex.status === "ready",
        defaultCwd: this.config.defaultCwd,
        authRequired: Boolean(this.config.token),
      };
      if (this.codex.version) {
        body.codexVersion = this.codex.version;
      }
      response.json(body);
    });

    this.app.get("/api/health", (_request, response) => {
      response.json({ ok: true, ready: this.codex.status === "ready" });
    });

    const attachmentBody = express.raw({
      inflate: false,
      limit: DEFAULT_ATTACHMENT_STORE_LIMITS.maxAttachmentBytes,
      type: () => true,
    });
    const guardAttachmentUpload: express.RequestHandler = (request, response, next) => {
      if (this.inFlightAttachmentUploads >= MAX_IN_FLIGHT_ATTACHMENT_UPLOADS) {
        closeRejectedAttachmentRequest(request, response);
        response.status(429).json({
          error: {
            code: "tooManyUploads",
            message: "Too many attachment uploads are in progress",
          },
        });
        return;
      }
      const contentLength = request.headers["content-length"];
      if (
        contentLength !== undefined &&
        (!/^\d+$/.test(contentLength) ||
          Number(contentLength) > DEFAULT_ATTACHMENT_STORE_LIMITS.maxAttachmentBytes)
      ) {
        closeRejectedAttachmentRequest(request, response);
        response.status(413).json({
          error: {
            code: "attachmentTooLarge",
            message: "Attachment exceeds the per-file size limit",
          },
        });
        return;
      }
      this.inFlightAttachmentUploads += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        this.inFlightAttachmentUploads = Math.max(0, this.inFlightAttachmentUploads - 1);
      };
      response.once("finish", release);
      response.once("close", release);
      next();
    };
    this.app.post(
      "/api/attachments",
      guardAttachmentUpload,
      attachmentBody,
      async (request, response) => {
        const mediaType = request.headers["content-type"];
        const data = request.body;
        if (typeof mediaType !== "string" || !Buffer.isBuffer(data)) {
          response.status(400).json({
            error: { code: "invalidPayload", message: "Attachment payload is invalid" },
          });
          return;
        }
        const attachment = await this.attachments.store(this.attachmentOwnerId, {
          mediaType,
          data,
        });
        response.status(201).json({ attachment });
      },
    );
    this.app.post(
      "/api/file-attachments",
      guardAttachmentUpload,
      attachmentBody,
      async (request, response) => {
        const mediaType = request.headers["content-type"];
        const name = decodedAttachmentFileName(request.headers["x-ask-codex-file-name"]);
        const data = request.body;
        if (typeof mediaType !== "string" || !name || !Buffer.isBuffer(data)) {
          response.status(400).json({
            error: { code: "invalidPayload", message: "Attachment payload is invalid" },
          });
          return;
        }
        const attachment = await this.attachments.store(this.attachmentOwnerId, {
          kind: "file",
          name,
          mediaType,
          data,
        });
        response.status(201).json({ attachment });
      },
    );
    this.app.delete("/api/attachments/:attachmentId", async (request, response) => {
      await this.attachments.discard(this.attachmentOwnerId, request.params.attachmentId);
      response.status(204).end();
    });
    this.app.delete("/api/file-attachments/:attachmentId", async (request, response) => {
      await this.attachments.discard(this.attachmentOwnerId, request.params.attachmentId);
      response.status(204).end();
    });
    this.app.use(["/api/attachments", "/api/file-attachments"], (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      next: express.NextFunction,
    ) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      if (isRecord(error) && typeof error.type === "string") {
        closeRejectedAttachmentRequest(_request, response);
      }
      const normalized = attachmentHttpError(error);
      response.status(normalized.status).json({
        error: { code: normalized.code, message: normalized.message },
      });
    });

    const fileDownloadBody = express.raw({
      inflate: false,
      limit: 1,
      type: () => true,
    });
    this.app.post(
      "/api/file-downloads/:capabilityId",
      fileDownloadBody,
      async (request, response) => {
        if (
          (Buffer.isBuffer(request.body) && request.body.length > 0) ||
          Object.keys(request.query).length > 0
        ) {
          response.status(400).json({
            error: {
              code: "invalidFileDownloadRequest",
              message: "File download request is invalid",
            },
          });
          return;
        }

        let lease: FileDownloadLease | undefined;
        let transferTimeout: FileDownloadTransferTimeout | undefined;
        try {
          lease = await this.fileDownloads.consume(request.params.capabilityId);
          transferTimeout = this.createFileDownloadTransferTimeout(
            FILE_DOWNLOAD_TRANSFER_TIMEOUT_MS,
          );
          const source = lease.createReadStream();
          if (lease.size > 0) {
            await waitForFirstFileDownloadChunk(source, transferTimeout.signal);
          }
          response.status(200);
          response.setHeader("Content-Type", "application/octet-stream");
          response.setHeader("Content-Length", String(lease.size));
          response.setHeader(
            "Content-Disposition",
            contentDispositionAttachment(lease.name),
          );
          await pipeline(source, response, {
            signal: transferTimeout.signal,
          });
        } catch (error) {
          if (!response.destroyed && !response.headersSent) {
            const normalized = fileDownloadHttpError(error);
            response.removeHeader("Content-Disposition");
            response.removeHeader("Content-Length");
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.status(normalized.status).json({
              error: { code: normalized.code, message: normalized.message },
            });
          } else if (!response.destroyed) {
            response.destroy();
          }
        } finally {
          transferTimeout?.clear();
          await lease?.release();
        }
      },
    );
    this.app.use("/api/file-downloads", (
      error: unknown,
      request: express.Request,
      response: express.Response,
      next: express.NextFunction,
    ) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      if (isRecord(error) && typeof error.type === "string") {
        closeRejectedAttachmentRequest(request, response);
      }
      response.status(400).json({
        error: {
          code: "invalidFileDownloadRequest",
          message: "File download request is invalid",
        },
      });
    });
    this.app.use("/api/file-downloads", (
      _request: express.Request,
      response: express.Response,
    ) => {
      response.status(404).json({
        error: {
          code: "fileDownloadNotFound",
          message: "File download is unavailable",
        },
      });
    });

    if (this.config.production) {
      const indexFile = join(this.config.distDir, "index.html");
      this.app.use(express.static(this.config.distDir, { index: false }));
      if (existsSync(indexFile)) {
        this.app.get(/^(?!\/api(?:\/|$)|\/ws(?:\/|$)).*/, (_request, response, next) => {
          response.sendFile(indexFile, (error) => {
            if (error && !response.headersSent) {
              next(error);
            }
          });
        });
      }
    }
  }

  private configureWebSocket(): void {
    this.httpServer.on("upgrade", (request, socket, head) => {
      const requestTarget = request.url ?? "/";
      let requestUrl: URL;
      try {
        requestUrl = new URL(requestTarget, `http://${request.headers.host ?? "invalid"}`);
      } catch {
        this.rejectUpgrade(socket, 400, "Bad Request");
        return;
      }
      if (requestUrl.pathname !== "/ws") {
        this.rejectUpgrade(socket, 404, "Not Found");
        return;
      }
      if (requestTarget !== "/ws") {
        this.rejectUpgrade(socket, 400, "Bad Request");
        return;
      }
      if (!isAllowedOrigin(
        request.headers.origin,
        request.headers.host,
        this.config.host,
        this.config.production,
        this.config.publicOrigin,
      )) {
        this.rejectUpgrade(socket, 403, "Forbidden");
        return;
      }

      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit("connection", webSocket, request);
      });
    });

    this.webSocketServer.on("connection", (client) => {
      if (this.clients.size + this.authenticatingClients.size >= MAX_WS_CONNECTIONS) {
        client.close(1013, "Too many connections");
        return;
      }
      this.authenticatingClients.add(client);
      client.once("close", () => this.authenticatingClients.delete(client));
      client.on("error", () => {
        // Authenticated clients use the close event for routing cleanup.
      });
      this.authenticateClient(client);
    });
  }

  private authenticateClient(client: WebSocket): void {
    const expectedToken = this.config.token;
    if (!expectedToken) {
      this.activateClient(client);
      return;
    }

    const timeout = setTimeout(() => client.terminate(), WS_AUTH_TIMEOUT_MS);
    timeout.unref();
    client.once("close", () => clearTimeout(timeout));
    client.once("message", (data, isBinary) => {
      if (isBinary) {
        client.close(1003, "Text messages only");
        return;
      }

      let message: unknown;
      try {
        message = JSON.parse(rawDataToString(data)) as unknown;
      } catch {
        client.close(1007, "Invalid JSON");
        return;
      }
      if (
        !isRecord(message) ||
        message.type !== "auth" ||
        typeof message.token !== "string" ||
        !tokenMatches(message.token, expectedToken)
      ) {
        client.close(1008, "Unauthorized");
        return;
      }

      clearTimeout(timeout);
      this.activateClient(client);
    });
  }

  private activateClient(client: WebSocket): void {
    this.authenticatingClients.delete(client);
    this.clients.add(client);
    if (!this.send(client, this.statusMessage())) {
      return;
    }
    this.offerUnroutedRequests(client);

    client.on("message", (data, isBinary) => {
      if (isBinary) {
        client.close(1003, "Text messages only");
        return;
      }
      this.handleBrowserData(client, rawDataToString(data));
    });
    client.on("close", () => this.handleClientClose(client));
  }

  private configureCodexEvents(): void {
    this.codex.on("status", (status) => this.handleCodexStatus(status));
    this.codex.on("notification", (method, params, emittedAtMs) => {
      const gatewayReceivedAtMs = Date.now();
      this.observeThreadSandboxAuthority(method, params);
      this.fileDownloads.observeNotification(method, params);
      if (method === "serverRequest/resolved" && isRecord(params) && isRpcId(params.requestId)) {
        this.pendingServerRequests.delete(rpcIdKey(params.requestId));
      }
      if (method === "turn/completed") {
        const threadId = threadIdFromParams(params);
        const turnId = turnIdFromNotification(params);
        if (threadId && turnId) this.completeAttachmentTurn(threadId, turnId);
      }
      if (method === "turn/plan/updated") {
        const planObservation = this.turnPlans.observeNotification(method, params, {
          emittedAtMs,
          gatewayReceivedAtMs,
        });
        if (planObservation.recoveryRequired) {
          this.broadcast({
            type: "notification",
            method: "gateway/resyncRequired",
            params: {
              reason: "planUnavailable",
              lostMethod: method,
              ...(planObservation.threadId === undefined ? {} : { threadId: planObservation.threadId }),
              ...(planObservation.turnId === undefined ? {} : { turnId: planObservation.turnId }),
            },
            ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
            gatewayReceivedAtMs,
          });
          return;
        }
        this.broadcast({
          type: "notification",
          method,
          params: planObservation.projectedParams,
          ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
          gatewayReceivedAtMs,
        });
        return;
      }
      const oversized = notificationMayExceedGatewayLimit(
        method,
        params,
        emittedAtMs,
        gatewayReceivedAtMs,
      );
      if (oversized) {
        const sourceMessage: Extract<ServerMessage, { type: "notification" }> = {
          type: "notification",
          method,
          params,
          ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
          gatewayReceivedAtMs,
        };
        const compact = recoverableOversizedNotification(sourceMessage);
        if (compact?.type === "notification") {
          const compactParams = sanitizeBrowserNotificationParams(method, compact.params);
          const planObservation = this.turnPlans.observeNotification(method, compactParams, {
            emittedAtMs,
            gatewayReceivedAtMs,
          });
          if (planObservation.recoveryRequired) {
            this.broadcast({
              type: "notification",
              method: "gateway/resyncRequired",
              params: {
                reason: "planUnavailable",
                lostMethod: method,
                ...(planObservation.threadId === undefined ? {} : { threadId: planObservation.threadId }),
                ...(planObservation.turnId === undefined ? {} : { turnId: planObservation.turnId }),
              },
              ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
              gatewayReceivedAtMs,
            });
            return;
          }
          const decoratedParams = this.turnPlans.decorateNotification(
            method,
            this.fileDownloads.decorateNotification(method, planObservation.projectedParams),
          );
          this.broadcast({
            type: "notification",
            method,
            params: decoratedParams,
            ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
            gatewayReceivedAtMs,
          });
          return;
        }
        this.broadcast({
          type: "notification",
          method: "gateway/resyncRequired",
          params: {
            reason: "messageTooLarge",
            lostMethod: method.slice(0, MAX_RESYNC_METHOD_CHARACTERS),
            ...(isRecord(params) && typeof params.threadId === "string"
              ? { threadId: params.threadId.slice(0, MAX_RESYNC_ID_CHARACTERS) }
              : {}),
            ...(isRecord(params) && typeof params.turnId === "string"
              ? { turnId: params.turnId.slice(0, MAX_RESYNC_ID_CHARACTERS) }
              : {}),
            ...(isRecord(params) && typeof params.itemId === "string"
              ? { itemId: params.itemId.slice(0, MAX_RESYNC_ID_CHARACTERS) }
              : {}),
          },
        });
        return;
      }
      const projectedParams = sanitizeBrowserNotificationParams(method, params);
      const planObservation = this.turnPlans.observeNotification(method, projectedParams, {
        emittedAtMs,
        gatewayReceivedAtMs,
      });
      if (planObservation.recoveryRequired) {
        this.broadcast({
          type: "notification",
          method: "gateway/resyncRequired",
          params: {
            reason: "planUnavailable",
            lostMethod: method,
            ...(planObservation.threadId === undefined
              ? {}
              : { threadId: planObservation.threadId }),
            ...(planObservation.turnId === undefined
              ? {}
              : { turnId: planObservation.turnId }),
          },
          ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
          gatewayReceivedAtMs,
        });
        return;
      }
      const decoratedParams = this.turnPlans.decorateNotification(
        method,
        this.fileDownloads.decorateNotification(method, planObservation.projectedParams),
      );
      this.broadcast({
        type: "notification",
        method,
        params: decoratedParams,
        ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
        gatewayReceivedAtMs,
      });
    });
    this.codex.on("request", (id, method, params) => {
      this.routeServerRequest({ type: "request", id, method, params });
    });
  }

  private handleBrowserData(client: WebSocket, raw: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      client.close(1007, "Invalid JSON");
      return;
    }

    const message = parseBrowserMessage(value);
    if (!message) {
      client.close(1008, "Invalid protocol message");
      return;
    }
    if (message.type === "rpc") {
      const inFlight = this.inFlightRpc.get(client) ?? 0;
      if (inFlight >= MAX_IN_FLIGHT_RPC_PER_CLIENT) {
        this.send(client, {
          type: "rpcError",
          id: message.id,
          error: { code: -32_000, message: "Too many in-flight RPC requests" },
        });
        return;
      }
      if (this.totalInFlightRpc >= MAX_IN_FLIGHT_RPC_GLOBAL) {
        this.send(client, {
          type: "rpcError",
          id: message.id,
          error: { code: -32_000, message: "Too many global in-flight RPC requests" },
        });
        return;
      }
      this.inFlightRpc.set(client, inFlight + 1);
      this.totalInFlightRpc += 1;
      void this.handleBrowserRpc(client, message).finally(() => {
        this.totalInFlightRpc = Math.max(0, this.totalInFlightRpc - 1);
        const remaining = (this.inFlightRpc.get(client) ?? 1) - 1;
        if (remaining > 0) {
          this.inFlightRpc.set(client, remaining);
        } else {
          this.inFlightRpc.delete(client);
        }
      });
    } else {
      void this.handleBrowserResponse(client, message);
    }
  }

  private async handleBrowserRpc(
    client: WebSocket,
    message: Extract<BrowserMessage, { type: "rpc" }>,
  ): Promise<void> {
    let attachmentLeases: AttachmentLease[] = [];
    let pendingAttachmentThreadId: string | undefined;
    const requestCodexErrorRevision = this.codexErrorRevision;
    try {
      if (MESSAGE_QUEUE_BROWSER_RPC_METHODS.has(message.method)) {
        const sanitizedParams = sanitizeMessageQueueRpcParams(message.method, message.params);
        const result = await this.handleMessageQueueRpc(
          client,
          message.method,
          sanitizedParams,
          requestCodexErrorRevision,
        );
        this.send(client, { type: "rpcResult", id: message.id, result });
        return;
      }
      if (!ALLOWED_BROWSER_RPC_METHODS.has(message.method)) {
        throw new MethodNotAllowedError(message.method);
      }
      const sanitizedParams = sanitizeBrowserRpcParams(message.method, message.params);
      await validateRpcCwd(message.method, sanitizedParams);
      const existingThreadId = threadIdFromParams(sanitizedParams);
      const attachmentIds = message.method === "turn/start"
        ? attachmentIdsFromTurnStart(sanitizedParams)
        : [];
      if (attachmentIds.length > 0) {
        attachmentLeases = await this.attachments.consumeForTurn(
          this.attachmentOwnerId,
          attachmentIds,
        );
      }
      const codexParams = attachmentLeases.length > 0
        ? materializeTurnStartAttachments(
          sanitizedParams,
            attachmentLeases.map((lease) => ({
              kind: lease.kind,
              mediaType: lease.mediaType,
              ...(lease.name === undefined ? {} : { name: lease.name }),
              path: lease.path,
              size: lease.size,
            })),
          )
        : sanitizedParams;
      if (attachmentLeases.length > 0 && existingThreadId) {
        pendingAttachmentThreadId = existingThreadId;
        this.pendingAttachmentStarts.set(
          existingThreadId,
          (this.pendingAttachmentStarts.get(existingThreadId) ?? 0) + 1,
        );
      }
      const fileDownloadAuthorityRevision = this.fileDownloads.captureAuthorityRevision();
      const rawResult = await this.requestCodexForBrowserRpc(
        client,
        message.method,
        codexParams,
        requestCodexErrorRevision,
      );
      const resultForProcessing = boundedRpcResultForProcessing(message.method, rawResult);
      if (message.method === "turn/start" && attachmentLeases.length > 0) {
        const turnId = turnIdFromStartResult(resultForProcessing);
        if (existingThreadId && turnId) {
          this.holdAttachmentLeases(existingThreadId, turnId, attachmentLeases);
          attachmentLeases = [];
        }
      }
      const canDecorateFileDownloads = this.fileDownloads.observeRpcResult(
        message.method,
        sanitizedParams,
        resultForProcessing,
        fileDownloadAuthorityRevision,
      );
      this.turnPlans.observeRpcResult(message.method, sanitizedParams, resultForProcessing);
      const projectedResult = sanitizeBrowserRpcResult(
        message.method,
        resultForProcessing,
        sanitizedParams,
      );
      const fileDecoratedResult = canDecorateFileDownloads
          ? this.fileDownloads.decorateRpcResult(
            message.method,
            sanitizedParams,
            projectedResult,
            fileDownloadAuthorityRevision,
          )
        : projectedResult;
      const result = this.turnPlans.decorateRpcResult(
        message.method,
        sanitizedParams,
        fileDecoratedResult,
      );
      this.send(client, { type: "rpcResult", id: message.id, result });
    } catch (error) {
      this.send(client, {
        type: "rpcError",
        id: message.id,
        error: errorPayload(message.method, error),
      });
    } finally {
      if (pendingAttachmentThreadId) {
        const remaining = (this.pendingAttachmentStarts.get(pendingAttachmentThreadId) ?? 1) - 1;
        if (remaining > 0) this.pendingAttachmentStarts.set(pendingAttachmentThreadId, remaining);
        else this.pendingAttachmentStarts.delete(pendingAttachmentThreadId);
      }
      if (attachmentLeases.length > 0) {
        await Promise.allSettled(attachmentLeases.map((lease) => lease.release()));
      }
    }
  }

  private async handleMessageQueueRpc(
    client: WebSocket,
    method: string,
    params: Record<string, unknown>,
    requestCodexErrorRevision: number,
  ): Promise<unknown> {
    if (method === "messageQueue/list") {
      return this.messageQueue.list(params.threadId as string);
    }
    if (method === "messageQueue/enqueue") {
      const threadId = params.threadId as string;
      this.assertThreadOwnershipRpcCanStart(client, requestCodexErrorRevision, method);
      try {
        const readResult = await this.codex.request("thread/read", {
          threadId,
          includeTurns: false,
        });
        this.assertThreadOwnershipRpcCanStart(client, requestCodexErrorRevision, method);
        const thread = isRecord(readResult) && isRecord(readResult.thread)
          ? readResult.thread
          : undefined;
        if (thread?.id !== threadId) {
          throw new Error("thread ID mismatch");
        }
      } catch {
        throw new MessageQueueError("Queued message thread is unavailable");
      }
      const item = this.messageQueue.enqueue({
        threadId,
        text: params.text as string,
        expectedLastTurnId: params.expectedLastTurnId as string | null,
      });
      this.broadcastMessageQueueChanged(item.threadId);
      return { item };
    }
    if (method === "messageQueue/cancel") {
      const item = this.messageQueue.cancel(
        params.id as string,
        params.revision as number,
      );
      this.broadcastMessageQueueChanged(item.threadId);
      return { item };
    }
    if (method !== "messageQueue/send") {
      throw new MethodNotAllowedError(method);
    }

    const claimId = randomBytes(24).toString("base64url");
    const item = this.messageQueue.claim(
      params.id as string,
      params.revision as number,
      claimId,
      params.confirmReview === true,
    );
    this.broadcastMessageQueueChanged(item.threadId);
    try {
      return await this.dispatchQueuedMessage(
        client,
        item,
        claimId,
        params.confirmReview === true,
        requestCodexErrorRevision,
      );
    } catch (error) {
      try {
        const review = this.messageQueue.markNeedsReview(
          item.id,
          claimId,
          "threadUnavailable",
        );
        this.broadcastMessageQueueChanged(review.threadId);
      } catch {
        // The dispatch path already moved the item to a more precise state.
      }
      if (error instanceof MessageQueueError) throw error;
      throw new MessageQueueError("Queued message was not sent; review before retrying");
    }
  }

  private async dispatchQueuedMessage(
    client: WebSocket,
    item: MessageQueueItem,
    claimId: string,
    confirmReview: boolean,
    requestCodexErrorRevision: number,
  ): Promise<unknown> {
    return await this.serializeThreadOwnershipRpc(
      item.threadId,
      "messageQueue/send",
      async (setFailureOutcomeKnown) => {
        setFailureOutcomeKnown(true);
        this.assertThreadOwnershipRpcCanStart(
          client,
          requestCodexErrorRevision,
          "messageQueue/send",
        );

        let snapshot: QueuedThreadSnapshot;
        try {
          const readResult = await this.codex.request("thread/read", {
            threadId: item.threadId,
            includeTurns: true,
          });
          this.assertThreadOwnershipRpcCanStart(
            client,
            requestCodexErrorRevision,
            "messageQueue/send",
          );
          snapshot = queuedThreadSnapshot(readResult, item.threadId);
        } catch {
          const review = this.messageQueue.markNeedsReview(
            item.id,
            claimId,
            "threadUnavailable",
          );
          this.broadcastMessageQueueChanged(review.threadId);
          throw new MessageQueueError("Queued message thread state is unavailable");
        }
        if (snapshot.busy || snapshot.systemError) {
          const review = this.messageQueue.markNeedsReview(
            item.id,
            claimId,
            snapshot.busy ? "threadBusy" : "threadUnavailable",
          );
          this.broadcastMessageQueueChanged(review.threadId);
          throw new MessageQueueError(
            snapshot.busy
              ? "Queued message thread is busy"
              : "Queued message thread state is unavailable",
          );
        }
        const contextChanged = snapshot.lastTurnId !== item.expectedLastTurnId;
        const reviewedContextChange = confirmReview && item.reviewReason === "contextChanged";
        if (contextChanged && !reviewedContextChange) {
          const review = this.messageQueue.markNeedsReview(
            item.id,
            claimId,
            "contextChanged",
          );
          this.broadcastMessageQueueChanged(review.threadId);
          throw new MessageQueueError("Queued message context changed; review before sending");
        }

        const resumeParams = {
          threadId: item.threadId,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          excludeTurns: true,
        };
        let turnAuthority: TurnSandboxAuthority | undefined;
        try {
          setFailureOutcomeKnown(false);
          const resumeResult = await this.codex.request("thread/resume", resumeParams);
          setFailureOutcomeKnown(true);
          const sandboxPolicy = resumeResultSandboxPolicy(resumeResult, item.threadId);
          this.rememberThreadSandboxAuthority(item.threadId, sandboxPolicy);
          turnAuthority = this.threadSandboxAuthorities.get(item.threadId);
          this.assertThreadOwnershipRpcCanStart(
            client,
            requestCodexErrorRevision,
            "messageQueue/send",
          );
        } catch {
          setFailureOutcomeKnown(true);
          const review = this.messageQueue.markNeedsReview(
            item.id,
            claimId,
            "threadUnavailable",
          );
          this.broadcastMessageQueueChanged(review.threadId);
          throw new MessageQueueError("Queued message thread could not be prepared");
        }
        if (!turnAuthority) {
          throw new MessageQueueError("Queued message thread could not be prepared");
        }

        const dispatching = this.messageQueue.markDispatching(item.id, claimId);
        this.broadcastMessageQueueChanged(dispatching.threadId);
        const turnParams = materializeTurnExecutionPolicy({
          threadId: item.threadId,
          input: [{ type: "text", text: item.text, text_elements: [] }],
          executionMode: "manual",
        }, turnAuthority);
        let resultObserved = false;
        let confirmedItem: MessageQueueItem | undefined;
        let projectedResult: unknown;
        try {
          setFailureOutcomeKnown(false);
          await this.codex.requestWithResultObserver(
            "turn/start",
            turnParams,
            (result) => {
              resultObserved = true;
              const resultForProcessing = boundedRpcResultForProcessing("turn/start", result);
              const turnId = turnIdFromStartResult(resultForProcessing);
              if (!turnId) {
                throw new Error("Codex app-server returned an invalid turn/start result");
              }
              this.turnPlans.observeRpcResult("turn/start", turnParams, resultForProcessing);
              projectedResult = this.turnPlans.decorateRpcResult(
                "turn/start",
                turnParams,
                sanitizeBrowserRpcResult("turn/start", resultForProcessing, turnParams),
              );
              confirmedItem = this.messageQueue.confirm(item.id, claimId, turnId);
              setFailureOutcomeKnown(true);
              this.claimThreadOwnership(item.threadId, client);
              this.broadcastMessageQueueChanged(item.threadId);
            },
          );
          setFailureOutcomeKnown(true);
          if (!resultObserved || !confirmedItem) {
            throw new Error("Codex app-server returned an invalid turn/start result");
          }
        } catch (error) {
          if (error instanceof CodexRpcError && !resultObserved) {
            setFailureOutcomeKnown(true);
            const review = this.messageQueue.markNeedsReview(
              item.id,
              claimId,
              "dispatchRejected",
            );
            this.broadcastMessageQueueChanged(review.threadId);
            throw new MessageQueueError("Codex rejected the queued message; review before retrying");
          }
          try {
            const indeterminate = this.messageQueue.markIndeterminate(item.id, claimId);
            this.broadcastMessageQueueChanged(indeterminate.threadId);
          } catch {
            // A durable confirmation may already have won the result race.
          }
          throw new MessageQueueError(
            "Queued message outcome is indeterminate; inspect thread history before removing it",
          );
        }

        const turn = isRecord(projectedResult) ? projectedResult.turn : undefined;
        return { item: confirmedItem, ...(turn === undefined ? {} : { turn }) };
      },
    );
  }

  private broadcastMessageQueueChanged(threadId: string): void {
    const { revision } = this.messageQueue.list(threadId);
    this.broadcast({
      type: "notification",
      method: "messageQueue/changed",
      params: { threadId, revision },
    });
  }

  private async requestCodexForBrowserRpc(
    client: WebSocket,
    method: string,
    params: unknown,
    requestCodexErrorRevision: number,
  ): Promise<unknown> {
    if (method === "thread/start" || method === "thread/fork") {
      this.assertThreadOwnershipRpcCanStart(client, requestCodexErrorRevision, method);
      const result = await this.codex.requestWithResultObserver(method, params, (result) => {
        this.assertCodexErrorRevisionCurrent(requestCodexErrorRevision, method);
        const projectedResult = method === "thread/fork"
          ? sanitizeBrowserRpcResult(method, result, params)
          : result;
        const threadId = threadIdFromStartResult(projectedResult);
        if (!threadId) {
          throw new Error(`Codex app-server returned an invalid ${method} result`);
        }
        if (method === "thread/fork" && this.ownership.get(threadId)) {
          throw new Error("Codex app-server returned an invalid thread/fork result");
        }
        const sandboxPolicy = resultSandboxPolicy(
          result,
          threadId,
          `Codex app-server returned an invalid ${method} sandbox`,
        );
        this.rememberThreadSandboxAuthority(threadId, sandboxPolicy);
        this.claimThreadOwnership(threadId, client);
      });
      this.assertCodexErrorRevisionCurrent(requestCodexErrorRevision, method);
      return result;
    }
    if (
      method !== "thread/resume" &&
      method !== "turn/start" &&
      method !== "turn/steer"
    ) {
      return this.codex.request(method, params);
    }

    const threadId = threadIdFromParams(params);
    if (!threadId) {
      throw new ClientInputError(`${method} threadId must be a non-empty string`);
    }
    return this.serializeThreadOwnershipRpc(threadId, method, async (setFailureOutcomeKnown) => {
      setFailureOutcomeKnown(true);
      this.assertThreadOwnershipRpcCanStart(client, requestCodexErrorRevision, method);
      let codexParams = params;
      if (method === "turn/start") {
        let authority = this.threadSandboxAuthorities.get(threadId);
        if (!authority) {
          setFailureOutcomeKnown(false);
          const probeResult = await this.codex.request("thread/resume", {
            threadId,
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            excludeTurns: true,
          });
          const sandboxPolicy = resumeResultSandboxPolicy(probeResult, threadId);
          this.rememberThreadSandboxAuthority(threadId, sandboxPolicy);
          authority = this.threadSandboxAuthorities.get(threadId);
          setFailureOutcomeKnown(true);
        }
        if (!authority) {
          throw new ClientInputError("turn/start could not verify the existing sandbox");
        }
        codexParams = materializeTurnExecutionPolicy(params, authority);
      }
      setFailureOutcomeKnown(false);
      const result = await this.codex.requestWithResultObserver(method, codexParams, (result) => {
        this.assertCodexErrorRevisionCurrent(requestCodexErrorRevision, method);
        if (method === "thread/resume") {
          const sandboxPolicy = resumeResultSandboxPolicy(result, threadId);
          this.rememberThreadSandboxAuthority(threadId, sandboxPolicy);
        } else if (method === "turn/start") {
          if (!turnIdFromStartResult(result)) {
            throw new Error("Codex app-server returned an invalid turn/start result");
          }
        } else {
          sanitizeBrowserRpcResult(method, result, params);
        }
        this.claimThreadOwnership(threadId, client);
      });
      setFailureOutcomeKnown(true);
      this.assertCodexErrorRevisionCurrent(requestCodexErrorRevision, method);
      return result;
    });
  }

  private assertCodexErrorRevisionCurrent(
    requestCodexErrorRevision: number,
    method: string,
  ): void {
    if (requestCodexErrorRevision !== this.codexErrorRevision) {
      throw new Error(`${method} was canceled after Codex entered an error state`);
    }
  }

  private assertThreadOwnershipRpcCanStart(
    client: WebSocket,
    requestCodexErrorRevision: number,
    method: string,
  ): void {
    this.assertCodexErrorRevisionCurrent(requestCodexErrorRevision, method);
    if (!this.clients.has(client) || client.readyState !== WebSocket.OPEN) {
      throw new Error(`${method} was canceled after its requester disconnected`);
    }
  }

  private claimThreadOwnership(threadId: string, client: WebSocket): void {
    if (this.clients.has(client) && client.readyState === WebSocket.OPEN) {
      this.ownership.set(threadId, client);
    }
  }

  private rememberThreadSandboxAuthority(
    threadId: string,
    current: GatewaySandboxPolicy,
  ): void {
    const previous = this.threadSandboxAuthorities.get(threadId);
    const authority: TurnSandboxAuthority = {
      current,
      ...(current.type === "workspaceWrite"
        ? { workspaceWrite: current }
        : previous?.workspaceWrite
          ? { workspaceWrite: previous.workspaceWrite }
          : {}),
    };
    this.threadSandboxAuthorities.delete(threadId);
    this.threadSandboxAuthorities.set(threadId, authority);
    while (this.threadSandboxAuthorities.size > MAX_THREAD_SANDBOX_AUTHORITIES) {
      const oldestThreadId = this.threadSandboxAuthorities.keys().next().value as string | undefined;
      if (oldestThreadId === undefined) break;
      this.threadSandboxAuthorities.delete(oldestThreadId);
    }
  }

  private observeThreadSandboxAuthority(method: string, params: unknown): void {
    const threadId = threadIdFromParams(params);
    if (!threadId) return;
    if (method === "thread/deleted") {
      this.threadSandboxAuthorities.delete(threadId);
      return;
    }
    if (method !== "thread/settings/updated") return;
    const threadSettings = isRecord(params) && isRecord(params.threadSettings)
      ? params.threadSettings
      : undefined;
    if (!threadSettings || !Object.hasOwn(threadSettings, "sandboxPolicy")) return;
    const sandboxPolicy = normalizeGatewaySandboxPolicy(threadSettings.sandboxPolicy);
    if (sandboxPolicy) {
      this.rememberThreadSandboxAuthority(threadId, sandboxPolicy);
    } else {
      this.threadSandboxAuthorities.delete(threadId);
    }
  }

  private serializeThreadOwnershipRpc(
    threadId: string,
    method: string,
    operation: (setFailureOutcomeKnown: (known: boolean) => void) => Promise<unknown>,
  ): Promise<unknown> {
    const previous = this.threadOwnershipRpcTails.get(threadId) ?? Promise.resolve(true);
    let failureOutcomeKnown = false;
    const result = previous.then((canContinue) => {
      if (!canContinue) {
        throw new Error(
          `${method} was canceled because an earlier thread operation had an indeterminate result`,
        );
      }
      return operation((known) => {
        failureOutcomeKnown = known;
      });
    });
    const tail = result.then(
      () => true,
      (error: unknown) => error instanceof CodexRpcError || failureOutcomeKnown,
    );
    this.threadOwnershipRpcTails.set(threadId, tail);
    return result.finally(() => {
      if (this.threadOwnershipRpcTails.get(threadId) === tail) {
        this.threadOwnershipRpcTails.delete(threadId);
      }
    });
  }

  private holdAttachmentLeases(
    threadId: string,
    turnId: string,
    leases: AttachmentLease[],
  ): void {
    const key = attachmentTurnKey(threadId, turnId);
    if (this.completedAttachmentTurns.delete(key)) {
      void Promise.allSettled(leases.map((lease) => lease.release()));
      return;
    }
    const previous = this.activeAttachmentLeases.get(key);
    this.activeAttachmentLeases.set(key, leases);
    if (previous) void Promise.allSettled(previous.map((lease) => lease.release()));
  }

  private completeAttachmentTurn(threadId: string, turnId: string): void {
    const key = attachmentTurnKey(threadId, turnId);
    const leases = this.activeAttachmentLeases.get(key);
    if (leases) {
      this.activeAttachmentLeases.delete(key);
      void Promise.allSettled(leases.map((lease) => lease.release()));
      return;
    }
    if (!this.pendingAttachmentStarts.has(threadId)) return;
    this.completedAttachmentTurns.add(key);
    if (this.completedAttachmentTurns.size > MAX_COMPLETED_ATTACHMENT_TURNS) {
      const oldest = this.completedAttachmentTurns.values().next().value;
      if (typeof oldest === "string") this.completedAttachmentTurns.delete(oldest);
    }
  }

  private async handleBrowserResponse(
    client: WebSocket,
    message: Extract<BrowserMessage, { type: "response" }>,
  ): Promise<void> {
    const key = rpcIdKey(message.id);
    const pending = this.pendingServerRequests.get(key);
    if (!pending || !pending.recipients.has(client)) {
      return;
    }
    try {
      const response = normalizeServerRequestResponse(pending.message, message);
      this.pendingServerRequests.delete(key);
      if (Object.prototype.hasOwnProperty.call(response, "error")) {
        await this.codex.respond(message.id, undefined, response.error);
      } else {
        await this.codex.respond(message.id, response.result);
      }
    } catch (error) {
      if (error instanceof ClientRpcError) {
        client.close(1008, "Invalid server request response");
      }
      // A Codex status event reports app-server failures to every browser.
    }
  }

  private routeServerRequest(message: RequestMessage): void {
    const key = rpcIdKey(message.id);
    if (!this.pendingServerRequests.has(key) && this.pendingServerRequests.size >= MAX_PENDING_SERVER_REQUESTS) {
      void this.codex.respond(message.id, undefined, {
        code: -32_000,
        message: "Ask Codex has too many pending server requests",
      }).catch(() => undefined);
      return;
    }
    if (!this.isOutboundMessageWithinLimit(message)) {
      void this.codex.respond(message.id, undefined, {
        code: -32_000,
        message: "Ask Codex cannot forward a server request larger than 1 MiB",
      }).catch(() => undefined);
      return;
    }
    try {
      assertServerRequestRoutable(message);
    } catch (error) {
      const code = error instanceof ClientRpcError ? error.code : -32_000;
      void this.codex.respond(message.id, undefined, {
        code,
        message: "Ask Codex cannot safely handle this approval request",
      }).catch(() => undefined);
      return;
    }
    const pending: PendingServerRequest = { message, recipients: new Set() };
    this.pendingServerRequests.set(key, pending);
    const owner = this.ownership.get(threadIdFromParams(message.params));
    if (owner?.readyState === WebSocket.OPEN) {
      if (this.deliverServerRequest(pending, [owner]) > 0) {
        return;
      }
    }
    this.deliverServerRequest(pending, this.openClients());
  }

  private offerUnroutedRequests(client: WebSocket): void {
    for (const pending of this.pendingServerRequests.values()) {
      if (pending.recipients.size === 0) {
        if (!this.clients.has(client) || client.readyState !== WebSocket.OPEN) {
          return;
        }
        this.deliverServerRequest(pending, [client]);
      }
    }
  }

  private handleClientClose(client: WebSocket): void {
    this.evictClient(client);
  }

  private evictClient(client: WebSocket): void {
    this.clients.delete(client);
    this.inFlightRpc.delete(client);
    this.ownership.deleteOwner(client);
    const orphaned: PendingServerRequest[] = [];
    for (const pending of this.pendingServerRequests.values()) {
      if (!pending.recipients.delete(client) || pending.recipients.size > 0) {
        continue;
      }
      orphaned.push(pending);
    }
    for (const pending of orphaned) {
      this.deliverServerRequest(pending, this.openClients());
    }
  }

  private deliverServerRequest(
    pending: PendingServerRequest,
    candidates: readonly WebSocket[],
  ): number {
    let delivered = 0;
    for (const candidate of candidates) {
      if (pending.recipients.has(candidate)) {
        continue;
      }
      if (this.send(candidate, pending.message)) {
        pending.recipients.add(candidate);
        delivered += 1;
      }
    }
    return delivered;
  }

  private handleCodexStatus(status: CodexStatusEvent): void {
    if (status.status === "error") {
      this.codexErrorRevision += 1;
      this.threadSandboxAuthorities.clear();
      this.fileDownloads.clearAuthority();
      this.pendingServerRequests.clear();
      const leases = [...this.activeAttachmentLeases.values()].flat();
      this.activeAttachmentLeases.clear();
      this.completedAttachmentTurns.clear();
      this.pendingAttachmentStarts.clear();
      void Promise.allSettled(leases.map((lease) => lease.release()));
    }
    const message: StatusMessage = {
      type: "status",
      status: status.status,
      defaultCwd: this.config.defaultCwd,
    };
    if (status.version) {
      message.version = status.version;
    }
    if (status.error) {
      message.error = status.error;
    }
    this.broadcast(message);
  }

  private statusMessage(): StatusMessage {
    const message: StatusMessage = {
      type: "status",
      status: this.codex.status,
      defaultCwd: this.config.defaultCwd,
    };
    if (this.codex.version) {
      message.version = this.codex.version;
    }
    if (this.codex.error) {
      message.error = this.codex.error;
    }
    return message;
  }

  private openClients(): WebSocket[] {
    return [...this.clients].filter((client) => client.readyState === WebSocket.OPEN);
  }

  private broadcast(message: ServerMessage): void {
    for (const client of this.openClients()) {
      this.send(client, message);
    }
  }

  private send(client: WebSocket, message: ServerMessage): boolean {
    if (client.readyState !== WebSocket.OPEN) {
      this.evictClient(client);
      return false;
    }

    if (serverMessageMayExceedGatewayLimit(message)) {
      logOversizedServerMessage(message, MAX_SERVER_MESSAGE_BYTES + 1, true);
      return this.handleUnsendableMessage(
        client,
        message,
        "Codex response exceeded the 1 MiB gateway message limit",
      );
    }

    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(message);
    } catch {
      return this.handleUnsendableMessage(
        client,
        message,
        "Codex response could not be serialized",
        1011,
        "Server message serialization failed",
      );
    }
    if (serialized === undefined) {
      return this.handleUnsendableMessage(
        client,
        message,
        "Codex response could not be serialized",
        1011,
        "Server message serialization failed",
      );
    }

    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > MAX_SERVER_MESSAGE_BYTES) {
      logOversizedServerMessage(message, byteLength);
      return this.handleUnsendableMessage(
        client,
        message,
        "Codex response exceeded the 1 MiB gateway message limit",
      );
    }
    return this.sendSerialized(client, serialized, byteLength);
  }

  private isOutboundMessageWithinLimit(message: ServerMessage): boolean {
    if (serverMessageMayExceedGatewayLimit(message)) return false;
    try {
      const serialized = JSON.stringify(message);
      return serialized !== undefined &&
        Buffer.byteLength(serialized, "utf8") <= MAX_SERVER_MESSAGE_BYTES;
    } catch {
      return false;
    }
  }

  private handleUnsendableMessage(
    client: WebSocket,
    message: ServerMessage,
    reason: string,
    closeCode = 1009,
    closeReason = "Server message too large",
  ): boolean {
    if (message.type === "notification") {
      const recoverable = recoverableOversizedNotification(message);
      if (recoverable) {
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(recoverable);
        } catch {
          serialized = undefined;
        }
        if (serialized !== undefined) {
          const byteLength = Buffer.byteLength(serialized, "utf8");
          if (byteLength <= MAX_SERVER_MESSAGE_BYTES) {
            return this.sendSerialized(client, serialized, byteLength);
          }
        }
      }
      const fallback = JSON.stringify(resyncRequiredNotification(message));
      return this.sendSerialized(
        client,
        fallback,
        Buffer.byteLength(fallback, "utf8"),
      );
    }
    if (message.type !== "rpcResult" && message.type !== "rpcError") {
      this.closeAndEvictClient(client, closeCode, closeReason);
      return false;
    }

    const fallback = JSON.stringify({
      type: "rpcError",
      id: message.id,
      error: { code: -32_000, message: reason },
    });
    const byteLength = Buffer.byteLength(fallback, "utf8");
    if (byteLength > MAX_SERVER_MESSAGE_BYTES) {
      this.closeAndEvictClient(client, 1009, "Server message too large");
      return false;
    }
    return this.sendSerialized(client, fallback, byteLength);
  }

  private sendSerialized(client: WebSocket, serialized: string, byteLength: number): boolean {
    if (client.readyState !== WebSocket.OPEN) {
      this.evictClient(client);
      return false;
    }
    if (client.bufferedAmount > MAX_WS_BUFFERED_BYTES - byteLength) {
      this.closeAndEvictClient(client, 1013, "Client too slow");
      return false;
    }
    try {
      client.send(serialized, (error) => {
        if (error) {
          this.closeAndEvictClient(client, 1011, "Server send failed");
        }
      });
    } catch {
      this.closeAndEvictClient(client, 1011, "Server send failed");
      return false;
    }
    return this.clients.has(client) && client.readyState === WebSocket.OPEN;
  }

  private closeAndEvictClient(client: WebSocket, code: number, reason: string): void {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.close(code, reason);
      } catch {
        client.terminate();
      }
    }
    this.evictClient(client);
  }

  private rejectUpgrade(
    socket: { end(data?: string): void },
    statusCode: number,
    reason: string,
  ): void {
    socket.end(
      `HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }

  private address(): StartedServer {
    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Ask Codex server is not listening on a TCP address");
    }
    const port = (address as AddressInfo).port;
    const displayHost = this.config.host.includes(":")
      ? `[${this.config.host}]`
      : this.config.host;
    return {
      host: this.config.host,
      port,
      url: `http://${displayHost}:${port}`,
    };
  }
}
