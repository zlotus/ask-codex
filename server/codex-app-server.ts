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
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
  onResult?: (result: unknown) => void;
}

const DEFAULT_MAX_STDOUT_LINE_BYTES = 8 * 1024 * 1024;
const INITIAL_STDOUT_LINE_BUFFER_BYTES = 64 * 1024;

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
  maxStdoutLineBytes?: number;
}

export class CodexAppServer extends EventEmitter<CodexEventMap> implements CodexGateway {
  private readonly command: string;
  private readonly spawnCodex: SpawnCodex;
  private readonly clientVersion: string;
  private readonly initializeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxStdoutLineBytes: number;
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
    const maxStdoutLineBytes = options.maxStdoutLineBytes ?? DEFAULT_MAX_STDOUT_LINE_BYTES;
    if (!Number.isSafeInteger(maxStdoutLineBytes) || maxStdoutLineBytes <= 0) {
      throw new Error("maxStdoutLineBytes must be a positive safe integer");
    }
    this.maxStdoutLineBytes = maxStdoutLineBytes;
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
    let lineBuffer = Buffer.allocUnsafe(
      Math.min(this.maxStdoutLineBytes, INITIAL_STDOUT_LINE_BUFFER_BYTES),
    );
    let lineBytes = 0;

    const failOversizedLine = (): void => {
      const error = new Error(
        `Codex app-server stdout JSONL line exceeded ${this.maxStdoutLineBytes} byte limit`,
      );
      this.handleTermination(child, error);
      child.kill("SIGTERM");
    };

    const append = (part: Buffer): boolean => {
      if (part.length > this.maxStdoutLineBytes - lineBytes) {
        failOversizedLine();
        return false;
      }
      if (part.length === 0) {
        return true;
      }

      const requiredBytes = lineBytes + part.length;
      if (requiredBytes > lineBuffer.length) {
        const nextCapacity = Math.min(
          this.maxStdoutLineBytes,
          Math.max(requiredBytes, lineBuffer.length * 2),
        );
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
      this.pending.set(id, { resolve, reject, timer, onResult });
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

    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      this.handleTermination(child, new Error("Codex app-server emitted invalid JSONL"));
      child.kill("SIGTERM");
      return;
    }
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

    const pending = this.pending.get(message.id);
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
