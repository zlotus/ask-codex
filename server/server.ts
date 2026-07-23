import express from "express";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import type { RawData } from "ws";

import {
  CodexAppServer,
  CodexRpcError,
  type CodexGateway,
  type CodexStatusEvent,
} from "./codex-app-server.js";
import {
  assertSafeBind,
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
  sanitizeBrowserRpcParams,
} from "./rpc-policy.js";
import { normalizeServerRequestResponse } from "./server-request-policy.js";
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
const MAX_BROWSER_MESSAGE_BYTES = 1024 * 1024;
const MAX_SERVER_MESSAGE_BYTES = 1024 * 1024;
const MAX_WS_BUFFERED_BYTES = 2 * 1024 * 1024;
const WS_AUTH_TIMEOUT_MS = 5_000;
const MAX_RESYNC_METHOD_CHARACTERS = 128;
const MAX_RESYNC_ID_CHARACTERS = 256;
export { ALLOWED_BROWSER_RPC_METHODS } from "./rpc-policy.js";

export interface AskCodexConfig {
  host: string;
  port: number;
  defaultCwd: string;
  token?: string;
  publicOrigin?: string;
  production: boolean;
  distDir: string;
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

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 4173 : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("ASK_CODEX_PORT must be an integer between 0 and 65535");
  }
  return port;
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
  };
}

function rpcIdKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function errorPayload(error: unknown): unknown {
  if (error instanceof CodexRpcError) {
    return error.rpcError;
  }
  if (error instanceof ClientRpcError) {
    return { code: error.code, message: error.message };
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
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly inFlightRpc = new Map<WebSocket, number>();
  private totalInFlightRpc = 0;
  private started = false;

  constructor(
    readonly config: AskCodexConfig,
    readonly codex: CodexGateway = new CodexAppServer({
      command: process.env.CODEX_BIN || "codex",
    }),
  ) {
    assertSafeBind(config.host, config.token, config.publicOrigin);
    assertDirectory(config.defaultCwd, "defaultCwd");
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
    this.codex.close();
    this.pendingServerRequests.clear();
    for (const client of this.clients) {
      client.terminate();
    }
    for (const client of this.authenticatingClients) {
      client.terminate();
    }
    this.clients.clear();
    this.authenticatingClients.clear();

    await new Promise<void>((resolveClose) => {
      this.webSocketServer.close(() => resolveClose());
    });
    if (this.httpServer.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        this.httpServer.close((error) => {
          if (error) {
            rejectClose(error);
          } else {
            resolveClose();
          }
        });
      });
    }
    this.started = false;
  }

  private configureHttp(): void {
    this.app.disable("x-powered-by");
    this.app.use((request, response, next) => {
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; base-uri 'self'; connect-src 'self' ws: wss:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
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
        response.status(403).json({ error: "Origin not allowed" });
        return;
      }
      next();
    });
    this.app.use("/api", (request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      if (!isHttpAuthorized(request, this.config.token)) {
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
      let requestUrl: URL;
      try {
        requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "invalid"}`);
      } catch {
        this.rejectUpgrade(socket, 400, "Bad Request");
        return;
      }
      if (requestUrl.pathname !== "/ws") {
        this.rejectUpgrade(socket, 404, "Not Found");
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
    this.codex.on("notification", (method, params) => {
      if (method === "serverRequest/resolved" && isRecord(params) && isRpcId(params.requestId)) {
        this.pendingServerRequests.delete(rpcIdKey(params.requestId));
      }
      this.broadcast({ type: "notification", method, params });
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
    try {
      if (!ALLOWED_BROWSER_RPC_METHODS.has(message.method)) {
        throw new MethodNotAllowedError(message.method);
      }
      const sanitizedParams = sanitizeBrowserRpcParams(message.method, message.params);
      await validateRpcCwd(message.method, sanitizedParams);

      const existingThreadId = threadIdFromParams(sanitizedParams);
      if (
        existingThreadId &&
        (message.method === "thread/resume" || message.method === "turn/start")
      ) {
        this.ownership.set(existingThreadId, client);
      }

      const result = await this.codex.request(message.method, sanitizedParams);
      if (message.method === "thread/start") {
        const newThreadId = threadIdFromStartResult(result);
        if (newThreadId) {
          this.ownership.set(newThreadId, client);
        }
      }
      this.send(client, { type: "rpcResult", id: message.id, result });
    } catch (error) {
      this.send(client, { type: "rpcError", id: message.id, error: errorPayload(error) });
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
      this.pendingServerRequests.clear();
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
      return this.handleUnsendableMessage(
        client,
        message,
        "Codex response exceeded the 1 MiB gateway message limit",
      );
    }
    return this.sendSerialized(client, serialized, byteLength);
  }

  private isOutboundMessageWithinLimit(message: ServerMessage): boolean {
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
