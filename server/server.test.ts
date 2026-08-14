// @vitest-environment node

import { EventEmitter, once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { PassThrough, Readable } from "node:stream";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexRpcError,
  type CodexGateway,
  type CodexStatusEvent,
} from "./codex-app-server.js";
import { FileDownloadStore } from "./file-downloads.js";
import { AskCodexServer, loadConfig, type AskCodexConfig } from "./server.js";
import type { CodexStatus, RpcId, ServerMessage } from "./types.js";

interface FakeGatewayEvents {
  status: [status: CodexStatusEvent];
  notification: [method: string, params: unknown, emittedAtMs?: number];
  request: [id: RpcId, method: string, params: unknown];
}

interface WorkspaceSandboxFixture {
  type: "workspaceWrite";
  writableRoots: string[];
  networkAccess: boolean;
  excludeTmpdirEnvVar: boolean;
  excludeSlashTmp: boolean;
}

function workspaceSandbox(writableRoots: string[] = []): WorkspaceSandboxFixture {
  return {
    type: "workspaceWrite",
    writableRoots,
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function primeWorkspaceSandboxAuthority(
  service: AskCodexServer,
  threadId: string,
  writableRoots: string[] = [],
): void {
  const sandbox = workspaceSandbox(writableRoots);
  const authorities = (service as unknown as {
    threadSandboxAuthorities: Map<string, { current: WorkspaceSandboxFixture; workspaceWrite: WorkspaceSandboxFixture }>;
  }).threadSandboxAuthorities;
  authorities.set(threadId, { current: sandbox, workspaceWrite: sandbox });
}

class FakeGateway extends EventEmitter<FakeGatewayEvents> implements CodexGateway {
  status: CodexStatus = "ready";
  version: string | undefined = "codex-cli/test";
  error: { message: string } | undefined;
  readonly request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    void params;
    if (method === "thread/start") {
      return { thread: { id: "thread-owned" }, sandbox: workspaceSandbox() };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-with-attachments", status: "inProgress", items: [] } };
    }
    if (method === "turn/steer") {
      const expectedTurnId = typeof params === "object" && params !== null &&
          "expectedTurnId" in params && typeof params.expectedTurnId === "string"
        ? params.expectedTurnId
        : "turn-steered";
      return { turnId: expectedTurnId };
    }
    if (method === "thread/resume") {
      const threadId = typeof params === "object" && params !== null &&
          "threadId" in params && typeof params.threadId === "string"
        ? params.threadId
        : "thread-resumed";
      return { thread: { id: threadId }, sandbox: workspaceSandbox() };
    }
    return { ok: true };
  });
  readonly requestWithResultObserver = vi.fn(async (
    method: string,
    params: unknown,
    onResult: (result: unknown) => void,
  ): Promise<unknown> => {
    const result = await this.request(method, params);
    onResult(result);
    return result;
  });
  readonly respond = vi.fn(async (): Promise<void> => undefined);
  readonly start = vi.fn(async (): Promise<void> => undefined);
  readonly close = vi.fn((): void => undefined);
}

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

async function uploadAttachment(
  url: string,
  token: string,
  body: Uint8Array = PNG,
  contentType = "image/png",
): Promise<Response> {
  return fetch(`${url}/api/attachments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      Origin: "http://localhost:5173",
    },
    body,
  });
}

async function uploadFileAttachment(
  url: string,
  token: string,
  name: string,
  body: Uint8Array,
  contentType = "application/octet-stream",
): Promise<Response> {
  return fetch(`${url}/api/file-attachments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType,
      Origin: "http://localhost:5173",
      "X-Ask-Codex-File-Name": encodeURIComponent(name),
    },
    body,
  });
}

function config(token?: string): AskCodexConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    defaultCwd: process.cwd(),
    token,
    production: false,
    distDir: `${process.cwd()}/dist`,
  };
}

function connect(url: string, token: string): {
  socket: WebSocket;
  messages: ServerMessage[];
} {
  const messages: ServerMessage[] = [];
  const socket = new WebSocket(`${url.replace("http", "ws")}/ws`, {
    origin: "http://localhost:5173",
  });
  socket.on("open", () => {
    socket.send(JSON.stringify({ type: "auth", token }));
  });
  socket.on("message", (data) => {
    messages.push(JSON.parse(data.toString()) as ServerMessage);
  });
  return { socket, messages };
}

async function waitForMessage(
  messages: ServerMessage[],
  predicate: (message: ServerMessage) => boolean,
): Promise<ServerMessage> {
  await vi.waitFor(() => {
    expect(messages.some(predicate)).toBe(true);
  });
  const found = messages.find(predicate);
  if (!found) {
    throw new Error("Expected WebSocket message was not received");
  }
  return found;
}

async function requestStatus(
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  return await new Promise<number>((resolveRequest, rejectRequest) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolveRequest(response.statusCode ?? 0));
      response.once("error", rejectRequest);
    });
    request.once("error", rejectRequest);
    request.end();
  });
}

async function requestUpgradeStatus(url: string, path: string): Promise<number> {
  const endpoint = new URL(url);
  return await new Promise<number>((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path,
      headers: {
        Connection: "Upgrade",
        Origin: "http://localhost:5173",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
        Upgrade: "websocket",
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolveRequest(response.statusCode ?? 0));
      response.once("error", rejectRequest);
    });
    request.once("upgrade", (_response, socket) => {
      socket.end();
      rejectRequest(new Error(`Unexpected WebSocket upgrade for ${path}`));
    });
    request.once("error", rejectRequest);
    request.end();
  });
}

describe("AskCodexServer", () => {
  const services: AskCodexServer[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  it("persists queue operations across clients and sends exactly one normal text turn", async () => {
    const gateway = new FakeGateway();
    gateway.request.mockImplementation(async (method, params) => {
      const threadId = typeof params === "object" && params !== null &&
          "threadId" in params && typeof params.threadId === "string"
        ? params.threadId
        : "thread-queue";
      if (method === "thread/read") {
        return {
          thread: {
            id: threadId,
            status: { type: "idle" },
            turns: "includeTurns" in (params as object) &&
                (params as { includeTurns?: boolean }).includeTurns
              ? [{ id: "turn-before-queue", status: "completed", items: [] }]
              : [],
          },
        };
      }
      if (method === "thread/resume") {
        return { thread: { id: threadId }, sandbox: workspaceSandbox() };
      }
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn-from-queue",
            status: "inProgress",
            items: [{
              id: "command-from-queue",
              type: "commandExecution",
              status: "completed",
              command: "rg --json pattern",
              aggregatedOutput: "x".repeat(1_048_576),
              exitCode: 0,
            }],
          },
        };
      }
      return { ok: true };
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const first = connect(url, "test-token");
    const second = connect(url, "test-token");
    await Promise.all([once(first.socket, "open"), once(second.socket, "open")]);
    await Promise.all([
      waitForMessage(first.messages, (message) => message.type === "status"),
      waitForMessage(second.messages, (message) => message.type === "status"),
    ]);

    first.socket.send(JSON.stringify({
      type: "rpc",
      id: "queue-enqueue",
      method: "messageQueue/enqueue",
      params: {
        threadId: "thread-queue",
        text: "Continue from the persistent queue",
        expectedLastTurnId: "turn-before-queue",
      },
    }));
    const enqueuedResponse = await waitForMessage(
      first.messages,
      (message) => message.type === "rpcResult" && message.id === "queue-enqueue",
    );
    const queued = (enqueuedResponse as { result: { item: { id: string; revision: number } } }).result.item;
    await waitForMessage(
      second.messages,
      (message) => message.type === "notification" &&
        message.method === "messageQueue/changed",
    );

    second.socket.send(JSON.stringify({
      type: "rpc",
      id: "queue-list",
      method: "messageQueue/list",
      params: { threadId: "thread-queue" },
    }));
    await expect(waitForMessage(
      second.messages,
      (message) => message.type === "rpcResult" && message.id === "queue-list",
    )).resolves.toEqual(expect.objectContaining({
      result: expect.objectContaining({
        items: [expect.objectContaining({ id: queued.id, status: "queued" })],
      }),
    }));

    second.socket.send(JSON.stringify({
      type: "rpc",
      id: "queue-send",
      method: "messageQueue/send",
      params: { id: queued.id, revision: queued.revision },
    }));
    const sent = await waitForMessage(
      second.messages,
      (message) => message.type === "rpcResult" && message.id === "queue-send",
    );
    expect(sent).toEqual(expect.objectContaining({
      result: {
        item: expect.objectContaining({ status: "confirmed", confirmedTurnId: "turn-from-queue" }),
        turn: expect.objectContaining({
          id: "turn-from-queue",
          itemsView: "summary",
          items: [expect.objectContaining({
            id: "command-from-queue",
            streamOmittedCharacters: { aggregatedOutput: 1_048_576 },
          })],
        }),
      },
    }));
    expect(JSON.stringify(sent)).not.toContain("x".repeat(1_000));

    gateway.emit(
      "request",
      701,
      "item/commandExecution/requestApproval",
      { threadId: "thread-queue", command: "true" },
    );
    await waitForMessage(
      second.messages,
      (message) => message.type === "request" && message.id === 701,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(first.messages.some((message) => message.type === "request" && message.id === 701))
      .toBe(false);

    first.socket.send(JSON.stringify({
      type: "rpc",
      id: "queue-stale-send",
      method: "messageQueue/send",
      params: { id: queued.id, revision: queued.revision },
    }));
    await expect(waitForMessage(
      first.messages,
      (message) => message.type === "rpcError" && message.id === "queue-stale-send",
    )).resolves.toEqual(expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining("refresh before retrying") }),
    }));

    expect(gateway.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    expect(gateway.request.mock.calls.find(([method]) => method === "turn/start")?.[1]).toEqual({
      threadId: "thread-queue",
      input: [{
        type: "text",
        text: "Continue from the persistent queue",
        text_elements: [],
      }],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    expect(gateway.request.mock.calls.find(([method]) => method === "thread/resume")?.[1]).toEqual({
      threadId: "thread-queue",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      excludeTurns: true,
    });
    expect(gateway.request.mock.calls.some(([method]) => method.startsWith("messageQueue/")))
      .toBe(false);
  });

  it("requires a second explicit send after queued thread context changes", async () => {
    const gateway = new FakeGateway();
    gateway.request.mockImplementation(async (method, params) => {
      const threadId = (params as { threadId: string }).threadId;
      if (method === "thread/read") {
        return {
          thread: {
            id: threadId,
            status: { type: "idle" },
            turns: (params as { includeTurns?: boolean }).includeTurns
              ? [{ id: "turn-new-context", status: "completed", items: [] }]
              : [],
          },
        };
      }
      if (method === "thread/resume") {
        return { thread: { id: threadId }, sandbox: { type: "externalSandbox", networkAccess: "restricted" } };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-after-review", status: "inProgress", items: [] } };
      }
      return { ok: true };
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "context-enqueue",
      method: "messageQueue/enqueue",
      params: { threadId: "thread-context", text: "Review context", expectedLastTurnId: "turn-old" },
    }));
    const enqueue = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "context-enqueue",
    ) as { result: { item: { id: string; revision: number } } };
    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "context-first-send",
      method: "messageQueue/send",
      params: { id: enqueue.result.item.id, revision: enqueue.result.item.revision },
    }));
    await waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "context-first-send",
    );
    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "context-list",
      method: "messageQueue/list",
      params: { threadId: "thread-context" },
    }));
    const list = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "context-list",
    ) as { result: { items: Array<{ id: string; revision: number; status: string; reviewReason: string }> } };
    expect(list.result.items[0]).toMatchObject({
      status: "needsReview",
      reviewReason: "contextChanged",
    });
    const reviewed = list.result.items[0]!;

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "context-confirmed-send",
      method: "messageQueue/send",
      params: { id: reviewed.id, revision: reviewed.revision, confirmReview: true },
    }));
    await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "context-confirmed-send",
    );
    expect(gateway.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    expect(gateway.request.mock.calls.find(([method]) => method === "thread/resume")?.[1])
      .not.toHaveProperty("sandbox");
  });

  it("keeps a queued message reviewable when the target thread is busy", async () => {
    const gateway = new FakeGateway();
    gateway.request.mockImplementation(async (method, params) => {
      const threadId = (params as { threadId: string }).threadId;
      if (method === "thread/read") {
        return {
          thread: {
            id: threadId,
            status: { type: "active", activeFlags: ["waitingOnApproval"] },
            turns: (params as { includeTurns?: boolean }).includeTurns
              ? [{ id: "turn-active", status: "inProgress", items: [] }]
              : [],
          },
        };
      }
      return { ok: true };
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "busy-enqueue",
      method: "messageQueue/enqueue",
      params: { threadId: "thread-busy", text: "Send when idle", expectedLastTurnId: "turn-active" },
    }));
    const enqueue = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "busy-enqueue",
    ) as { result: { item: { id: string; revision: number } } };
    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "busy-send",
      method: "messageQueue/send",
      params: { id: enqueue.result.item.id, revision: enqueue.result.item.revision },
    }));
    await expect(waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "busy-send",
    )).resolves.toEqual(expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining("thread is busy") }),
    }));

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "busy-list",
      method: "messageQueue/list",
      params: { threadId: "thread-busy" },
    }));
    await expect(waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "busy-list",
    )).resolves.toEqual(expect.objectContaining({
      result: expect.objectContaining({
        items: [expect.objectContaining({ status: "needsReview", reviewReason: "threadBusy" })],
      }),
    }));
    expect(gateway.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
    expect(gateway.requestWithResultObserver).not.toHaveBeenCalled();
  });

  it("quarantines an unknown queued turn result and never allows it to be resent", async () => {
    const gateway = new FakeGateway();
    gateway.request.mockImplementation(async (method, params) => {
      const threadId = (params as { threadId: string }).threadId;
      if (method === "thread/read") {
        return {
          thread: {
            id: threadId,
            status: { type: "idle" },
            turns: (params as { includeTurns?: boolean }).includeTurns
              ? [{ id: "turn-before-unknown", status: "completed", items: [] }]
              : [],
          },
        };
      }
      if (method === "thread/resume") {
        return { thread: { id: threadId }, sandbox: workspaceSandbox() };
      }
      return { ok: true };
    });
    gateway.requestWithResultObserver.mockImplementation(async (method, params, observer) => {
      if (method === "turn/start") throw new Error("connection closed before response");
      const result = await gateway.request(method, params);
      observer(result);
      return result;
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "unknown-enqueue",
      method: "messageQueue/enqueue",
      params: {
        threadId: "thread-unknown",
        text: "Do not replay me",
        expectedLastTurnId: "turn-before-unknown",
      },
    }));
    const enqueue = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "unknown-enqueue",
    ) as { result: { item: { id: string; revision: number } } };
    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "unknown-send",
      method: "messageQueue/send",
      params: { id: enqueue.result.item.id, revision: enqueue.result.item.revision },
    }));
    await expect(waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "unknown-send",
    )).resolves.toEqual(expect.objectContaining({
      error: expect.objectContaining({ message: expect.stringContaining("indeterminate") }),
    }));

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "unknown-list",
      method: "messageQueue/list",
      params: { threadId: "thread-unknown" },
    }));
    const list = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "unknown-list",
    ) as { result: { items: Array<{ id: string; revision: number; status: string }> } };
    expect(list.result.items[0]?.status).toBe("indeterminate");
    const unknown = list.result.items[0]!;

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "unknown-retry",
      method: "messageQueue/send",
      params: { id: unknown.id, revision: unknown.revision, confirmReview: true },
    }));
    await waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "unknown-retry",
    );
    expect(gateway.requestWithResultObserver.mock.calls.filter(([method]) => method === "turn/start"))
      .toHaveLength(1);
  });

  it("protects HTTP metadata with token and Origin checks", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();

    const unauthorized = await fetch(`${url}/api/bootstrap`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(unauthorized.headers.get("content-security-policy"))
      .toContain("img-src 'self' blob: data:");
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");
    expect(unauthorized.headers.get("referrer-policy")).toBe("no-referrer");
    expect(unauthorized.headers.get("x-content-type-options")).toBe("nosniff");
    expect(unauthorized.headers.get("x-frame-options")).toBe("DENY");

    const queryToken = await fetch(`${url}/api/bootstrap?token=test-token`, {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(queryToken.status).toBe(401);

    const bootstrap = await fetch(`${url}/api/bootstrap`, {
      headers: {
        Authorization: "Bearer test-token",
        Origin: "http://localhost:5173",
      },
    });
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toEqual({
      ready: true,
      defaultCwd: process.cwd(),
      authRequired: true,
      codexVersion: "codex-cli/test",
    });

    const bearer = await fetch(`${url}/api/health`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(bearer.status).toBe(200);
    expect(await bearer.json()).toEqual({ ok: true, ready: true });

    const badOrigin = await fetch(`${url}/api/health`, {
      headers: {
        Authorization: "Bearer test-token",
        Origin: "https://evil.example",
      },
    });
    expect(badOrigin.status).toBe(403);
  });

  it("protects attachment uploads and rejects spoofed or oversized images", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();

    const unauthorized = await fetch(`${url}/api/attachments`, {
      method: "POST",
      headers: { "Content-Type": "image/png", Origin: "http://localhost:5173" },
      body: PNG,
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("connection")).toBe("close");

    const badOrigin = await fetch(`${url}/api/attachments`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "image/png",
        Origin: "https://evil.example",
      },
      body: PNG,
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers.get("connection")).toBe("close");

    const spoofed = await uploadAttachment(url, "test-token", Buffer.from("not a png"));
    expect(spoofed.status).toBe(415);
    await expect(spoofed.json()).resolves.toEqual({
      error: {
        code: "mediaTypeMismatch",
        message: "Attachment content does not match its media type",
      },
    });

    const oversized = await uploadAttachment(
      url,
      "test-token",
      Buffer.alloc(10 * 1024 * 1024 + 1),
    );
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("connection")).toBe("close");
    await expect(oversized.json()).resolves.toEqual({
      error: {
        code: "attachmentTooLarge",
        message: "Attachment exceeds the per-file size limit",
      },
    });
  });

  it("does not consume an attachment when turn cwd validation fails", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const upload = await uploadAttachment(url, "test-token");
    const uploadBody = await upload.json() as { attachment: { id: string } };
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "image-bad-cwd",
      method: "turn/start",
      params: {
        threadId: "thread-owned",
        input: [{ type: "localImage", attachmentId: uploadBody.attachment.id }],
        cwd: "relative",
      },
    }));
    await expect(waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "image-bad-cwd",
    )).resolves.toEqual({
      type: "rpcError",
      id: "image-bad-cwd",
      error: { code: -32602, message: "turn/start cwd must be an absolute path" },
    });
    expect(gateway.request.mock.calls.filter(([method]) => method === "turn/start"))
      .toHaveLength(0);

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "image-valid-cwd",
      method: "turn/start",
      params: {
        threadId: "thread-owned",
        input: [{ type: "localImage", attachmentId: uploadBody.attachment.id }],
        cwd: process.cwd(),
      },
    }));
    await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "image-valid-cwd",
    );
    expect(gateway.request.mock.calls.filter(([method]) => method === "turn/start"))
      .toHaveLength(1);
  });

  it("releases attachments when turn completion arrives before turn/start returns", async () => {
    const gateway = new FakeGateway();
    let resolveTurnStart: (result: unknown) => void = () => undefined;
    const turnStartResult = new Promise<unknown>((resolve) => {
      resolveTurnStart = resolve;
    });
    gateway.request.mockImplementationOnce(() => turnStartResult);
    const service = new AskCodexServer(config("test-token"), gateway);
    primeWorkspaceSandboxAuthority(service, "thread-owned");
    services.push(service);
    const { url } = await service.start();
    const upload = await uploadAttachment(url, "test-token");
    const uploadBody = await upload.json() as { attachment: { id: string } };
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "completion-race",
      method: "turn/start",
      params: {
        threadId: "thread-owned",
        input: [{ type: "localImage", attachmentId: uploadBody.attachment.id }],
        cwd: process.cwd(),
      },
    }));
    await vi.waitFor(() => {
      expect(gateway.request.mock.calls.some(([method]) => method === "turn/start")).toBe(true);
    });
    const turnStartCall = gateway.request.mock.calls.find(([method]) => method === "turn/start");
    const storedPath = (turnStartCall?.[1] as {
      input: Array<{ type: string; path?: string }>;
    }).input[0].path;
    expect(storedPath).toEqual(expect.any(String));
    await expect(stat(storedPath as string)).resolves.toBeDefined();

    gateway.emit("notification", "turn/completed", {
      threadId: "thread-owned",
      turn: { id: "turn-with-attachments", status: "completed", items: [] },
    });
    resolveTurnStart({
      turn: { id: "turn-with-attachments", status: "inProgress", items: [] },
    });
    await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "completion-race",
    );
    await vi.waitFor(async () => {
      await expect(stat(storedPath as string)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("holds turn attachments after the requester disconnects until completion", async () => {
    const gateway = new FakeGateway();
    let resolveTurnStart: (result: unknown) => void = () => undefined;
    const turnStartResult = new Promise<unknown>((resolve) => {
      resolveTurnStart = resolve;
    });
    gateway.request.mockImplementationOnce(() => turnStartResult);
    const service = new AskCodexServer(config("test-token"), gateway);
    primeWorkspaceSandboxAuthority(service, "thread-disconnected-turn");
    services.push(service);
    const { url } = await service.start();
    const upload = await uploadAttachment(url, "test-token");
    const uploadBody = await upload.json() as { attachment: { id: string } };
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "disconnect-after-turn-start",
      method: "turn/start",
      params: {
        threadId: "thread-disconnected-turn",
        input: [{ type: "localImage", attachmentId: uploadBody.attachment.id }],
        cwd: process.cwd(),
      },
    }));
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: "thread-disconnected-turn" }),
    ));
    const turnStartCall = gateway.request.mock.calls.find(([method]) => method === "turn/start");
    const storedPath = (turnStartCall?.[1] as {
      input: Array<{ type: string; path?: string }>;
    }).input[0].path;
    expect(storedPath).toEqual(expect.any(String));
    await expect(stat(storedPath as string)).resolves.toBeDefined();

    const disconnected = once(client.socket, "close");
    client.socket.close();
    await disconnected;
    resolveTurnStart({
      turn: { id: "turn-disconnected", status: "inProgress", items: [] },
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    await expect(stat(storedPath as string)).resolves.toBeDefined();

    gateway.emit("notification", "turn/completed", {
      threadId: "thread-disconnected-turn",
      turn: { id: "turn-disconnected", status: "completed", items: [] },
    });
    await vi.waitFor(async () => {
      await expect(stat(storedPath as string)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("releases turn attachments when Codex errors after observing the start result", async () => {
    const gateway = new FakeGateway();
    let storedPath: string | undefined;
    gateway.requestWithResultObserver.mockImplementationOnce(async (
      _method,
      params,
      onResult,
    ) => {
      storedPath = (params as { input: Array<{ path?: string }> }).input[0]?.path;
      const result = {
        turn: { id: "turn-before-protocol-error", status: "inProgress", items: [] },
      };
      onResult(result);
      gateway.emit("status", {
        status: "error",
        error: { message: "Codex protocol error" },
      });
      return result;
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const upload = await uploadAttachment(url, "test-token");
    const uploadBody = await upload.json() as { attachment: { id: string } };
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "attachment-result-before-error",
      method: "turn/start",
      params: {
        threadId: "thread-before-protocol-error",
        input: [{ type: "localImage", attachmentId: uploadBody.attachment.id }],
        cwd: process.cwd(),
      },
    }));

    await expect(waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" &&
        message.id === "attachment-result-before-error",
    )).resolves.toEqual({
      type: "rpcError",
      id: "attachment-result-before-error",
      error: {
        code: -32_000,
        message: "turn/start was canceled after Codex entered an error state",
      },
    });
    expect(storedPath).toEqual(expect.any(String));
    await vi.waitFor(async () => {
      await expect(stat(storedPath as string)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("releases active attachment leases when Codex enters an error state", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const upload = await uploadAttachment(url, "test-token");
    const uploadBody = await upload.json() as { attachment: { id: string } };
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "image-before-error",
      method: "turn/start",
      params: {
        threadId: "thread-owned",
        input: [{ type: "localImage", attachmentId: uploadBody.attachment.id }],
        cwd: process.cwd(),
      },
    }));
    await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "image-before-error",
    );
    const turnStartCall = gateway.request.mock.calls.find(([method]) => method === "turn/start");
    const storedPath = (turnStartCall?.[1] as {
      input: Array<{ type: string; path?: string }>;
    }).input[0].path;
    expect(storedPath).toEqual(expect.any(String));
    await expect(stat(storedPath as string)).resolves.toBeDefined();

    gateway.emit("status", { status: "error", error: { message: "Codex stopped" } });
    await vi.waitFor(async () => {
      await expect(stat(storedPath as string)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("materializes one-shot attachment IDs as localImage paths until turn completion", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();

    const upload = await uploadAttachment(url, "test-token");
    expect(upload.status).toBe(201);
    const uploadBody = await upload.json() as {
      attachment: { id: string; kind: string; mediaType: string; size: number; expiresAt: number };
    };
    expect(uploadBody.attachment).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      kind: "image",
      mediaType: "image/png",
      size: PNG.byteLength,
      expiresAt: expect.any(Number),
    });
    expect(uploadBody.attachment).not.toHaveProperty("path");

    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");
    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "image-turn",
      method: "turn/start",
      params: {
        threadId: "thread-owned",
        input: [
          { type: "text", text: "Inspect this image", text_elements: [] },
          { type: "localImage", attachmentId: uploadBody.attachment.id, detail: "high" },
        ],
        cwd: process.cwd(),
      },
    }));
    await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "image-turn",
    );

    const turnStartCall = gateway.request.mock.calls.find(([method]) => method === "turn/start");
    const codexParams = turnStartCall?.[1] as {
      input: Array<Record<string, unknown>>;
    };
    expect(codexParams.input[0]).toEqual({
      type: "text",
      text: "Inspect this image",
      text_elements: [],
    });
    expect(codexParams.input[1]).toEqual({
      type: "localImage",
      path: expect.stringMatching(/ask-codex-attachments-[^/]+\/[A-Za-z0-9_-]{32}\.png$/),
      detail: "high",
    });
    expect(codexParams.input[1]).not.toHaveProperty("attachmentId");
    const storedPath = codexParams.input[1].path as string;
    await expect(stat(storedPath)).resolves.toBeDefined();

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "reuse-image",
      method: "turn/start",
      params: {
        threadId: "thread-owned",
        input: [{ type: "localImage", attachmentId: uploadBody.attachment.id }],
        cwd: process.cwd(),
      },
    }));
    const reuseError = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "reuse-image",
    );
    expect(reuseError).toMatchObject({
      error: { message: "Attachment was not found" },
    });
    expect(gateway.request.mock.calls.filter(([method]) => method === "turn/start"))
      .toHaveLength(1);

    gateway.emit("notification", "turn/completed", {
      threadId: "thread-owned",
      turn: { id: "turn-with-attachments", status: "completed", items: [] },
    });
    await vi.waitFor(async () => {
      await expect(stat(storedPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("materializes ordinary files only through a server-owned application context", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const data = Buffer.from("private report contents");

    const unauthorized = await fetch(`${url}/api/file-attachments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        Origin: "http://localhost:5173",
        "X-Ask-Codex-File-Name": encodeURIComponent("report.pdf"),
      },
      body: data,
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("connection")).toBe("close");

    const upload = await uploadFileAttachment(
      url,
      "test-token",
      "report.pdf",
      data,
      "application/pdf",
    );
    expect(upload.status).toBe(201);
    const uploadBody = await upload.json() as {
      attachment: { id: string; kind: string; mediaType: string; name: string; size: number };
    };
    expect(uploadBody.attachment).toMatchObject({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      kind: "file",
      mediaType: "application/pdf",
      name: "report.pdf",
      size: data.byteLength,
    });
    expect(uploadBody.attachment).not.toHaveProperty("path");

    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");
    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "file-turn",
      method: "turn/start",
      params: {
        threadId: "thread-owned",
        input: [
          { type: "text", text: "Inspect this report", text_elements: [] },
          { type: "file", attachmentId: uploadBody.attachment.id },
        ],
        cwd: process.cwd(),
      },
    }));
    await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "file-turn",
    );

    const turnStartCall = gateway.request.mock.calls.find(([method]) => method === "turn/start");
    const codexParams = turnStartCall?.[1] as {
      input: Array<Record<string, unknown>>;
      additionalContext: Record<string, { kind: string; value: string }>;
    };
    expect(codexParams.input).toEqual([
      { type: "text", text: "Inspect this report", text_elements: [] },
      expect.objectContaining({ type: "text", text: "Attached file: report.pdf" }),
    ]);
    expect(JSON.stringify(codexParams.input)).not.toContain("ask-codex-attachments-");
    const context = codexParams.additionalContext["ask-codex.uploaded-files"];
    expect(context.kind).toBe("application");
    const files = JSON.parse(context.value.split("\n").at(-1)!) as Array<{
      name: string;
      path: string;
    }>;
    expect(files).toEqual([{
      name: "report.pdf",
      path: expect.stringMatching(/ask-codex-attachments-[^/]+\/[A-Za-z0-9_-]{32}\.pdf$/),
    }]);
    await expect(stat(files[0].path)).resolves.toBeDefined();

    gateway.emit("notification", "turn/completed", {
      threadId: "thread-owned",
      turn: { id: "turn-with-attachments", status: "completed", items: [] },
    });
    await vi.waitFor(async () => {
      await expect(stat(files[0].path)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("deletes pending attachment IDs without exposing a file endpoint", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const upload = await uploadAttachment(url, "test-token");
    const body = await upload.json() as { attachment: { id: string } };

    const deleted = await fetch(`${url}/api/attachments/${body.attachment.id}`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer test-token",
        Origin: "http://localhost:5173",
      },
    });
    expect(deleted.status).toBe(204);
    const missing = await fetch(`${url}/api/attachments/${body.attachment.id}`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer test-token",
        Origin: "http://localhost:5173",
      },
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: { code: "attachmentNotFound", message: "Attachment was not found" },
    });
  });

  it("projects completed agent file links as authenticated one-shot downloads", async () => {
    const gateway = new FakeGateway();
    const href = `${process.cwd()}/package.json:1`;
    gateway.request.mockResolvedValueOnce({
      thread: {
        id: "thread-download",
        cwd: process.cwd(),
        turns: [{
          id: "turn-download",
          status: "completed",
          itemsView: "full",
          items: [{
            id: "agent-download",
            type: "agentMessage",
            text: `[package](${href})`,
            askCodexFileDownloads: [{
              href: "/private/spoofed",
              capabilityId: "a".repeat(32),
            }],
          }],
        }],
      },
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "read-download",
      method: "thread/read",
      params: { threadId: "thread-download", includeTurns: true },
    }));
    const result = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "read-download",
    );
    const projected = result.type === "rpcResult" ? result.result as {
      thread: {
        turns: Array<{
          items: Array<{
            askCodexFileDownloads?: Array<{ href: string; capabilityId: string }>;
          }>;
        }>;
      };
    } : undefined;
    const descriptor = projected?.thread.turns[0]?.items[0]?.askCodexFileDownloads?.[0];
    expect(descriptor).toEqual({
      href,
      capabilityId: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
    });
    expect(JSON.stringify(result)).not.toContain("/private/spoofed");
    const capabilityId = descriptor?.capabilityId;
    expect(capabilityId).toBeDefined();

    const endpoint = `${url}/api/file-downloads/${capabilityId}`;
    const unauthorized = await fetch(endpoint, {
      method: "POST",
      headers: { Origin: "http://localhost:5173" },
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("connection")).toBe("close");

    const badOrigin = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        Origin: "https://evil.example",
      },
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers.get("connection")).toBe("close");

    const pathBody = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "Content-Type": "application/json",
        Origin: "http://localhost:5173",
      },
      body: JSON.stringify({ path: "/etc/passwd" }),
    });
    expect(pathBody.status).toBe(400);
    expect(pathBody.headers.get("connection")).toBe("close");
    expect(await pathBody.json()).toEqual({
      error: {
        code: "invalidFileDownloadRequest",
        message: "File download request is invalid",
      },
    });

    const download = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        Origin: "http://localhost:5173",
      },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition"))
      .toBe("attachment; filename=\"package.json\"; filename*=UTF-8''package.json");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(await readFile("package.json"));

    const reused = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        Origin: "http://localhost:5173",
      },
    });
    expect(reused.status).toBe(404);
    expect(await reused.json()).toEqual({
      error: {
        code: "fileDownloadNotFound",
        message: "File download is unavailable",
      },
    });
  });

  it("terminates stalled file downloads and releases their lease at the transfer deadline", async () => {
    const gateway = new FakeGateway();
    const fileDownloads = new FileDownloadStore();
    const source = new PassThrough();
    source.write("a");
    const release = vi.fn(async (): Promise<void> => undefined);
    vi.spyOn(fileDownloads, "consume").mockResolvedValue({
      name: "stalled.bin",
      size: 2,
      createReadStream: () => source,
      release,
    });
    const timeoutController = new AbortController();
    const clearTimeout = vi.fn();
    const timeoutFactory = vi.fn(() => ({
      signal: timeoutController.signal,
      clear: clearTimeout,
    }));
    const service = new AskCodexServer(
      config("test-token"),
      gateway,
      undefined,
      fileDownloads,
      timeoutFactory,
    );
    services.push(service);
    const { url } = await service.start();

    let responseStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      responseStarted = resolve;
    });
    const terminated = new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${url}/api/file-downloads/${"a".repeat(32)}`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          Origin: "http://localhost:5173",
        },
      }, (response) => {
        responseStarted?.();
        response.resume();
        response.once("aborted", resolve);
        response.once("error", resolve);
        response.once("end", () => reject(new Error("Stalled download completed unexpectedly")));
      });
      request.once("error", reject);
      request.end();
    });

    await started;
    expect(timeoutFactory).toHaveBeenCalledWith(2 * 60 * 1000);
    expect(source.destroyed).toBe(false);

    timeoutController.abort();

    await terminated;
    await vi.waitFor(() => {
      expect(source.destroyed).toBe(true);
      expect(clearTimeout).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it("returns JSON without attachment headers when a download fails before its first byte", async () => {
    const gateway = new FakeGateway();
    const fileDownloads = new FileDownloadStore();
    const release = vi.fn(async (): Promise<void> => undefined);
    vi.spyOn(fileDownloads, "consume").mockResolvedValue({
      name: "unreadable.bin",
      size: 999_999,
      createReadStream: () => new Readable({
        read() {
          this.destroy(new Error("first read failed"));
        },
      }),
      release,
    });
    const clearTimeout = vi.fn();
    const service = new AskCodexServer(
      config("test-token"),
      gateway,
      undefined,
      fileDownloads,
      () => ({ signal: new AbortController().signal, clear: clearTimeout }),
    );
    services.push(service);
    const { url } = await service.start();

    const response = await fetch(`${url}/api/file-downloads/${"a".repeat(32)}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        Origin: "http://localhost:5173",
      },
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("content-length")).not.toBe("999999");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "fileDownloadsUnavailable",
        message: "File downloads are unavailable",
      },
    });
    expect(clearTimeout).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("times out a download that stalls before its first byte", async () => {
    const gateway = new FakeGateway();
    const fileDownloads = new FileDownloadStore();
    const source = new PassThrough();
    const release = vi.fn(async (): Promise<void> => undefined);
    vi.spyOn(fileDownloads, "consume").mockResolvedValue({
      name: "never-readable.bin",
      size: 1,
      createReadStream: () => source,
      release,
    });
    const timeoutController = new AbortController();
    const clearTimeout = vi.fn();
    const timeoutFactory = vi.fn(() => ({
      signal: timeoutController.signal,
      clear: clearTimeout,
    }));
    const service = new AskCodexServer(
      config("test-token"),
      gateway,
      undefined,
      fileDownloads,
      timeoutFactory,
    );
    services.push(service);
    const { url } = await service.start();

    const responsePromise = fetch(`${url}/api/file-downloads/${"a".repeat(32)}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        Origin: "http://localhost:5173",
      },
    });
    await vi.waitFor(() => expect(timeoutFactory).toHaveBeenCalledWith(2 * 60 * 1000));
    timeoutController.abort();

    const response = await responsePromise;
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "fileDownloadsUnavailable",
        message: "File downloads are unavailable",
      },
    });
    expect(source.destroyed).toBe(true);
    expect(clearTimeout).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses notification-derived cwd only for completed agent items", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");
    const text = `[package](${process.cwd()}/package.json)`;

    gateway.emit("notification", "thread/started", {
      thread: { id: "thread-notification-download", cwd: process.cwd() },
    });
    await waitForMessage(
      client.messages,
      (message) => message.type === "notification" && message.method === "thread/started",
    );
    gateway.emit("notification", "item/started", {
      threadId: "thread-notification-download",
      turnId: "turn-notification-download",
      item: { id: "agent-notification-download", type: "agentMessage", text },
    });
    const started = await waitForMessage(
      client.messages,
      (message) => message.type === "notification" && message.method === "item/started",
    );
    expect(JSON.stringify(started)).not.toContain("askCodexFileDownloads");

    gateway.emit("notification", "item/completed", {
      threadId: "thread-notification-download",
      turnId: "turn-notification-download",
      item: { id: "agent-notification-download", type: "agentMessage", text },
    });
    const completed = await waitForMessage(
      client.messages,
      (message) => message.type === "notification" && message.method === "item/completed",
    );
    expect(completed).toMatchObject({
      type: "notification",
      method: "item/completed",
      params: {
        item: {
          askCodexFileDownloads: [{
            href: `${process.cwd()}/package.json`,
            capabilityId: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
          }],
        },
      },
    });
  });

  it("does not restore or decorate file authority from an RPC older than a cwd update", async () => {
    const gateway = new FakeGateway();
    let resolveRead: ((value: unknown) => void) | undefined;
    const pendingRead = new Promise<unknown>((resolve) => {
      resolveRead = resolve;
    });
    gateway.request.mockImplementation(async (method) => (
      method === "thread/read" ? pendingRead : { ok: true }
    ));
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "stale-authority-read",
      method: "thread/read",
      params: { threadId: "thread-stale-authority", includeTurns: true },
    }));
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledWith(
      "thread/read",
      expect.objectContaining({ threadId: "thread-stale-authority" }),
    ));
    gateway.emit("notification", "thread/settings/updated", {
      threadId: "thread-stale-authority",
      threadSettings: { cwd: `${process.cwd()}/src` },
    });
    await waitForMessage(
      client.messages,
      (message) => message.type === "notification" &&
        message.method === "thread/settings/updated",
    );
    resolveRead?.({
      thread: {
        id: "thread-stale-authority",
        cwd: process.cwd(),
        turns: [{
          id: "turn-stale-authority",
          status: "completed",
          itemsView: "full",
          items: [{
            id: "agent-stale-authority",
            type: "agentMessage",
            text: `[source](${process.cwd()}/src/App.tsx)`,
          }],
        }],
      },
    });

    const staleResult = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "stale-authority-read",
    );
    expect(JSON.stringify(staleResult)).not.toContain("askCodexFileDownloads");

    gateway.emit("notification", "item/completed", {
      threadId: "thread-stale-authority",
      turnId: "turn-after-stale-authority",
      item: {
        id: "agent-after-stale-authority",
        type: "agentMessage",
        text: `[outside-new-cwd](${process.cwd()}/package.json)`,
      },
    });
    const completed = await waitForMessage(
      client.messages,
      (message) => message.type === "notification" &&
        message.method === "item/completed" &&
        JSON.stringify(message).includes("outside-new-cwd"),
    );
    expect(JSON.stringify(completed)).not.toContain("askCodexFileDownloads");
  });

  it("accepts authenticated HTTP requests from the configured public origin", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer({
      ...config("test-token"),
      production: true,
      publicOrigin: "https://codex.example.com",
    }, gateway);
    services.push(service);
    const { url } = await service.start();
    const publicHeaders = {
      Authorization: "Bearer test-token",
      Host: "codex.example.com",
    };

    const publicStatus = await requestStatus(`${url}/api/health`, {
      ...publicHeaders,
      Origin: "https://codex.example.com",
    });
    expect(publicStatus).toBe(200);

    const originlessStatus = await requestStatus(`${url}/api/health`, publicHeaders);
    expect(originlessStatus).toBe(200);

    const badOriginStatus = await requestStatus(`${url}/api/health`, {
      ...publicHeaders,
      Origin: "https://evil.example",
    });
    expect(badOriginStatus).toBe(403);
  });

  it("accepts authenticated WebSockets from the configured public origin", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer({
      ...config("test-token"),
      production: true,
      publicOrigin: "https://codex.example.com",
    }, gateway);
    services.push(service);
    const { url } = await service.start();
    const messages: ServerMessage[] = [];
    const socket = new WebSocket(`${url.replace("http", "ws")}/ws`, {
      headers: { Host: "codex.example.com" },
      origin: "https://codex.example.com",
    });
    socket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as ServerMessage);
    });

    await once(socket, "open");
    socket.send(JSON.stringify({ type: "auth", token: "test-token" }));
    await waitForMessage(messages, (message) => message.type === "status");
    socket.close();
  });

  it("normalizes and validates ASK_CODEX_PUBLIC_ORIGIN", () => {
    const loaded = loadConfig({
      ASK_CODEX_PUBLIC_ORIGIN: "https://codex.example.com/",
      ASK_CODEX_TOKEN: "test-token",
    }, process.cwd());
    expect(loaded.publicOrigin).toBe("https://codex.example.com");

    for (const invalidOrigin of [
      "not-a-url",
      "ftp://codex.example.com",
      "https://codex.example.com/path",
      "https://codex.example.com/?query=value",
      "https://codex.example.com/#fragment",
      "https://codex.example.com?",
      "https://codex.example.com#",
      "https://codex.example.com/a/..",
      "https://codex.example.com/%2e%2e",
      "https://codex.example.com\\a\\..",
      "https://codex.exa\nmple.com",
      "https://codex.exa\tmple.com",
      "https://codex.example.com:",
      "https://user:password@codex.example.com",
    ]) {
      expect(() => loadConfig({
        ASK_CODEX_PUBLIC_ORIGIN: invalidOrigin,
        ASK_CODEX_TOKEN: "test-token",
      }, process.cwd())).toThrow("ASK_CODEX_PUBLIC_ORIGIN");
    }
  });

  it("resolves and validates persistent message queue paths", () => {
    expect(loadConfig({
      XDG_STATE_HOME: "/var/tmp/ask-codex-state",
    }, process.cwd()).messageQueuePath).toBe(
      "/var/tmp/ask-codex-state/ask-codex/message-queue.json",
    );
    expect(loadConfig({
      XDG_STATE_HOME: "/var/tmp/ignored-state",
      ASK_CODEX_QUEUE_PATH: "/var/tmp/custom-ask-codex-queue.json",
    }, process.cwd()).messageQueuePath).toBe("/var/tmp/custom-ask-codex-queue.json");
    expect(() => loadConfig({
      ASK_CODEX_QUEUE_PATH: "relative/queue.json",
    }, process.cwd())).toThrow("ASK_CODEX_QUEUE_PATH must be an absolute path");
    expect(() => loadConfig({
      XDG_STATE_HOME: "relative/state",
    }, process.cwd())).toThrow("XDG_STATE_HOME must be an absolute path");
  });

  it.each([
    "/ws?token=test-token",
    "/ws?",
    "/ws#fragment",
    "/ws#",
    "/a/../ws",
    "//evil.example/ws",
    "http://evil.example/ws",
  ])("rejects the WebSocket request target %s before authentication", async (path) => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const handleUpgrade = vi.spyOn(service.webSocketServer, "handleUpgrade");
    const { url } = await service.start();

    expect(await requestUpgradeStatus(url, path)).toBe(400);
    expect(handleUpgrade).not.toHaveBeenCalled();
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it("requires the first WebSocket frame to authenticate", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const messages: ServerMessage[] = [];
    const socket = new WebSocket(`${url.replace("http", "ws")}/ws`, {
      origin: "http://localhost:5173",
    });
    socket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as ServerMessage);
    });

    await once(socket, "open");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(messages).toEqual([]);

    socket.send(JSON.stringify({
      type: "rpc",
      id: "first-frame-is-not-auth",
      method: "model/list",
      params: {},
    }));
    const [code] = await once(socket, "close");
    expect(code).toBe(1008);
    expect(messages).toEqual([]);
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it("closes an oversized browser message before forwarding it", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    const closed = once(client.socket, "close");
    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "oversized-browser-message",
      method: "model/list",
      params: { padding: "x".repeat(1_048_576) },
    }));

    const [code] = await closed;
    expect(code).toBe(1009);
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it("replaces an oversized RPC result with a structured recoverable error", async () => {
    const gateway = new FakeGateway();
    gateway.request.mockResolvedValueOnce({ data: "x".repeat(1_048_576) });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "oversized-result",
      method: "model/list",
      params: {},
    }));
    const error = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "oversized-result",
    );
    expect(error).toEqual({
      type: "rpcError",
      id: "oversized-result",
      error: {
        code: -32_000,
        message: "Codex response exceeded the 1 MiB gateway message limit",
      },
    });
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "after-oversized-result",
      method: "model/list",
      params: {},
    }));
    await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "after-oversized-result",
    );
  });

  it("compacts an oversized history RPC before later lifecycle notifications", async () => {
    const gateway = new FakeGateway();
    gateway.request.mockImplementationOnce(async (method) => {
      if (method !== "thread/read") return { ok: true };
      return {
        thread: {
          id: "thread-history-large",
          cwd: process.cwd(),
          turns: [{
            id: "turn-history-large",
            status: "completed",
            itemsView: "full",
            items: [{
              id: "command-history-large",
              type: "commandExecution",
              status: "completed",
              command: "rg --json pattern",
              aggregatedOutput: "x".repeat(1_048_576),
              exitCode: 0,
            }],
          }],
        },
      };
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "large-history-read",
      method: "thread/read",
      params: { threadId: "thread-history-large", includeTurns: true },
    }));
    const result = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "large-history-read",
    );
    expect(result).toMatchObject({
      type: "rpcResult",
      id: "large-history-read",
      result: {
        thread: {
          id: "thread-history-large",
          turns: [{
            id: "turn-history-large",
            itemsView: "summary",
            items: [{
              id: "command-history-large",
              type: "commandExecution",
              command: "rg --json pattern",
              streamOmittedCharacters: { aggregatedOutput: 1_048_576 },
            }],
          }],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("x".repeat(1_000));

    gateway.emit("notification", "turn/completed", {
      threadId: "thread-history-large",
      turn: { id: "turn-history-large", status: "completed", items: [] },
    });
    await waitForMessage(
      client.messages,
      (message) => message.type === "notification" && message.method === "turn/completed",
    );
  });

  it("falls back to turn shells when a compact history projection is still oversized", async () => {
    const gateway = new FakeGateway();
    const statuses = ["interrupted", "failed", "completed"] as const;
    const largeReasoningItems = Array.from({ length: 16 }, (_, itemIndex) => ({
      id: `reasoning-${itemIndex}`,
      type: "reasoning",
      status: "completed",
      summary: Array.from({ length: 16 }, () => "s".repeat(1_024)),
      content: Array.from({ length: 16 }, () => "c".repeat(1_024)),
    }));
    gateway.request.mockResolvedValueOnce({
      data: Array.from({ length: 3 }, (_, turnIndex) => ({
        id: `turn-shell-${turnIndex}`,
        status: statuses[turnIndex],
        itemsView: "full",
        items: largeReasoningItems,
      })),
      nextCursor: "next-shell-page",
      backwardsCursor: "previous-shell-page",
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "large-history-shells",
      method: "thread/turns/list",
      params: {
        threadId: "thread-history-shells",
        limit: 3,
        sortDirection: "desc",
        itemsView: "full",
      },
    }));
    const result = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "large-history-shells",
    );
    expect(result).toMatchObject({
      result: {
        data: [
          {
            id: "turn-shell-0",
            status: "interrupted",
            items: [],
            itemsView: "summary",
            streamOmittedItems: 16,
          },
          {
            id: "turn-shell-1",
            status: "failed",
            items: [],
            itemsView: "summary",
            streamOmittedItems: 16,
          },
          {
            id: "turn-shell-2",
            status: "completed",
            items: [],
            itemsView: "summary",
            streamOmittedItems: 16,
          },
        ],
        nextCursor: "next-shell-page",
        backwardsCursor: "previous-shell-page",
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(1_048_576);
  });

  it("returns only effective model settings from config/read", async () => {
    const gateway = new FakeGateway();
    gateway.request.mockResolvedValueOnce({
      config: {
        model: "gpt-configured",
        model_reasoning_effort: "max",
        instructions: "private instructions",
        mcp_servers: { private: { bearerToken: "secret" } },
      },
      origins: { model: { name: "user config" } },
      layers: [{ name: "user", path: "/private/config.toml" }],
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "configured-model",
      method: "config/read",
      params: {},
    }));
    const result = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "configured-model",
    );

    expect(gateway.request).toHaveBeenCalledWith("config/read", { includeLayers: false });
    expect(result).toEqual({
      type: "rpcResult",
      id: "configured-model",
      result: { model: "gpt-configured", effort: "max" },
    });
  });

  it("replaces an oversized notification with a bounded resync signal", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    gateway.emit("notification", "item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { aggregatedOutput: "x".repeat(1_048_576) },
    });

    const resync = await waitForMessage(
      client.messages,
      (message) => message.type === "notification" &&
        message.method === "gateway/resyncRequired",
    );
    expect(resync).toEqual({
      type: "notification",
      method: "gateway/resyncRequired",
      params: {
        reason: "messageTooLarge",
        lostMethod: "item/completed",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });
    expect(JSON.stringify(resync)).not.toContain("x".repeat(1_000));
    expect(client.messages.some((message) =>
      message.type === "notification" && message.method === "item/completed"
    )).toBe(false);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    gateway.emit("notification", "turn/completed", { threadId: "thread-1" });
    await waitForMessage(
      client.messages,
      (message) => message.type === "notification" && message.method === "turn/completed",
    );
  });

  it("keeps lifecycle metadata when an item completion carries oversized output", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    gateway.emit("notification", "item/completed", {
      threadId: "thread-large-item",
      turnId: "turn-large-item",
      item: {
        id: "command-large-item",
        type: "commandExecution",
        status: "completed",
        command: "rg --json pattern",
        aggregatedOutput: "x".repeat(1_048_576),
        exitCode: 0,
      },
    });

    const completed = await waitForMessage(
      client.messages,
      (message) => message.type === "notification" &&
        message.method === "item/completed" &&
        typeof message.params === "object" && message.params !== null &&
        "turnId" in message.params && message.params.turnId === "turn-large-item",
    );
    expect(completed).toMatchObject({
      method: "item/completed",
      params: {
        threadId: "thread-large-item",
        turnId: "turn-large-item",
        item: {
          id: "command-large-item",
          type: "commandExecution",
          status: "completed",
          command: "rg --json pattern",
          exitCode: 0,
          streamOmittedCharacters: { aggregatedOutput: 1_048_576 },
        },
      },
    });
    expect(JSON.stringify(completed)).not.toContain("x".repeat(1_000));
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("keeps completion status when a turn completion carries oversized history", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    gateway.emit("notification", "turn/completed", {
      threadId: "thread-large-turn",
      turn: {
        id: "turn-large-turn",
        status: "completed",
        items: [{
          id: "agent-large-turn",
          type: "agentMessage",
          text: "x".repeat(1_048_576),
        }],
        completedAt: 1_800_000_000_000,
        durationMs: 12_345,
      },
    });

    const completed = await waitForMessage(
      client.messages,
      (message) => message.type === "notification" &&
        message.method === "turn/completed" &&
        typeof message.params === "object" && message.params !== null &&
        "turnId" in message.params && message.params.turnId === "turn-large-turn",
    );
    expect(completed).toMatchObject({
      method: "turn/completed",
      params: {
        threadId: "thread-large-turn",
        turnId: "turn-large-turn",
        turn: {
          id: "turn-large-turn",
          status: "completed",
          items: [],
          itemsView: "notLoaded",
          completedAt: 1_800_000_000_000,
          durationMs: 12_345,
        },
      },
    });
    expect(JSON.stringify(completed)).not.toContain("x".repeat(1_000));
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects an oversized server request without routing it to browsers", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    gateway.emit("request", 88, "item/commandExecution/requestApproval", {
      command: "x".repeat(1_048_576),
    });

    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
      88,
      undefined,
      {
        code: -32_000,
        message: "Ask Codex cannot forward a server request larger than 1 MiB",
      },
    ));
    expect(client.messages.some((message) => message.type === "request" && message.id === 88))
      .toBe(false);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects malformed approval decisions before routing them to browsers", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    gateway.emit("request", 96, "item/commandExecution/requestApproval", {
      threadId: "thread-malformed-approval",
      availableDecisions: ["accept", { futureDecision: {} }],
    });

    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
      96,
      undefined,
      {
        code: -32602,
        message: "Ask Codex cannot safely handle this approval request",
      },
    ));
    expect(client.messages.some((message) => message.type === "request" && message.id === 96))
      .toBe(false);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("closes a slow browser with a retryable backpressure reason", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    let serverSocket: WebSocket | undefined;
    service.webSocketServer.once("connection", (socket) => {
      serverSocket = socket;
    });
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");
    expect(serverSocket).toBeDefined();

    Object.defineProperty(serverSocket, "bufferedAmount", {
      configurable: true,
      get: () => 2 * 1024 * 1024,
    });
    const closed = once(client.socket, "close");
    gateway.emit("notification", "turn/completed", { threadId: "thread-1" });

    const [code, reason] = await closed;
    expect(code).toBe(1013);
    expect(reason.toString()).toBe("Client too slow");
  });

  it.each(["backpressure", "sendFailure"] as const)(
    "immediately reroutes an approval when its owner delivery hits %s",
    async (failureMode) => {
      const gateway = new FakeGateway();
      const service = new AskCodexServer(config("test-token"), gateway);
      services.push(service);
      const serverSockets: WebSocket[] = [];
      service.webSocketServer.on("connection", (socket) => serverSockets.push(socket));
      const { url } = await service.start();

      const owner = connect(url, "test-token");
      await once(owner.socket, "open");
      await waitForMessage(owner.messages, (message) => message.type === "status");
      const fallback = connect(url, "test-token");
      await once(fallback.socket, "open");
      await waitForMessage(fallback.messages, (message) => message.type === "status");

      owner.socket.send(JSON.stringify({
        type: "rpc",
        id: "start-owned-thread",
        method: "thread/start",
        params: { cwd: process.cwd() },
      }));
      await waitForMessage(
        owner.messages,
        (message) => message.type === "rpcResult" && message.id === "start-owned-thread",
      );

      const ownerServerSocket = serverSockets[0];
      expect(ownerServerSocket).toBeDefined();
      if (!ownerServerSocket) return;
      let assertFailure: () => void;
      let restoreFailure: () => void;
      if (failureMode === "backpressure") {
        Object.defineProperty(ownerServerSocket, "bufferedAmount", {
          configurable: true,
          get: () => 2 * 1024 * 1024,
        });
        const closeSpy = vi.spyOn(ownerServerSocket, "close")
          .mockImplementation(() => undefined);
        assertFailure = () => expect(closeSpy).toHaveBeenCalledWith(1013, "Client too slow");
        restoreFailure = () => closeSpy.mockRestore();
      } else {
        const sendSpy = vi.spyOn(ownerServerSocket, "send")
          .mockImplementation(() => {
            throw new Error("socket write failed");
          });
        assertFailure = () => expect(sendSpy).toHaveBeenCalled();
        restoreFailure = () => sendSpy.mockRestore();
      }

      try {
        gateway.emit(
          "request",
          89,
          "item/commandExecution/requestApproval",
          { threadId: "thread-owned", command: "true" },
        );

        await waitForMessage(
          fallback.messages,
          (message) => message.type === "request" && message.id === 89,
        );
        assertFailure();
        expect(owner.messages.some((message) => message.type === "request" && message.id === 89))
          .toBe(false);

        fallback.socket.send(JSON.stringify({
          type: "response",
          id: 89,
          result: { decision: "accept" },
        }));
        await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
          89,
          { decision: "accept" },
        ));
      } finally {
        restoreFailure();
        if (ownerServerSocket.readyState !== WebSocket.CLOSED) {
          ownerServerSocket.terminate();
        }
      }
    },
  );

  it("routes approvals to the thread owner and broadcasts notifications", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const first = connect(url, "test-token");
    const second = connect(url, "test-token");
    await Promise.all([once(first.socket, "open"), once(second.socket, "open")]);
    await waitForMessage(first.messages, (message) => message.type === "status");
    await waitForMessage(second.messages, (message) => message.type === "status");

    first.socket.send(JSON.stringify({
      type: "rpc",
      id: "start-1",
      method: "thread/start",
      params: { cwd: process.cwd() },
    }));
    await waitForMessage(
      first.messages,
      (message) => message.type === "rpcResult" && message.id === "start-1",
    );
    expect(gateway.request).toHaveBeenCalledWith("thread/start", {
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });

    gateway.emit(
      "request",
      77,
      "item/commandExecution/requestApproval",
      { threadId: "thread-owned", command: "true" },
    );
    await waitForMessage(
      first.messages,
      (message) => message.type === "request" && message.id === 77,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(second.messages.some((message) => message.type === "request" && message.id === 77))
      .toBe(false);

    first.socket.send(JSON.stringify({
      type: "response",
      id: 77,
      result: { decision: "accept" },
    }));
    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
      77,
      { decision: "accept" },
    ));

    gateway.emit("notification", "turn/completed", { threadId: "thread-owned" });
    await Promise.all([
      waitForMessage(first.messages, (message) => message.type === "notification"),
      waitForMessage(second.messages, (message) => message.type === "notification"),
    ]);
  });

  it("strictly projects live plans and preserves their diagnostic timing", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    gateway.emit("notification", "turn/plan/updated", {
      threadId: "thread-plan-timing",
      turnId: "turn-plan-timing",
      explanation: null,
      plan: [{ step: "Inspect the flow", status: "inProgress", private: "discard" }],
      private: "discard",
    }, 1_800_000_000_123);

    const notification = await waitForMessage(
      client.messages,
      (message) => message.type === "notification" &&
        message.method === "turn/plan/updated",
    );
    expect(notification).toEqual(expect.objectContaining({
      emittedAtMs: 1_800_000_000_123,
      gatewayReceivedAtMs: expect.any(Number),
      params: expect.objectContaining({
        threadId: "thread-plan-timing",
        turnId: "turn-plan-timing",
      }),
    }));
    const notificationParams = notification.type === "notification"
      ? notification.params
      : undefined;
    expect(notificationParams).toEqual({
      threadId: "thread-plan-timing",
      turnId: "turn-plan-timing",
      askCodexPlanRevision: 1,
      plan: [{ step: "Inspect the flow", status: "inProgress" }],
    });

    gateway.emit("notification", "turn/plan/updated", {
      threadId: "thread-plan-timing",
      turnId: "turn-without-upstream-time",
      plan: [{ step: "Keep gateway time", status: "pending" }],
    });
    const withoutUpstreamTime = await waitForMessage(
      client.messages,
      (message) => message.type === "notification" &&
        message.method === "turn/plan/updated" &&
        typeof message.params === "object" && message.params !== null &&
        "turnId" in message.params && message.params.turnId === "turn-without-upstream-time",
    );
    expect(withoutUpstreamTime).toEqual(expect.objectContaining({
      gatewayReceivedAtMs: expect.any(Number),
    }));
    expect(withoutUpstreamTime).not.toHaveProperty("emittedAtMs");

    gateway.emit("notification", "turn/plan/updated", {
      threadId: "thread-plan-timing",
      turnId: "turn-invalid-plan",
      plan: [{ step: "Unsupported", status: "unexpected" }],
    });
    const recovery = await waitForMessage(
      client.messages,
      (message) => message.type === "notification" &&
        message.method === "gateway/resyncRequired" &&
        typeof message.params === "object" && message.params !== null &&
        "turnId" in message.params && message.params.turnId === "turn-invalid-plan",
    );
    expect(recovery).toEqual(expect.objectContaining({
      gatewayReceivedAtMs: expect.any(Number),
      params: expect.objectContaining({
        reason: "planUnavailable",
        lostMethod: "turn/plan/updated",
        threadId: "thread-plan-timing",
        turnId: "turn-invalid-plan",
      }),
    }));
    expect(client.messages.some((message) => (
      message.type === "notification" &&
      message.method === "turn/plan/updated" &&
      typeof message.params === "object" && message.params !== null &&
      "turnId" in message.params && message.params.turnId === "turn-invalid-plan"
    ))).toBe(false);

    gateway.emit("notification", "turn/plan/updated", {
      threadId: "thread-plan-timing",
      turnId: "turn-oversized-plan",
      plan: [{ step: "x".repeat(1_048_576), status: "pending" }],
    });
    const oversizedRecovery = await waitForMessage(
      client.messages,
      (message) => message.type === "notification" &&
        message.method === "gateway/resyncRequired" &&
        typeof message.params === "object" && message.params !== null &&
        "turnId" in message.params && message.params.turnId === "turn-oversized-plan",
    );
    expect(oversizedRecovery).toMatchObject({
      params: {
        reason: "planUnavailable",
        lostMethod: "turn/plan/updated",
        threadId: "thread-plan-timing",
        turnId: "turn-oversized-plan",
      },
    });
    expect(client.messages.some((message) => (
      message.type === "notification" &&
      message.method === "turn/plan/updated" &&
      typeof message.params === "object" && message.params !== null &&
      "turnId" in message.params && message.params.turnId === "turn-oversized-plan"
    ))).toBe(false);

    gateway.request.mockResolvedValueOnce({
      data: [{
        id: "turn-oversized-plan",
        status: "inProgress",
        items: [],
        itemsView: "full",
      }],
      nextCursor: null,
      backwardsCursor: null,
    });
    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "oversized-plan-recovery",
      method: "thread/turns/list",
      params: {
        threadId: "thread-plan-timing",
        limit: 1,
        sortDirection: "desc",
        itemsView: "full",
      },
    }));
    const recovered = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "oversized-plan-recovery",
    );
    expect(recovered).toMatchObject({
      result: {
        data: [{
          id: "turn-oversized-plan",
          plan: null,
          recoveryOmissions: ["turn/plan/updated"],
        }],
      },
    });
  });

  it("recovers the latest plan through a turn page requested before the update", async () => {
    const gateway = new FakeGateway();
    let resolvePage: (result: unknown) => void = () => undefined;
    const pendingPage = new Promise<unknown>((resolve) => {
      resolvePage = resolve;
    });
    gateway.request.mockImplementationOnce(() => pendingPage);
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "plan-page",
      method: "thread/turns/list",
      params: {
        threadId: "thread-plan-cache",
        limit: 10,
        sortDirection: "desc",
        itemsView: "full",
      },
    }));
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledWith(
      "thread/turns/list",
      expect.objectContaining({ threadId: "thread-plan-cache" }),
    ));

    gateway.emit("notification", "turn/plan/updated", {
      threadId: "thread-plan-cache",
      turnId: "turn-plan-cache",
      explanation: "Recovered from the gateway cache.",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Repair", status: "inProgress" },
      ],
    }, 1_800_000_000_456);
    resolvePage({
      data: [{
        id: "turn-plan-cache",
        status: "inProgress",
        itemsView: "full",
        items: [],
      }],
      nextCursor: null,
      backwardsCursor: null,
    });

    const response = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "plan-page",
    );
    const result = response.type === "rpcResult"
      ? response.result as {
          data: Array<{ askCodexPlanRevision?: number; plan: unknown }>;
        }
      : undefined;
    expect(result?.data[0]?.askCodexPlanRevision).toBe(1);
    expect(result?.data[0]?.plan).toEqual({
      explanation: "Recovered from the gateway cache.",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Repair", status: "inProgress" },
      ],
      emittedAtMs: 1_800_000_000_456,
      gatewayReceivedAtMs: expect.any(Number),
    });
  });

  it("broadcasts only sparse projected account rate-limit updates", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (message) => message.type === "status");

    gateway.emit("notification", "account/rateLimits/updated", {
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 61,
          description: "private window",
        },
        planType: "plus",
        email: "private@example.com",
        accountId: "private-account-id",
        resetCredit: {
          id: "opaque-private-id",
          description: "secret reset credit",
        },
      },
      email: "private@example.com",
      description: "secret account metadata",
    });
    const notification = await waitForMessage(
      client.messages,
      (message) => message.type === "notification" &&
        message.method === "account/rateLimits/updated",
    );

    expect(notification).toEqual({
      type: "notification",
      method: "account/rateLimits/updated",
      gatewayReceivedAtMs: expect.any(Number),
      params: {
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 61,
          },
          planType: "plus",
        },
      },
    });
    expect(JSON.stringify(notification)).not.toMatch(
      /private|secret|opaque|email|description/i,
    );
  });

  it("does not change approval ownership when another client reads thread data", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const owner = connect(url, "test-token");
    const reader = connect(url, "test-token");
    await Promise.all([once(owner.socket, "open"), once(reader.socket, "open")]);
    await waitForMessage(owner.messages, (message) => message.type === "status");
    await waitForMessage(reader.messages, (message) => message.type === "status");

    owner.socket.send(JSON.stringify({
      type: "rpc",
      id: "start-owner",
      method: "thread/start",
      params: { cwd: process.cwd() },
    }));
    await waitForMessage(
      owner.messages,
      (message) => message.type === "rpcResult" && message.id === "start-owner",
    );

    reader.socket.send(JSON.stringify({
      type: "rpc",
      id: "read-passively",
      method: "thread/read",
      params: { threadId: "thread-owned", includeTurns: false },
    }));
    await waitForMessage(
      reader.messages,
      (message) => message.type === "rpcResult" && message.id === "read-passively",
    );

    reader.socket.send(JSON.stringify({
      type: "rpc",
      id: "read-turns-passively",
      method: "thread/turns/list",
      params: {
        threadId: "thread-owned",
        limit: 10,
        sortDirection: "desc",
        itemsView: "summary",
      },
    }));
    await waitForMessage(
      reader.messages,
      (message) => message.type === "rpcResult" && message.id === "read-turns-passively",
    );
    expect(gateway.request).toHaveBeenCalledWith("thread/turns/list", {
      threadId: "thread-owned",
      limit: 10,
      sortDirection: "desc",
      itemsView: "summary",
    });

    reader.socket.send(JSON.stringify({
      type: "rpc",
      id: "read-items-passively",
      method: "thread/items/list",
      params: {
        threadId: "thread-owned",
        turnId: "turn-large",
        cursor: "",
        limit: 25,
        sortDirection: "asc",
      },
    }));
    await waitForMessage(
      reader.messages,
      (message) => message.type === "rpcResult" && message.id === "read-items-passively",
    );
    expect(gateway.request).toHaveBeenCalledWith("thread/items/list", {
      threadId: "thread-owned",
      turnId: "turn-large",
      cursor: "",
      limit: 25,
      sortDirection: "asc",
    });

    gateway.emit(
      "request",
      91,
      "item/commandExecution/requestApproval",
      { threadId: "thread-owned", command: "true" },
    );
    await waitForMessage(
      owner.messages,
      (message) => message.type === "request" && message.id === 91,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(reader.messages.some((message) => message.type === "request" && message.id === 91))
      .toBe(false);
  });

  it.each(["thread/resume", "turn/start", "turn/steer"] as const)(
    "changes approval ownership only after a successful %s RPC",
    async (method) => {
      const gateway = new FakeGateway();
      const service = new AskCodexServer(config("test-token"), gateway);
      services.push(service);
      const { url } = await service.start();
      const owner = connect(url, "test-token");
      const challenger = connect(url, "test-token");
      await Promise.all([once(owner.socket, "open"), once(challenger.socket, "open")]);
      await waitForMessage(owner.messages, (message) => message.type === "status");
      await waitForMessage(challenger.messages, (message) => message.type === "status");

      owner.socket.send(JSON.stringify({
        type: "rpc",
        id: "establish-owner",
        method: "thread/start",
        params: { cwd: process.cwd() },
      }));
      await waitForMessage(
        owner.messages,
        (message) => message.type === "rpcResult" && message.id === "establish-owner",
      );

      const params = method === "thread/resume"
        ? { threadId: "thread-owned" }
        : method === "turn/steer"
          ? {
              threadId: "thread-owned",
              expectedTurnId: "turn-owned",
              input: [{ type: "text", text: "steer", text_elements: [] }],
            }
          : {
            threadId: "thread-owned",
            input: [{ type: "text", text: "hello", text_elements: [] }],
          };
      gateway.request.mockRejectedValueOnce(new CodexRpcError({
        code: -32_001,
        message: `${method} rejected`,
      }));
      challenger.socket.send(JSON.stringify({
        type: "rpc",
        id: "failed-claim",
        method,
        params,
      }));
      await waitForMessage(
        challenger.messages,
        (message) => message.type === "rpcError" && message.id === "failed-claim",
      );

      gateway.emit(
        "request",
        92,
        "item/commandExecution/requestApproval",
        { threadId: "thread-owned", command: "true" },
      );
      await waitForMessage(
        owner.messages,
        (message) => message.type === "request" && message.id === 92,
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      expect(challenger.messages.some((message) =>
        message.type === "request" && message.id === 92
      )).toBe(false);

      owner.socket.send(JSON.stringify({
        type: "response",
        id: 92,
        result: { decision: "accept" },
      }));
      await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
        92,
        { decision: "accept" },
      ));

      let resolveSuccessfulClaim: ((result: unknown) => void) | undefined;
      const pendingSuccessfulClaim = new Promise<unknown>((resolve) => {
        resolveSuccessfulClaim = resolve;
      });
      gateway.request.mockImplementationOnce(async () => pendingSuccessfulClaim);
      challenger.socket.send(JSON.stringify({
        type: "rpc",
        id: "successful-claim",
        method,
        params,
      }));
      await vi.waitFor(() => expect(gateway.request).toHaveBeenLastCalledWith(
        method,
        expect.objectContaining({ threadId: "thread-owned" }),
      ));

      gateway.emit(
        "request",
        93,
        "item/commandExecution/requestApproval",
        { threadId: "thread-owned", command: "true" },
      );
      await waitForMessage(
        owner.messages,
        (message) => message.type === "request" && message.id === 93,
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      expect(challenger.messages.some((message) =>
        message.type === "request" && message.id === 93
      )).toBe(false);

      owner.socket.send(JSON.stringify({
        type: "response",
        id: 93,
        result: { decision: "accept" },
      }));
      await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
        93,
        { decision: "accept" },
      ));
      resolveSuccessfulClaim?.(method === "thread/resume"
        ? { thread: { id: "thread-owned" }, sandbox: workspaceSandbox() }
        : method === "turn/steer"
          ? { turnId: "turn-owned" }
          : { turn: { id: "turn-owned", status: "inProgress", items: [] } });
      await waitForMessage(
        challenger.messages,
        (message) => message.type === "rpcResult" && message.id === "successful-claim",
      );

      gateway.emit(
        "request",
        94,
        "item/commandExecution/requestApproval",
        { threadId: "thread-owned", command: "true" },
      );
      await waitForMessage(
        challenger.messages,
        (message) => message.type === "request" && message.id === 94,
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      expect(owner.messages.some((message) => message.type === "request" && message.id === 94))
        .toBe(false);
    },
  );

  it("claims only the new thread after a structurally valid fork result", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const sourceOwner = connect(url, "test-token");
    const forkOwner = connect(url, "test-token");
    await Promise.all([once(sourceOwner.socket, "open"), once(forkOwner.socket, "open")]);
    await waitForMessage(sourceOwner.messages, (message) => message.type === "status");
    await waitForMessage(forkOwner.messages, (message) => message.type === "status");

    sourceOwner.socket.send(JSON.stringify({
      type: "rpc",
      id: "fork-source-owner",
      method: "thread/start",
      params: { cwd: process.cwd() },
    }));
    await waitForMessage(
      sourceOwner.messages,
      (message) => message.type === "rpcResult" && message.id === "fork-source-owner",
    );

    gateway.request.mockResolvedValueOnce({
      thread: {
        id: "thread-forked",
        forkedFromId: "thread-owned",
        cwd: process.cwd(),
        historyMode: "legacy",
        turns: [],
      },
      model: "gpt-5",
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: workspaceSandbox(),
      reasoningEffort: "high",
    });
    forkOwner.socket.send(JSON.stringify({
      type: "rpc",
      id: "fork-thread",
      method: "thread/fork",
      params: { threadId: "thread-owned" },
    }));
    await waitForMessage(
      forkOwner.messages,
      (message) => message.type === "rpcResult" && message.id === "fork-thread",
    );
    expect(gateway.request).toHaveBeenLastCalledWith("thread/fork", {
      threadId: "thread-owned",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      excludeTurns: true,
    });

    gateway.emit(
      "request",
      190,
      "item/commandExecution/requestApproval",
      { threadId: "thread-owned", turnId: "turn-source", itemId: "item-source" },
    );
    gateway.emit(
      "request",
      191,
      "item/commandExecution/requestApproval",
      { threadId: "thread-forked", turnId: "turn-fork", itemId: "item-fork" },
    );
    await Promise.all([
      waitForMessage(
        sourceOwner.messages,
        (message) => message.type === "request" && message.id === 190,
      ),
      waitForMessage(
        forkOwner.messages,
        (message) => message.type === "request" && message.id === 191,
      ),
    ]);
    expect(forkOwner.messages.some((message) => message.type === "request" && message.id === 190))
      .toBe(false);
    expect(sourceOwner.messages.some((message) => message.type === "request" && message.id === 191))
      .toBe(false);
  });

  it("rejects a malformed fork result without taking an existing thread owner", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const owner = connect(url, "test-token");
    const challenger = connect(url, "test-token");
    await Promise.all([once(owner.socket, "open"), once(challenger.socket, "open")]);
    await waitForMessage(owner.messages, (message) => message.type === "status");
    await waitForMessage(challenger.messages, (message) => message.type === "status");

    owner.socket.send(JSON.stringify({
      type: "rpc",
      id: "fork-collision-owner",
      method: "thread/start",
      params: { cwd: process.cwd() },
    }));
    await waitForMessage(
      owner.messages,
      (message) => message.type === "rpcResult" && message.id === "fork-collision-owner",
    );

    gateway.request.mockResolvedValueOnce({
      thread: {
        id: "thread-owned",
        forkedFromId: "thread-source",
        cwd: process.cwd(),
        historyMode: "legacy",
        turns: [],
      },
      model: "gpt-5",
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: workspaceSandbox(),
    });
    challenger.socket.send(JSON.stringify({
      type: "rpc",
      id: "fork-collision",
      method: "thread/fork",
      params: { threadId: "thread-source" },
    }));
    await waitForMessage(
      challenger.messages,
      (message) => message.type === "rpcError" && message.id === "fork-collision",
    );

    gateway.emit(
      "request",
      192,
      "item/commandExecution/requestApproval",
      { threadId: "thread-owned", turnId: "turn-owned", itemId: "item-owned" },
    );
    await waitForMessage(
      owner.messages,
      (message) => message.type === "request" && message.id === 192,
    );
    expect(challenger.messages.some((message) => message.type === "request" && message.id === 192))
      .toBe(false);
  });

  it("does not claim a fork result after its requester disconnects", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const requester = connect(url, "test-token");
    await once(requester.socket, "open");
    await waitForMessage(requester.messages, (message) => message.type === "status");

    let resolveFork: ((result: unknown) => void) | undefined;
    gateway.request.mockImplementationOnce(async () => (
      await new Promise<unknown>((resolve) => {
        resolveFork = resolve;
      })
    ));
    requester.socket.send(JSON.stringify({
      type: "rpc",
      id: "fork-before-disconnect",
      method: "thread/fork",
      params: { threadId: "thread-source" },
    }));
    await vi.waitFor(() => expect(resolveFork).toBeTypeOf("function"));

    const closed = once(requester.socket, "close");
    requester.socket.close();
    await closed;
    resolveFork?.({
      thread: {
        id: "thread-forked-after-disconnect",
        forkedFromId: "thread-source",
        cwd: process.cwd(),
        historyMode: "legacy",
        turns: [],
      },
      model: "gpt-5",
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: workspaceSandbox(),
    });
    await vi.waitFor(() => expect(
      (service as unknown as { totalInFlightRpc: number }).totalInFlightRpc
    ).toBe(0));
    const ownership = (service as unknown as {
      ownership: { get(threadId: string): WebSocket | undefined };
    }).ownership;
    expect(ownership.get("thread-forked-after-disconnect")).toBeUndefined();
  });

  it("does not claim steering ownership after its requester disconnects", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const owner = connect(url, "test-token");
    const challenger = connect(url, "test-token");
    await Promise.all([once(owner.socket, "open"), once(challenger.socket, "open")]);
    await waitForMessage(owner.messages, (message) => message.type === "status");
    await waitForMessage(challenger.messages, (message) => message.type === "status");

    owner.socket.send(JSON.stringify({
      type: "rpc",
      id: "steer-disconnect-owner",
      method: "thread/start",
      params: { cwd: process.cwd() },
    }));
    await waitForMessage(
      owner.messages,
      (message) => message.type === "rpcResult" && message.id === "steer-disconnect-owner",
    );

    let resolveSteer: ((result: unknown) => void) | undefined;
    gateway.request.mockImplementationOnce(async () => (
      await new Promise<unknown>((resolve) => {
        resolveSteer = resolve;
      })
    ));
    challenger.socket.send(JSON.stringify({
      type: "rpc",
      id: "steer-before-disconnect",
      method: "turn/steer",
      params: {
        threadId: "thread-owned",
        expectedTurnId: "turn-active",
        input: [{ type: "text", text: "Continue with tests", text_elements: [] }],
      },
    }));
    await vi.waitFor(() => expect(resolveSteer).toBeTypeOf("function"));

    const closed = once(challenger.socket, "close");
    challenger.socket.close();
    await closed;
    resolveSteer?.({ turnId: "turn-active" });
    await vi.waitFor(() => expect(
      (service as unknown as { totalInFlightRpc: number }).totalInFlightRpc
    ).toBe(0));

    gateway.emit(
      "request",
      95,
      "item/commandExecution/requestApproval",
      { threadId: "thread-owned", command: "true" },
    );
    await waitForMessage(
      owner.messages,
      (message) => message.type === "request" && message.id === 95,
    );
  });

  it("fails closed on a mismatched steering result and cancels queued ownership RPCs", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const owner = connect(url, "test-token");
    const challenger = connect(url, "test-token");
    await Promise.all([once(owner.socket, "open"), once(challenger.socket, "open")]);
    await waitForMessage(owner.messages, (message) => message.type === "status");
    await waitForMessage(challenger.messages, (message) => message.type === "status");

    owner.socket.send(JSON.stringify({
      type: "rpc",
      id: "mismatched-steer-owner",
      method: "thread/start",
      params: { cwd: process.cwd() },
    }));
    await waitForMessage(
      owner.messages,
      (message) => message.type === "rpcResult" && message.id === "mismatched-steer-owner",
    );

    let resolveSteer: ((result: unknown) => void) | undefined;
    gateway.request.mockImplementationOnce(async () => (
      await new Promise<unknown>((resolve) => {
        resolveSteer = resolve;
      })
    ));
    challenger.socket.send(JSON.stringify({
      type: "rpc",
      id: "mismatched-steer",
      method: "turn/steer",
      params: {
        threadId: "thread-owned",
        expectedTurnId: "turn-active",
        input: [{ type: "text", text: "Continue with tests", text_elements: [] }],
      },
    }));
    await vi.waitFor(() => expect(resolveSteer).toBeTypeOf("function"));

    challenger.socket.send(JSON.stringify({
      type: "rpc",
      id: "resume-after-mismatched-steer",
      method: "thread/resume",
      params: { threadId: "thread-owned" },
    }));
    await vi.waitFor(() => expect(
      (service as unknown as { totalInFlightRpc: number }).totalInFlightRpc
    ).toBe(2));
    resolveSteer?.({ turnId: "turn-other" });

    await Promise.all([
      expect(waitForMessage(
        challenger.messages,
        (message) => message.type === "rpcError" && message.id === "mismatched-steer",
      )).resolves.toEqual({
        type: "rpcError",
        id: "mismatched-steer",
        error: {
          code: -32_000,
          message: "Codex app-server returned an invalid turn/steer result",
        },
      }),
      expect(waitForMessage(
        challenger.messages,
        (message) => message.type === "rpcError" &&
          message.id === "resume-after-mismatched-steer",
      )).resolves.toEqual({
        type: "rpcError",
        id: "resume-after-mismatched-steer",
        error: {
          code: -32_000,
          message: "thread/resume was canceled because an earlier thread operation " +
            "had an indeterminate result",
        },
      }),
    ]);
    expect(gateway.request.mock.calls.filter(([method]) => method === "thread/resume"))
      .toHaveLength(0);

    gateway.emit(
      "request",
      96,
      "item/commandExecution/requestApproval",
      { threadId: "thread-owned", command: "true" },
    );
    await waitForMessage(
      owner.messages,
      (message) => message.type === "request" && message.id === 96,
    );
  });

  it("does not claim ownership for a malformed top-level turn/start id", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const owner = connect(url, "test-token");
    const challenger = connect(url, "test-token");
    await Promise.all([once(owner.socket, "open"), once(challenger.socket, "open")]);
    await waitForMessage(owner.messages, (message) => message.type === "status");
    await waitForMessage(challenger.messages, (message) => message.type === "status");

    owner.socket.send(JSON.stringify({
      type: "rpc",
      id: "malformed-turn-owner",
      method: "thread/start",
      params: { cwd: process.cwd() },
    }));
    await waitForMessage(
      owner.messages,
      (message) => message.type === "rpcResult" && message.id === "malformed-turn-owner",
    );

    gateway.request.mockResolvedValueOnce({ id: "top-level-turn-id" });
    challenger.socket.send(JSON.stringify({
      type: "rpc",
      id: "malformed-turn-start",
      method: "turn/start",
      params: {
        threadId: "thread-owned",
        input: [{ type: "text", text: "hello", text_elements: [] }],
      },
    }));
    await expect(waitForMessage(
      challenger.messages,
      (message) => message.type === "rpcError" && message.id === "malformed-turn-start",
    )).resolves.toEqual({
      type: "rpcError",
      id: "malformed-turn-start",
      error: {
        code: -32_000,
        message: "Codex app-server returned an invalid turn/start result",
      },
    });

    gateway.emit(
      "request",
      96,
      "item/commandExecution/requestApproval",
      { threadId: "thread-owned", command: "true" },
    );
    await waitForMessage(
      owner.messages,
      (message) => message.type === "request" && message.id === 96,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(challenger.messages.some((message) => message.type === "request" && message.id === 96))
      .toBe(false);
    owner.socket.send(JSON.stringify({
      type: "response",
      id: 96,
      result: { decision: "accept" },
    }));
    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
      96,
      { decision: "accept" },
    ));
  });

  it.each(["thread/start", "thread/resume", "turn/start", "turn/steer"] as const)(
    "claims ownership synchronously with a successful %s result",
    async (method) => {
      const gateway = new FakeGateway();
      const service = new AskCodexServer(config("test-token"), gateway);
      services.push(service);
      const { url } = await service.start();
      const owner = connect(url, "test-token");
      const challenger = connect(url, "test-token");
      await Promise.all([once(owner.socket, "open"), once(challenger.socket, "open")]);
      await waitForMessage(owner.messages, (message) => message.type === "status");
      await waitForMessage(challenger.messages, (message) => message.type === "status");

      owner.socket.send(JSON.stringify({
        type: "rpc",
        id: "synchronous-owner",
        method: "thread/start",
        params: { cwd: process.cwd() },
      }));
      await waitForMessage(
        owner.messages,
        (message) => message.type === "rpcResult" && message.id === "synchronous-owner",
      );

      gateway.requestWithResultObserver.mockImplementationOnce(async (
        _method,
        _params,
        onResult,
      ) => {
        const result = method === "turn/start"
          ? { turn: { id: "turn-synchronous-owner", status: "inProgress", items: [] } }
          : method === "turn/steer"
            ? { turnId: "turn-synchronous-owner" }
            : {
              thread: { id: "thread-owned" },
              sandbox: workspaceSandbox(),
            };
        onResult(result);
        gateway.emit(
          "request",
          100,
          "item/commandExecution/requestApproval",
          { threadId: "thread-owned", command: "true" },
        );
        return result;
      });
      challenger.socket.send(JSON.stringify({
        type: "rpc",
        id: "synchronous-claim",
        method,
        params: method === "thread/start"
          ? { cwd: process.cwd() }
          : method === "thread/resume"
            ? { threadId: "thread-owned" }
            : method === "turn/steer"
              ? {
                  threadId: "thread-owned",
                  expectedTurnId: "turn-synchronous-owner",
                  input: [{ type: "text", text: "steer", text_elements: [] }],
                }
              : {
                  threadId: "thread-owned",
                  input: [{ type: "text", text: "hello", text_elements: [] }],
                },
      }));

      await waitForMessage(
        challenger.messages,
        (message) => message.type === "request" && message.id === 100,
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      expect(owner.messages.some((message) => message.type === "request" && message.id === 100))
        .toBe(false);
      await waitForMessage(
        challenger.messages,
        (message) => message.type === "rpcResult" && message.id === "synchronous-claim",
      );
    },
  );

  it("probes sandbox authority before a direct manual turn and restores writable defaults", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (entry) => entry.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "manual-turn-policy",
      method: "turn/start",
      params: {
        threadId: "thread-manual-policy",
        input: [{ type: "text", text: "inspect", text_elements: [] }],
      },
    }));
    await waitForMessage(
      client.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "manual-turn-policy",
    );

    expect(gateway.request.mock.calls.slice(-2)).toEqual([
      [
        "thread/resume",
        {
          threadId: "thread-manual-policy",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          excludeTurns: true,
        },
      ],
      [
        "turn/start",
        {
          threadId: "thread-manual-policy",
          input: [{ type: "text", text: "inspect", text_elements: [] }],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: workspaceSandbox(),
        },
      ],
    ]);
  });

  it("uses full access with manual fallback for an automatic turn", async () => {
    const gateway = new FakeGateway();
    const authoritativeSandbox = workspaceSandbox(["/workspace/shared"]);
    gateway.request.mockImplementation(async (method, params) => {
      const threadId = (params as { threadId?: string } | undefined)?.threadId ?? "thread-auto-policy";
      if (method === "thread/resume") {
        return { thread: { id: threadId }, sandbox: authoritativeSandbox };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-auto-policy", status: "inProgress", items: [] } };
      }
      return { ok: true };
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (entry) => entry.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "auto-policy-resume",
      method: "thread/resume",
      params: { threadId: "thread-auto-policy" },
    }));
    const resumed = await waitForMessage(
      client.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "auto-policy-resume",
    );
    expect(resumed).toEqual(expect.objectContaining({
      result: expect.objectContaining({ sandbox: { type: "workspaceWrite" } }),
    }));

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "auto-turn-policy",
      method: "turn/start",
      params: {
        threadId: "thread-auto-policy",
        input: [{ type: "text", text: "edit", text_elements: [] }],
        executionMode: "auto",
      },
    }));
    await waitForMessage(
      client.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "auto-turn-policy",
    );

    expect(gateway.request.mock.calls.find(([method]) => method === "turn/start")?.[1])
      .toEqual({
        threadId: "thread-auto-policy",
        input: [{ type: "text", text: "edit", text_elements: [] }],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
  });

  it("preserves an external sandbox instead of sending a turn override", async () => {
    const gateway = new FakeGateway();
    gateway.request.mockImplementation(async (method, params) => {
      const threadId = (params as { threadId?: string } | undefined)?.threadId ?? "thread-external";
      if (method === "thread/resume") {
        return {
          thread: { id: threadId },
          sandbox: { type: "externalSandbox", networkAccess: "restricted" },
        };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-external", status: "inProgress", items: [] } };
      }
      return { ok: true };
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (entry) => entry.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "external-resume",
      method: "thread/resume",
      params: { threadId: "thread-external" },
    }));
    await waitForMessage(
      client.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "external-resume",
    );
    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "external-turn",
      method: "turn/start",
      params: {
        threadId: "thread-external",
        input: [{ type: "text", text: "continue", text_elements: [] }],
      },
    }));
    await waitForMessage(
      client.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "external-turn",
    );

    const turnParams = gateway.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
    expect(turnParams).toEqual(expect.objectContaining({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    }));
    expect(turnParams).not.toHaveProperty("sandboxPolicy");
  });

  it("keeps an external resume without a sandbox override to one app-server request", async () => {
    const gateway = new FakeGateway();
    gateway.request.mockResolvedValueOnce({
      thread: { id: "thread-ordinary" },
      sandbox: { type: "externalSandbox", networkAccess: "restricted" },
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (entry) => entry.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "ordinary-resume",
      method: "thread/resume",
      params: { threadId: "thread-ordinary", excludeTurns: true },
    }));
    await waitForMessage(
      client.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "ordinary-resume",
    );

    expect(gateway.request.mock.calls).toEqual([[
      "thread/resume",
      {
        threadId: "thread-ordinary",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        excludeTurns: true,
      },
    ]]);
  });

  it.each([
    [
      "a mismatched thread",
      { thread: { id: "thread-other" }, sandbox: workspaceSandbox() },
    ],
    ["a missing sandbox", { thread: { id: "thread-owned" } }],
    [
      "an unknown sandbox",
      { thread: { id: "thread-owned" }, sandbox: { type: "futureSandbox" } },
    ],
  ])("preserves existing ownership after a resume returns %s", async (_label, resumeResult) => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const owner = connect(url, "test-token");
    const challenger = connect(url, "test-token");
    await Promise.all([once(owner.socket, "open"), once(challenger.socket, "open")]);
    await waitForMessage(owner.messages, (entry) => entry.type === "status");
    await waitForMessage(challenger.messages, (entry) => entry.type === "status");

    owner.socket.send(JSON.stringify({
      type: "rpc",
      id: "invalid-resume-existing-owner",
      method: "thread/start",
      params: { cwd: process.cwd() },
    }));
    await waitForMessage(
      owner.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "invalid-resume-existing-owner",
    );

    gateway.request.mockResolvedValueOnce(resumeResult);
    challenger.socket.send(JSON.stringify({
      type: "rpc",
      id: "invalid-resume-result",
      method: "thread/resume",
      params: { threadId: "thread-owned" },
    }));

    const error = await waitForMessage(
      challenger.messages,
      (entry) => entry.type === "rpcError" && entry.id === "invalid-resume-result",
    );
    expect(error).toEqual({
      type: "rpcError",
      id: "invalid-resume-result",
      error: {
        code: -32602,
        message: "thread/resume could not verify the existing sandbox",
      },
    });

    gateway.emit(
      "request",
      101,
      "item/commandExecution/requestApproval",
      { threadId: "thread-owned", command: "true" },
    );
    await waitForMessage(
      owner.messages,
      (entry) => entry.type === "request" && entry.id === 101,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(challenger.messages.some((entry) => entry.type === "request" && entry.id === 101))
      .toBe(false);
    owner.socket.send(JSON.stringify({
      type: "response",
      id: 101,
      result: { decision: "accept" },
    }));
    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
      101,
      { decision: "accept" },
    ));
  });

  it("serializes turn/steer with an in-flight ownership RPC for the same thread", async () => {
    const gateway = new FakeGateway();
    const requestResolvers: Array<(result: unknown) => void> = [];
    gateway.request.mockImplementation(async (method) => {
      if (method !== "turn/start" && method !== "turn/steer") return { ok: true };
      return await new Promise<unknown>((resolveRequest) => {
        requestResolvers.push(resolveRequest);
      });
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    primeWorkspaceSandboxAuthority(service, "thread-steer-serialized");
    services.push(service);
    const { url } = await service.start();
    const starter = connect(url, "test-token");
    const steerer = connect(url, "test-token");
    await Promise.all([once(starter.socket, "open"), once(steerer.socket, "open")]);
    await waitForMessage(starter.messages, (entry) => entry.type === "status");
    await waitForMessage(steerer.messages, (entry) => entry.type === "status");

    starter.socket.send(JSON.stringify({
      type: "rpc",
      id: "steer-serialized-start",
      method: "turn/start",
      params: {
        threadId: "thread-steer-serialized",
        input: [{ type: "text", text: "Start", text_elements: [] }],
      },
    }));
    await vi.waitFor(() => expect(requestResolvers).toHaveLength(1));
    steerer.socket.send(JSON.stringify({
      type: "rpc",
      id: "steer-serialized-next",
      method: "turn/steer",
      params: {
        threadId: "thread-steer-serialized",
        expectedTurnId: "turn-steer-serialized",
        input: [{ type: "text", text: "Adjust", text_elements: [] }],
      },
    }));
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(requestResolvers).toHaveLength(1);

    requestResolvers[0]?.({
      turn: { id: "turn-steer-serialized", status: "inProgress", items: [] },
    });
    await waitForMessage(
      starter.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "steer-serialized-start",
    );
    await vi.waitFor(() => expect(requestResolvers).toHaveLength(2));
    expect(gateway.request.mock.calls.map(([method]) => method)).toEqual([
      "turn/start",
      "turn/steer",
    ]);

    requestResolvers[1]?.({ turnId: "turn-steer-serialized" });
    await expect(waitForMessage(
      steerer.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "steer-serialized-next",
    )).resolves.toEqual({
      type: "rpcResult",
      id: "steer-serialized-next",
      result: { turnId: "turn-steer-serialized" },
    });
  });

  it("serializes different ownership-changing RPCs for the same thread", async () => {
    const gateway = new FakeGateway();
    const requestResolvers: Array<(result: unknown) => void> = [];
    gateway.request.mockImplementation(async (method) => {
      if (method !== "thread/resume" && method !== "turn/start") return { ok: true };
      return await new Promise<unknown>((resolveRequest) => {
        requestResolvers.push(resolveRequest);
      });
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    primeWorkspaceSandboxAuthority(service, "thread-serialized-owner");
    services.push(service);
    const { url } = await service.start();
    const turnStarter = connect(url, "test-token");
    const resumer = connect(url, "test-token");
    await Promise.all([once(turnStarter.socket, "open"), once(resumer.socket, "open")]);
    await waitForMessage(turnStarter.messages, (entry) => entry.type === "status");
    await waitForMessage(resumer.messages, (entry) => entry.type === "status");

    turnStarter.socket.send(JSON.stringify({
      type: "rpc",
      id: "serialized-turn-start",
      method: "turn/start",
      params: {
        threadId: "thread-serialized-owner",
        input: [{ type: "text", text: "hello", text_elements: [] }],
      },
    }));
    await vi.waitFor(() => expect(requestResolvers).toHaveLength(1));
    resumer.socket.send(JSON.stringify({
      type: "rpc",
      id: "serialized-resume",
      method: "thread/resume",
      params: { threadId: "thread-serialized-owner" },
    }));
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(requestResolvers).toHaveLength(1);

    requestResolvers[0]?.({
      turn: { id: "turn-serialized-owner", status: "inProgress", items: [] },
    });
    await waitForMessage(
      turnStarter.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "serialized-turn-start",
    );
    await vi.waitFor(() => expect(requestResolvers).toHaveLength(2));

    gateway.emit(
      "request",
      97,
      "item/commandExecution/requestApproval",
      { threadId: "thread-serialized-owner", command: "true" },
    );
    await waitForMessage(
      turnStarter.messages,
      (entry) => entry.type === "request" && entry.id === 97,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(resumer.messages.some((entry) => entry.type === "request" && entry.id === 97))
      .toBe(false);
    turnStarter.socket.send(JSON.stringify({
      type: "response",
      id: 97,
      result: { decision: "accept" },
    }));
    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
      97,
      { decision: "accept" },
    ));

    requestResolvers[1]?.({
      thread: { id: "thread-serialized-owner" },
      sandbox: workspaceSandbox(),
    });
    await waitForMessage(
      resumer.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "serialized-resume",
    );

    gateway.emit(
      "request",
      98,
      "item/commandExecution/requestApproval",
      { threadId: "thread-serialized-owner", command: "true" },
    );
    await waitForMessage(
      resumer.messages,
      (entry) => entry.type === "request" && entry.id === 98,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(turnStarter.messages.some((entry) => entry.type === "request" && entry.id === 98))
      .toBe(false);
  });

  it("does not run a queued ownership RPC after its requester disconnects", async () => {
    const gateway = new FakeGateway();
    let resolveFirstRequest: ((result: unknown) => void) | undefined;
    const firstRequest = new Promise<unknown>((resolve) => {
      resolveFirstRequest = resolve;
    });
    gateway.request.mockImplementation(async (method, params) => {
      if (method === "turn/start") return await firstRequest;
      if (method === "thread/resume") {
        const threadId = typeof params === "object" && params !== null &&
            "threadId" in params && typeof params.threadId === "string"
          ? params.threadId
          : "thread-queued-disconnect";
        return { thread: { id: threadId }, sandbox: workspaceSandbox() };
      }
      return { ok: true };
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    primeWorkspaceSandboxAuthority(service, "thread-queued-disconnect");
    services.push(service);
    const { url } = await service.start();
    const first = connect(url, "test-token");
    const disconnected = connect(url, "test-token");
    await Promise.all([once(first.socket, "open"), once(disconnected.socket, "open")]);
    await waitForMessage(first.messages, (entry) => entry.type === "status");
    await waitForMessage(disconnected.messages, (entry) => entry.type === "status");

    first.socket.send(JSON.stringify({
      type: "rpc",
      id: "disconnect-queue-head",
      method: "turn/start",
      params: {
        threadId: "thread-queued-disconnect",
        input: [{ type: "text", text: "first", text_elements: [] }],
      },
    }));
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledTimes(1));
    disconnected.socket.send(JSON.stringify({
      type: "rpc",
      id: "disconnect-queued-request",
      method: "thread/resume",
      params: { threadId: "thread-queued-disconnect" },
    }));
    await vi.waitFor(() => expect(
      (service as unknown as { totalInFlightRpc: number }).totalInFlightRpc
    ).toBe(2));

    const disconnectedClosed = once(disconnected.socket, "close");
    disconnected.socket.close();
    await disconnectedClosed;
    resolveFirstRequest?.({
      turn: { id: "turn-queue-head", status: "inProgress", items: [] },
    });
    await waitForMessage(
      first.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "disconnect-queue-head",
    );
    await vi.waitFor(() => expect(
      (service as unknown as { totalInFlightRpc: number }).totalInFlightRpc
    ).toBe(0));

    expect(gateway.request.mock.calls.filter(([method]) => (
      method === "thread/resume" || method === "turn/start"
    ))).toHaveLength(1);
  });

  it("does not run a queued ownership RPC after Codex enters an error state", async () => {
    const gateway = new FakeGateway();
    let resolveFirstRequest: ((result: unknown) => void) | undefined;
    const firstRequest = new Promise<unknown>((resolve) => {
      resolveFirstRequest = resolve;
    });
    gateway.request.mockImplementation(async (method, params) => {
      if (method === "turn/start") return await firstRequest;
      if (method === "thread/resume") {
        const threadId = typeof params === "object" && params !== null &&
            "threadId" in params && typeof params.threadId === "string"
          ? params.threadId
          : "thread-queued-error";
        return { thread: { id: threadId }, sandbox: workspaceSandbox() };
      }
      return { ok: true };
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    primeWorkspaceSandboxAuthority(service, "thread-queued-error");
    services.push(service);
    const { url } = await service.start();
    const first = connect(url, "test-token");
    const queued = connect(url, "test-token");
    await Promise.all([once(first.socket, "open"), once(queued.socket, "open")]);
    await waitForMessage(first.messages, (entry) => entry.type === "status");
    await waitForMessage(queued.messages, (entry) => entry.type === "status");

    first.socket.send(JSON.stringify({
      type: "rpc",
      id: "error-queue-head",
      method: "turn/start",
      params: {
        threadId: "thread-queued-error",
        input: [{ type: "text", text: "first", text_elements: [] }],
      },
    }));
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledTimes(1));
    queued.socket.send(JSON.stringify({
      type: "rpc",
      id: "error-queued-request",
      method: "thread/resume",
      params: { threadId: "thread-queued-error" },
    }));
    await vi.waitFor(() => expect(
      (service as unknown as { totalInFlightRpc: number }).totalInFlightRpc
    ).toBe(2));

    gateway.emit("status", { status: "error", error: { message: "Codex stopped" } });
    resolveFirstRequest?.({
      turn: { id: "turn-queue-head", status: "inProgress", items: [] },
    });
    await Promise.all([
      waitForMessage(
        first.messages,
        (entry) => entry.type === "rpcError" && entry.id === "error-queue-head",
      ),
      waitForMessage(
        queued.messages,
        (entry) => entry.type === "rpcError" && entry.id === "error-queued-request",
      ),
    ]);

    expect(gateway.request.mock.calls.filter(([method]) => (
      method === "thread/resume" || method === "turn/start"
    ))).toHaveLength(1);
  });

  it("continues a queued ownership RPC after an ordinary resume is explicitly rejected", async () => {
    const gateway = new FakeGateway();
    let rejectResume: ((error: unknown) => void) | undefined;
    const pendingResume = new Promise<unknown>((_resolve, reject) => {
      rejectResume = reject;
    });
    gateway.request.mockImplementation(async (method) => {
      if (method === "thread/resume") return await pendingResume;
      if (method === "turn/start") {
        return { turn: { id: "turn-after-resume-rejection", status: "inProgress", items: [] } };
      }
      return { ok: true };
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    primeWorkspaceSandboxAuthority(service, "thread-resume-queue");
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");
    await waitForMessage(client.messages, (entry) => entry.type === "status");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "rejected-resume-queue-head",
      method: "thread/resume",
      params: { threadId: "thread-resume-queue" },
    }));
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledTimes(1));
    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "turn-after-rejected-resume",
      method: "turn/start",
      params: {
        threadId: "thread-resume-queue",
        input: [{ type: "text", text: "continue", text_elements: [] }],
      },
    }));
    await vi.waitFor(() => expect(
      (service as unknown as { totalInFlightRpc: number }).totalInFlightRpc
    ).toBe(2));
    expect(gateway.request).toHaveBeenCalledTimes(1);

    rejectResume?.(new CodexRpcError({ code: -32_001, message: "resume rejected" }));
    await Promise.all([
      waitForMessage(
        client.messages,
        (entry) => entry.type === "rpcError" && entry.id === "rejected-resume-queue-head",
      ),
      waitForMessage(
        client.messages,
        (entry) => entry.type === "rpcResult" && entry.id === "turn-after-rejected-resume",
      ),
    ]);
    expect(gateway.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
  });

  it("cancels queued ownership RPCs after an indeterminate queue-head failure", async () => {
    const gateway = new FakeGateway();
    let rejectFirstRequest: ((error: unknown) => void) | undefined;
    const firstRequest = new Promise<unknown>((_resolve, reject) => {
      rejectFirstRequest = reject;
    });
    gateway.request.mockImplementation(async (method, params) => {
      if (method === "turn/start") return await firstRequest;
      if (method === "thread/resume") {
        const threadId = typeof params === "object" && params !== null &&
            "threadId" in params && typeof params.threadId === "string"
          ? params.threadId
          : "thread-indeterminate-queue";
        return { thread: { id: threadId }, sandbox: workspaceSandbox() };
      }
      return { ok: true };
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    primeWorkspaceSandboxAuthority(service, "thread-indeterminate-queue");
    services.push(service);
    const { url } = await service.start();
    const first = connect(url, "test-token");
    const queued = connect(url, "test-token");
    await Promise.all([once(first.socket, "open"), once(queued.socket, "open")]);
    await waitForMessage(first.messages, (entry) => entry.type === "status");
    await waitForMessage(queued.messages, (entry) => entry.type === "status");

    first.socket.send(JSON.stringify({
      type: "rpc",
      id: "indeterminate-queue-head",
      method: "turn/start",
      params: {
        threadId: "thread-indeterminate-queue",
        input: [{ type: "text", text: "first", text_elements: [] }],
      },
    }));
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledTimes(1));
    queued.socket.send(JSON.stringify({
      type: "rpc",
      id: "request-after-indeterminate-failure",
      method: "thread/resume",
      params: { threadId: "thread-indeterminate-queue" },
    }));
    await vi.waitFor(() => expect(
      (service as unknown as { totalInFlightRpc: number }).totalInFlightRpc
    ).toBe(2));

    rejectFirstRequest?.(new Error("turn/start timed out after 5ms"));
    await Promise.all([
      waitForMessage(
        first.messages,
        (entry) => entry.type === "rpcError" && entry.id === "indeterminate-queue-head",
      ),
      expect(waitForMessage(
        queued.messages,
        (entry) => entry.type === "rpcError" &&
          entry.id === "request-after-indeterminate-failure",
      )).resolves.toEqual({
        type: "rpcError",
        id: "request-after-indeterminate-failure",
        error: {
          code: -32_000,
          message: "thread/resume was canceled because an earlier thread operation " +
            "had an indeterminate result",
        },
      }),
    ]);
    expect(gateway.request).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(
      (service as unknown as { totalInFlightRpc: number }).totalInFlightRpc
    ).toBe(0));
    queued.socket.send(JSON.stringify({
      type: "rpc",
      id: "explicit-retry-after-indeterminate-failure",
      method: "thread/resume",
      params: { threadId: "thread-indeterminate-queue" },
    }));
    await waitForMessage(
      queued.messages,
      (entry) => entry.type === "rpcResult" &&
        entry.id === "explicit-retry-after-indeterminate-failure",
    );
    expect(gateway.request).toHaveBeenCalledTimes(2);
  });

  it("continues a queued ownership RPC after the queue head is rejected", async () => {
    const gateway = new FakeGateway();
    let rejectFirstRequest: ((error: unknown) => void) | undefined;
    const firstRequest = new Promise<unknown>((_resolve, reject) => {
      rejectFirstRequest = reject;
    });
    gateway.request.mockImplementation(async (method, params) => {
      if (method === "turn/start") return await firstRequest;
      if (method === "thread/resume") {
        const threadId = typeof params === "object" && params !== null &&
            "threadId" in params && typeof params.threadId === "string"
          ? params.threadId
          : "thread-queued-rejection";
        return { thread: { id: threadId }, sandbox: workspaceSandbox() };
      }
      return { ok: true };
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    primeWorkspaceSandboxAuthority(service, "thread-queued-rejection");
    services.push(service);
    const { url } = await service.start();
    const first = connect(url, "test-token");
    const queued = connect(url, "test-token");
    await Promise.all([once(first.socket, "open"), once(queued.socket, "open")]);
    await waitForMessage(first.messages, (entry) => entry.type === "status");
    await waitForMessage(queued.messages, (entry) => entry.type === "status");

    first.socket.send(JSON.stringify({
      type: "rpc",
      id: "rejected-queue-head",
      method: "turn/start",
      params: {
        threadId: "thread-queued-rejection",
        input: [{ type: "text", text: "first", text_elements: [] }],
      },
    }));
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledTimes(1));
    queued.socket.send(JSON.stringify({
      type: "rpc",
      id: "request-after-rejection",
      method: "thread/resume",
      params: { threadId: "thread-queued-rejection" },
    }));
    await vi.waitFor(() => expect(
      (service as unknown as { totalInFlightRpc: number }).totalInFlightRpc
    ).toBe(2));

    rejectFirstRequest?.(new CodexRpcError({
      code: -32_001,
      message: "queue head rejected",
    }));
    await waitForMessage(
      first.messages,
      (entry) => entry.type === "rpcError" && entry.id === "rejected-queue-head",
    );
    await vi.waitFor(() => expect(gateway.request).toHaveBeenCalledTimes(2));
    await waitForMessage(
      queued.messages,
      (entry) => entry.type === "rpcResult" && entry.id === "request-after-rejection",
    );
    expect(gateway.request.mock.calls[1]).toEqual([
      "thread/resume",
      {
        threadId: "thread-queued-rejection",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
      },
    ]);
  });

  it("rejects relative cwd before forwarding an RPC", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "bad-cwd",
      method: "turn/start",
      params: {
        threadId: "thread-1",
        cwd: "relative",
        input: [{ type: "text", text: "hello", text_elements: [] }],
      },
    }));
    const error = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "bad-cwd",
    );
    expect(error).toEqual({
      type: "rpcError",
      id: "bad-cwd",
      error: { code: -32602, message: "turn/start cwd must be an absolute path" },
    });
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it("validates skills/list directories and returns only projected display metadata", async () => {
    const gateway = new FakeGateway();
    gateway.request.mockResolvedValueOnce({
      data: [{
        cwd: process.cwd(),
        skills: [{
          name: "skill-creator",
          description: "Create Codex skills",
          shortDescription: "Legacy skills summary",
          interface: {
            shortDescription: "Create skills",
            defaultPrompt: "Read private instructions",
          },
          path: "/private/skill-creator/SKILL.md",
          scope: "repo",
          enabled: true,
          dependencies: {
            tools: [{ type: "shell", command: "private-command", value: "secret" }],
          },
        }],
        errors: [],
      }],
    });
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "skills-list",
      method: "skills/list",
      params: { cwds: [process.cwd()], forceReload: true },
    }));
    const result = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcResult" && message.id === "skills-list",
    );
    expect(gateway.request).toHaveBeenCalledWith("skills/list", {
      cwds: [process.cwd()],
      forceReload: true,
    });
    expect(result).toEqual({
      type: "rpcResult",
      id: "skills-list",
      result: {
        data: [{
          cwd: process.cwd(),
          skills: [{
            name: "skill-creator",
            description: "Create Codex skills",
            shortDescription: "Create skills",
            scope: "repo",
            enabled: true,
          }],
          errorCount: 0,
        }],
      },
    });

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "skills-list-file-cwd",
      method: "skills/list",
      params: { cwds: [`${process.cwd()}/package.json`] },
    }));
    const error = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "skills-list-file-cwd",
    );
    expect(error).toEqual({
      type: "rpcError",
      id: "skills-list-file-cwd",
      error: { code: -32602, message: "skills/list cwds[0] must be a directory" },
    });
    expect(gateway.request).toHaveBeenCalledTimes(1);
  });

  it("redacts top-level skills/list app-server errors while preserving their code", async () => {
    const gateway = new FakeGateway();
    gateway.request.mockRejectedValueOnce(new CodexRpcError({
      code: -32_601,
      message: "Could not read /private/skills/broken/SKILL.md",
      data: {
        path: "/private/skills/broken/SKILL.md",
        token: "secret",
      },
    }));
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "skills-list-error",
      method: "skills/list",
      params: { cwds: [process.cwd()] },
    }));
    const error = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "skills-list-error",
    );

    expect(error).toEqual({
      type: "rpcError",
      id: "skills-list-error",
      error: {
        code: -32_601,
        message: "Codex app-server could not list skills",
      },
    });
    expect(JSON.stringify(error)).not.toContain("/private");
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  it.each([
    ["account/read", "Codex app-server could not read account status"],
    ["account/rateLimits/read", "Codex app-server could not read rate limits"],
    ["account/usage/read", "Codex app-server could not read account usage"],
  ])("redacts top-level %s app-server errors", async (method, fixedMessage) => {
    const gateway = new FakeGateway();
    gateway.request.mockRejectedValueOnce(new CodexRpcError({
      code: -32_603,
      message: "Account private@example.com could not read /private/usage.json",
      data: {
        accountId: "private-account-id",
        email: "private@example.com",
        resetCreditId: "opaque-private-credit",
        description: "secret description",
      },
    }));
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "account-monitor-error",
      method,
      params: {},
    }));
    const error = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "account-monitor-error",
    );

    expect(gateway.request).toHaveBeenCalledWith(
      method,
      method === "account/read" ? {} : undefined,
    );
    expect(error).toEqual({
      type: "rpcError",
      id: "account-monitor-error",
      error: {
        code: -32_603,
        message: fixedMessage,
      },
    });
    expect(JSON.stringify(error)).not.toMatch(/private|secret|opaque|email|description/i);
  });

  it("rebuilds granular permission and MCP elicitation approvals", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");

    gateway.emit(
      "request",
      91,
      "item/permissions/requestApproval",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "permission-1",
        environmentId: null,
        startedAtMs: Date.now(),
        cwd: process.cwd(),
        reason: "Needs network access",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    );
    await waitForMessage(
      client.messages,
      (message) => message.type === "request" && message.id === 91,
    );
    client.socket.send(JSON.stringify({
      type: "response",
      id: 91,
      result: { decision: "accept" },
    }));
    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
      91,
      { permissions: { network: { enabled: true } }, scope: "turn" },
    ));

    gateway.emit(
      "request",
      "mcp-92",
      "mcpServer/elicitation/request",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "accounts",
        mode: "url",
        _meta: null,
        message: "Authorize access",
        url: "https://example.com/authorize",
        elicitationId: "elicitation-1",
      },
    );
    await waitForMessage(
      client.messages,
      (message) => message.type === "request" && message.id === "mcp-92",
    );
    client.socket.send(JSON.stringify({
      type: "response",
      id: "mcp-92",
      result: { action: "accept", content: null, _meta: null },
    }));
    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
      "mcp-92",
      { action: "accept", content: null, _meta: null },
    ));
  });

  it("rejects host-level app-server methods without forwarding them", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const client = connect(url, "test-token");
    await once(client.socket, "open");

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "dangerous-method",
      method: "fs/remove",
      params: { path: process.cwd(), recursive: true },
    }));
    const error = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "dangerous-method",
    );
    expect(error).toEqual({
      type: "rpcError",
      id: "dangerous-method",
      error: {
        code: -32601,
        message: "RPC method is not available in Ask Codex: fs/remove",
      },
    });
    expect(gateway.request).not.toHaveBeenCalled();

    client.socket.send(JSON.stringify({
      type: "rpc",
      id: "unsafe-settings",
      method: "thread/start",
      params: {
        cwd: process.cwd(),
        approvalPolicy: "never",
        config: { shell_environment_policy: { inherit: "all" } },
      },
    }));
    const unsafeSettings = await waitForMessage(
      client.messages,
      (message) => message.type === "rpcError" && message.id === "unsafe-settings",
    );
    expect(unsafeSettings).toMatchObject({
      type: "rpcError",
      id: "unsafe-settings",
      error: { code: -32602 },
    });
    expect(gateway.request).not.toHaveBeenCalled();
  });
});
