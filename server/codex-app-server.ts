import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { CodexStatus, RpcId } from "./types.js";
import { isRecord, isRpcId } from "./types.js";

export interface CodexStatusEvent {
  status: CodexStatus;
  version?: string;
  error?: { message: string };
}

interface CodexEventMap {
  status: [status: CodexStatusEvent];
  notification: [method: string, params: unknown, emittedAtMs?: number];
  request: [id: RpcId, method: string, params: unknown];
}

export interface CodexStdoutLineDiagnostic {
  byteLength: number;
  direction: "response" | "notification" | "request" | "unknown";
  method?: string;
  id?: RpcId;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  itemType?: string;
  largestString?: {
    path: string;
    characters: number;
    utf8Bytes: number;
    category: "commandOutput" | "text" | "binary" | "other";
  };
  topLevelStringBytes: Array<{ field: string; utf8Bytes: number }>;
  hasImageData: boolean;
  hasBase64Data: boolean;
  scannedNodes: number;
  scanTruncated: boolean;
  parseError?: boolean;
}

export interface CodexProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnCodex = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => CodexProcess;

export interface CodexGateway {
  readonly status: CodexStatus;
  readonly version: string | undefined;
  readonly error: { message: string } | undefined;
  start(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
  requestWithResultObserver(
    method: string,
    params: unknown,
    onResult: (result: unknown) => void,
  ): Promise<unknown>;
  respond(id: RpcId, result: unknown, error?: unknown): Promise<void>;
  close(): void;
  on(
    event: "status",
    listener: (status: CodexStatusEvent) => void,
  ): this;
  on(
    event: "notification",
    listener: (method: string, params: unknown, emittedAtMs?: number) => void,
  ): this;
  on(
    event: "request",
    listener: (id: RpcId, method: string, params: unknown) => void,
  ): this;
}

interface PendingRequest {
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
  onResult?: (result: unknown) => void;
}

const INITIAL_STDOUT_LINE_BUFFER_BYTES = 64 * 1024;
const DEFAULT_STDOUT_DIAGNOSTIC_THRESHOLD_BYTES = 1024 * 1024;
const MAX_STDOUT_DIAGNOSTIC_NODES = 20_000;
const MAX_STDOUT_DIAGNOSTIC_DEPTH = 48;
const MAX_STDOUT_DIAGNOSTIC_PATH_CHARACTERS = 512;
const MAX_STDOUT_DIAGNOSTIC_TOP_LEVEL_FIELDS = 16;

type StdoutLineDiagnosticHandler = (diagnostic: CodexStdoutLineDiagnostic) => void;

interface DiagnosticFrame {
  value: unknown;
  path: string;
  root: string;
  depth: number;
  key?: string;
}

const diagnosticIdentifierKeys = new Set([
  "threadId",
  "turnId",
  "itemId",
]);

function boundedDiagnosticString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return undefined;
  if ([...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  })) return undefined;
  return value;
}

function diagnosticPath(path: string): string {
  return path.length <= MAX_STDOUT_DIAGNOSTIC_PATH_CHARACTERS
    ? path
    : `${path.slice(0, MAX_STDOUT_DIAGNOSTIC_PATH_CHARACTERS - 3)}...`;
}

function diagnosticField(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$-]{0,127}$/.test(value) ? value : "[other]";
}

function diagnosticCategory(path: string, key: string | undefined): "commandOutput" | "text" | "binary" | "other" {
  const lower = `${path}.${key ?? ""}`.toLowerCase();
  if (/(aggregatedoutput|command.?output|stdout|stderr|output)/.test(lower)) return "commandOutput";
  if (/(base64|dataurl|data_uri|image|audio|bytes)/.test(lower)) return "binary";
  if (/(text|message|delta|summary|content|prompt|instruction|diff)/.test(lower)) return "text";
  return "other";
}

function isImageMarker(key: string | undefined, value: unknown): boolean {
  const lower = key?.toLowerCase() ?? "";
  return lower.includes("image") || (typeof value === "string" && /^data:image\//i.test(value.slice(0, 32)));
}

function isBase64Marker(key: string | undefined, value: unknown): boolean {
  const lower = key?.toLowerCase() ?? "";
  return lower.includes("base64") || lower.includes("dataurl") || lower.includes("data_uri") ||
    (typeof value === "string" && /^data:[^,]{1,128};base64,/i.test(value.slice(0, 160)));
}

function diagnosticContextFromParams(
  params: unknown,
): Pick<PendingRequest, "threadId" | "turnId" | "itemId"> {
  const record = isRecord(params) ? params : undefined;
  const threadId = boundedDiagnosticString(record?.threadId, 256);
  const turnId = boundedDiagnosticString(record?.turnId, 256);
  const itemId = boundedDiagnosticString(record?.itemId, 256);
  return {
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
    ...(itemId === undefined ? {} : { itemId }),
  };
}

function stdoutLineDiagnostic(
  byteLength: number,
  message: unknown,
  parseError = false,
  associatedMethod?: string,
  associatedContext?: Pick<PendingRequest, "threadId" | "turnId" | "itemId">,
): CodexStdoutLineDiagnostic {
  const record = isRecord(message) ? message : undefined;
  const hasMethod = typeof record?.method === "string";
  const direction: CodexStdoutLineDiagnostic["direction"] = hasMethod
    ? isRpcId(record?.id) ? "request" : "notification"
    : isRpcId(record?.id) ? "response" : "unknown";
  const method = boundedDiagnosticString(record?.method, 256) ??
    boundedDiagnosticString(associatedMethod, 256);
  const id = isRpcId(record?.id) ? record.id : undefined;
  const identifiers: Partial<Pick<CodexStdoutLineDiagnostic, "threadId" | "turnId" | "itemId" | "itemType">> = {};
  const topLevelStringBytes = new Map<string, number>();
  let largestString: CodexStdoutLineDiagnostic["largestString"];
  let hasImageData = false;
  let hasBase64Data = false;
  let scannedNodes = 0;
  let scanTruncated = false;
  const stack: DiagnosticFrame[] = [{ value: message, path: "$", root: "$", depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop() as DiagnosticFrame;
    scannedNodes += 1;
    if (scannedNodes > MAX_STDOUT_DIAGNOSTIC_NODES) {
      scanTruncated = true;
      break;
    }
    if (frame.depth > MAX_STDOUT_DIAGNOSTIC_DEPTH) {
      scanTruncated = true;
      continue;
    }

    if (typeof frame.value === "string") {
      const utf8Bytes = Buffer.byteLength(frame.value, "utf8");
      topLevelStringBytes.set(frame.root, (topLevelStringBytes.get(frame.root) ?? 0) + utf8Bytes);
      const candidate = {
        path: diagnosticPath(frame.path),
        characters: frame.value.length,
        utf8Bytes,
        category: diagnosticCategory(frame.path, frame.key),
      } as const;
      if (!largestString || candidate.utf8Bytes > largestString.utf8Bytes) {
        largestString = candidate;
      }
      if (isImageMarker(frame.key, frame.value)) hasImageData = true;
      if (isBase64Marker(frame.key, frame.value)) hasBase64Data = true;
      continue;
    }
    if (Array.isArray(frame.value)) {
      const available = Math.max(
        0,
        MAX_STDOUT_DIAGNOSTIC_NODES - scannedNodes - stack.length,
      );
      const entries = Math.min(frame.value.length, available);
      if (entries < frame.value.length) scanTruncated = true;
      for (let index = entries - 1; index >= 0; index -= 1) {
        stack.push({
          value: frame.value[index],
          path: diagnosticPath(`${frame.path}[${index}]`),
          root: frame.root,
          depth: frame.depth + 1,
          key: frame.key,
        });
      }
      continue;
    }
    if (!isRecord(frame.value)) continue;

    const entries = Object.entries(frame.value);
    const available = Math.max(
      0,
      MAX_STDOUT_DIAGNOSTIC_NODES - scannedNodes - stack.length,
    );
    if (entries.length > available) scanTruncated = true;
    for (const [key, value] of entries.slice(0, available)) {
      if (diagnosticIdentifierKeys.has(key) && identifiers[key as "threadId" | "turnId" | "itemId"] === undefined) {
        const identifier = boundedDiagnosticString(value, 256);
        if (identifier) identifiers[key as "threadId" | "turnId" | "itemId"] = identifier;
      }
      if (
        key === "type" &&
        identifiers.itemType === undefined &&
        /(?:^|\.)(?:item|items\[\d+\])$/.test(frame.path)
      ) {
        const itemType = boundedDiagnosticString(value, 128);
        if (itemType && itemType !== "object") identifiers.itemType = itemType;
      }
      if (
        key === "id" &&
        /(?:^|\.)thread$/.test(frame.path) &&
        identifiers.threadId === undefined
      ) {
        const threadIdentifier = boundedDiagnosticString(value, 256);
        if (threadIdentifier) identifiers.threadId = threadIdentifier;
      }
      if (
        key === "id" &&
        /(?:^|\.)(?:turn|turns\[\d+\])$/.test(frame.path) &&
        identifiers.turnId === undefined
      ) {
        const turnIdentifier = boundedDiagnosticString(value, 256);
        if (turnIdentifier) identifiers.turnId = turnIdentifier;
      }
      if (
        key === "id" &&
        identifiers.itemId === undefined &&
        /(?:^|\.)(?:item|items\[\d+\])$/.test(frame.path)
      ) {
        const itemIdentifier = boundedDiagnosticString(value, 256);
        if (itemIdentifier) identifiers.itemId = itemIdentifier;
      }
      if (isImageMarker(key, value) || (isRecord(value) && value.type === "image")) hasImageData = true;
      if (isBase64Marker(key, value)) hasBase64Data = true;
      const field = diagnosticField(key);
      stack.push({
        value,
        path: diagnosticPath(frame.path === "$" ? `$.${field}` : `${frame.path}.${field}`),
        root: frame.path === "$" ? field : frame.root,
        depth: frame.depth + 1,
        key,
      });
    }
  }

  return {
    byteLength,
    direction,
    ...(method === undefined ? {} : { method }),
    ...(id === undefined ? {} : { id }),
    ...(identifiers.threadId === undefined
      ? associatedContext?.threadId === undefined ? {} : { threadId: associatedContext.threadId }
      : { threadId: identifiers.threadId }),
    ...(identifiers.turnId === undefined
      ? associatedContext?.turnId === undefined ? {} : { turnId: associatedContext.turnId }
      : { turnId: identifiers.turnId }),
    ...(identifiers.itemId === undefined
      ? associatedContext?.itemId === undefined ? {} : { itemId: associatedContext.itemId }
      : { itemId: identifiers.itemId }),
    ...(identifiers.itemType === undefined ? {} : { itemType: identifiers.itemType }),
    ...(largestString === undefined ? {} : { largestString }),
    topLevelStringBytes: [...topLevelStringBytes.entries()]
      .map(([field, utf8Bytes]) => ({ field, utf8Bytes }))
      .sort((left, right) => right.utf8Bytes - left.utf8Bytes)
      .slice(0, MAX_STDOUT_DIAGNOSTIC_TOP_LEVEL_FIELDS),
    hasImageData,
    hasBase64Data,
    scannedNodes: Math.min(scannedNodes, MAX_STDOUT_DIAGNOSTIC_NODES),
    scanTruncated,
    ...(parseError ? { parseError: true } : {}),
  };
}

export class CodexRpcError extends Error {
  constructor(readonly rpcError: unknown) {
    super(errorMessage(rpcError));
    this.name = "CodexRpcError";
  }
}

function errorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") {
    return value.message;
  }
  return "Codex app-server returned an RPC error";
}

function notificationTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function cleanStatusError(value: unknown): { message: string } {
  const raw = value instanceof Error ? value.message : errorMessage(value);
  const message = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 500);
  return { message: message || "Codex app-server failed" };
}

const defaultSpawnCodex: SpawnCodex = (command, args, options) =>
  spawn(command, [...args], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

export interface CodexAppServerOptions {
  command?: string;
  spawnCodex?: SpawnCodex;
  clientVersion?: string;
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Optional diagnostic/test guard; production leaves stdout lines unbounded. */
  maxStdoutLineBytes?: number;
  /** Log only metadata for large JSONL lines; never includes their string contents. */
  stdoutDiagnosticThresholdBytes?: number;
  onStdoutLineDiagnostic?: StdoutLineDiagnosticHandler;
}

export class CodexAppServer extends EventEmitter<CodexEventMap> implements CodexGateway {
  private readonly command: string;
  private readonly spawnCodex: SpawnCodex;
  private readonly clientVersion: string;
  private readonly initializeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxStdoutLineBytes: number | undefined;
  private readonly stdoutDiagnosticThresholdBytes: number;
  private readonly onStdoutLineDiagnostic: StdoutLineDiagnosticHandler | undefined;
  private child: CodexProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private closed = false;
  private _status: CodexStatus = "starting";
  private _version: string | undefined;
  private _error: { message: string } | undefined;

  constructor(options: CodexAppServerOptions = {}) {
    super();
    this.command = options.command ?? "codex";
    this.spawnCodex = options.spawnCodex ?? defaultSpawnCodex;
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.initializeTimeoutMs = Math.max(1, options.initializeTimeoutMs ?? 30_000);
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 120_000);
    const maxStdoutLineBytes = options.maxStdoutLineBytes;
    if (
      maxStdoutLineBytes !== undefined &&
      (!Number.isSafeInteger(maxStdoutLineBytes) || maxStdoutLineBytes <= 0)
    ) {
      throw new Error("maxStdoutLineBytes must be a positive safe integer");
    }
    this.maxStdoutLineBytes = maxStdoutLineBytes;
    const stdoutDiagnosticThresholdBytes = options.stdoutDiagnosticThresholdBytes ??
      DEFAULT_STDOUT_DIAGNOSTIC_THRESHOLD_BYTES;
    if (
      !Number.isSafeInteger(stdoutDiagnosticThresholdBytes) ||
      stdoutDiagnosticThresholdBytes <= 0
    ) {
      throw new Error("stdoutDiagnosticThresholdBytes must be a positive safe integer");
    }
    this.stdoutDiagnosticThresholdBytes = stdoutDiagnosticThresholdBytes;
    this.onStdoutLineDiagnostic = options.onStdoutLineDiagnostic;
  }

  get status(): CodexStatus {
    return this._status;
  }

  get version(): string | undefined {
    return this._version;
  }

  get error(): { message: string } | undefined {
    return this._error;
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new Error("Codex app-server client is closed");
    }
    if (this.child && this._status === "ready") {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const attempt = this.launch();
    this.startPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.startPromise === attempt) {
        this.startPromise = undefined;
      }
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.start();
    if (!this.child || this._status !== "ready") {
      throw new Error("Codex app-server is not ready");
    }
    return this.sendRequest(this.child, method, params, this.requestTimeoutMs);
  }

  async requestWithResultObserver(
    method: string,
    params: unknown,
    onResult: (result: unknown) => void,
  ): Promise<unknown> {
    await this.start();
    if (!this.child || this._status !== "ready") {
      throw new Error("Codex app-server is not ready");
    }
    return this.sendRequest(
      this.child,
      method,
      params,
      this.requestTimeoutMs,
      onResult,
    );
  }

  async respond(id: RpcId, result: unknown, error?: unknown): Promise<void> {
    const child = this.child;
    if (!child || this._status !== "ready") {
      throw new Error("Codex app-server is not ready");
    }

    const message = error === undefined ? { id, result } : { id, error };
    await this.writeLine(child, message);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    this.rejectPending(new Error("Codex app-server client closed"));
    if (child) {
      child.kill("SIGTERM");
    }
  }

  private async launch(): Promise<void> {
    this._version = undefined;
    this.setStatus("starting");

    let child: CodexProcess;
    try {
      const childEnvironment = { ...process.env };
      delete childEnvironment.ASK_CODEX_TOKEN;
      child = this.spawnCodex(
        this.command,
        ["app-server", "--listen", "stdio://"],
        { env: childEnvironment },
      );
    } catch (error) {
      this.setStatus("error", error);
      throw error;
    }

    this.child = child;
    this.readStdout(child);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      // Drain stderr so a verbose child cannot block on a full pipe.
    });
    child.once("error", (error: Error) => this.handleTermination(child, error));
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = signal ? `signal ${signal}` : `code ${String(code)}`;
      this.handleTermination(child, new Error(`Codex app-server exited with ${detail}`));
    });

    try {
      const initialized = await this.sendRequest(child, "initialize", {
        clientInfo: {
          name: "ask_codex",
          title: "Ask Codex",
          version: this.clientVersion,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      }, this.initializeTimeoutMs);
      if (this.child !== child) {
        throw new Error("Codex app-server exited during initialization");
      }

      await this.writeLine(child, { method: "initialized" });
      if (isRecord(initialized) && typeof initialized.userAgent === "string") {
        this._version = initialized.userAgent;
      }
      this.setStatus("ready");
    } catch (error) {
      if (this.child === child) {
        this.child = undefined;
        child.kill("SIGTERM");
        this.rejectPending(error);
        this.setStatus("error", error);
      }
      throw error;
    }
  }

  private readStdout(child: CodexProcess): void {
    let lineBuffer = Buffer.allocUnsafe(INITIAL_STDOUT_LINE_BUFFER_BYTES);
    let lineBytes = 0;

    const failOversizedLine = (): void => {
      if (this.maxStdoutLineBytes === undefined) return;
      const error = new Error(
        `Codex app-server stdout JSONL line exceeded ${this.maxStdoutLineBytes} byte limit`,
      );
      this.handleTermination(child, error);
      child.kill("SIGTERM");
    };

    const append = (part: Buffer): boolean => {
      if (
        this.maxStdoutLineBytes !== undefined &&
        part.length > this.maxStdoutLineBytes - lineBytes
      ) {
        failOversizedLine();
        return false;
      }
      if (part.length === 0) {
        return true;
      }

      const requiredBytes = lineBytes + part.length;
      if (requiredBytes > lineBuffer.length) {
        const nextCapacity = Math.max(requiredBytes, lineBuffer.length * 2);
        const nextBuffer = Buffer.allocUnsafe(nextCapacity);
        lineBuffer.copy(nextBuffer, 0, 0, lineBytes);
        lineBuffer = nextBuffer;
      }
      part.copy(lineBuffer, lineBytes);
      lineBytes += part.length;
      return true;
    };

    const emitLine = (): void => {
      const line = lineBuffer.toString("utf8", 0, lineBytes);
      lineBytes = 0;
      if (lineBuffer.length > INITIAL_STDOUT_LINE_BUFFER_BYTES) {
        lineBuffer = Buffer.allocUnsafe(INITIAL_STDOUT_LINE_BUFFER_BYTES);
      }
      this.handleLine(child, line);
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (this.child !== child) {
        return;
      }

      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      let offset = 0;
      while (offset < data.length) {
        const newline = data.indexOf(0x0a, offset);
        const end = newline === -1 ? data.length : newline;
        if (!append(data.subarray(offset, end))) {
          return;
        }
        if (newline === -1) {
          return;
        }

        emitLine();
        if (this.child !== child) {
          return;
        }
        offset = newline + 1;
      }
    });
    child.stdout.once("end", () => {
      if (this.child === child && lineBytes > 0) {
        emitLine();
      }
    });
  }

  private sendRequest(
    child: CodexProcess,
    method: string,
    params: unknown,
    timeoutMs: number,
    onResult?: (result: unknown) => void,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Codex RPC ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        method,
        ...diagnosticContextFromParams(params),
        resolve,
        reject,
        timer,
        onResult,
      });
      void this.writeLine(child, { method, id, params }).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          reject(error);
        }
      });
    });
  }

  private writeLine(child: CodexProcess, message: unknown): Promise<void> {
    if (this.child !== child) {
      return Promise.reject(new Error("Codex app-server process is no longer active"));
    }

    return new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private handleLine(child: CodexProcess, line: string): void {
    if (this.child !== child || line.trim().length === 0) {
      return;
    }

    const byteLength = Buffer.byteLength(line, "utf8");
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      this.emitStdoutLineDiagnostic(byteLength, undefined, true);
      this.handleTermination(child, new Error("Codex app-server emitted invalid JSONL"));
      child.kill("SIGTERM");
      return;
    }
    const pending = isRecord(message) &&
        isRpcId(message.id) &&
        typeof message.method !== "string"
      ? this.pending.get(message.id)
      : undefined;
    this.emitStdoutLineDiagnostic(
      byteLength,
      message,
      false,
      pending?.method,
      pending,
    );
    if (!isRecord(message)) {
      return;
    }

    if (isRpcId(message.id) && typeof message.method === "string") {
      this.emit("request", message.id, message.method, message.params);
      return;
    }
    if (typeof message.method === "string") {
      const emittedAtMs = notificationTimestamp(message.emittedAtMs);
      if (emittedAtMs === undefined) {
        this.emit("notification", message.method, message.params);
      } else {
        this.emit("notification", message.method, message.params, emittedAtMs);
      }
      return;
    }
    if (!isRpcId(message.id)) {
      return;
    }

    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      pending.reject(new CodexRpcError(message.error));
    } else {
      try {
        pending.onResult?.(message.result);
        pending.resolve(message.result);
      } catch (error) {
        pending.reject(error);
      }
    }
  }

  private emitStdoutLineDiagnostic(
    byteLength: number,
    message: unknown,
    parseError = false,
    associatedMethod?: string,
    associatedContext?: Pick<PendingRequest, "threadId" | "turnId" | "itemId">,
  ): void {
    if (
      this.onStdoutLineDiagnostic === undefined ||
      byteLength < this.stdoutDiagnosticThresholdBytes
    ) {
      return;
    }
    try {
      this.onStdoutLineDiagnostic(stdoutLineDiagnostic(
        byteLength,
        message,
        parseError,
        associatedMethod,
        associatedContext,
      ));
    } catch {
      // Diagnostics must never affect protocol handling.
    }
  }

  private handleTermination(child: CodexProcess, error: Error): void {
    if (this.child !== child) {
      return;
    }
    this.child = undefined;
    this.rejectPending(error);
    if (!this.closed) {
      this.setStatus("error", error);
    }
  }

  private rejectPending(error: unknown): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private setStatus(status: CodexStatus, error?: unknown): void {
    if (this._status === status && status !== "starting") {
      return;
    }
    this._status = status;
    this._error = status === "error" ? cleanStatusError(error) : undefined;
    const event: CodexStatusEvent = { status, version: this._version };
    if (this._error) {
      event.error = this._error;
    }
    this.emit("status", event);
  }
}
