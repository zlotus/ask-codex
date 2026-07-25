// @vitest-environment node

import { EventEmitter, once } from "node:events";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodexGateway,
  CodexStatusEvent,
} from "./codex-app-server.js";
import { AskCodexServer, loadConfig, type AskCodexConfig } from "./server.js";
import type { CodexStatus, RpcId, ServerMessage } from "./types.js";

interface FakeGatewayEvents {
  status: [status: CodexStatusEvent];
  notification: [method: string, params: unknown];
  request: [id: RpcId, method: string, params: unknown];
}

class FakeGateway extends EventEmitter<FakeGatewayEvents> implements CodexGateway {
  status: CodexStatus = "ready";
  version: string | undefined = "codex-cli/test";
  error: { message: string } | undefined;
  readonly request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    void params;
    if (method === "thread/start") {
      return { thread: { id: "thread-owned" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-with-attachments", status: "inProgress", items: [] } };
    }
    return { ok: true };
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

describe("AskCodexServer", () => {
  const services: AskCodexServer[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
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
      attachment: { id: string; mediaType: string; size: number; expiresAt: number };
    };
    expect(uploadBody.attachment).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
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

  it("requires the first WebSocket frame to authenticate", async () => {
    const gateway = new FakeGateway();
    const service = new AskCodexServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();
    const messages: ServerMessage[] = [];
    const socket = new WebSocket(
      `${url.replace("http", "ws")}/ws?token=test-token`,
      { origin: "http://localhost:5173" },
    );
    socket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as ServerMessage);
    });

    await once(socket, "open");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(messages).toEqual([]);

    socket.send(JSON.stringify({
      type: "rpc",
      id: "query-token-is-not-auth",
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

  it("fails closed for granular permissions and MCP elicitations", async () => {
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
      { threadId: "thread-1", permissions: { network: { enabled: true } } },
    );
    await waitForMessage(
      client.messages,
      (message) => message.type === "request" && message.id === 91,
    );
    client.socket.send(JSON.stringify({
      type: "response",
      id: 91,
      result: {
        permissions: { network: { enabled: true } },
        scope: "session",
      },
    }));
    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
      91,
      { permissions: {}, scope: "turn" },
    ));

    gateway.emit(
      "request",
      "mcp-92",
      "mcpServer/elicitation/request",
      { threadId: "thread-1", mode: "form", message: "Credentials" },
    );
    await waitForMessage(
      client.messages,
      (message) => message.type === "request" && message.id === "mcp-92",
    );
    client.socket.send(JSON.stringify({
      type: "response",
      id: "mcp-92",
      error: { code: -32601, message: "unsupported" },
    }));
    await vi.waitFor(() => expect(gateway.respond).toHaveBeenCalledWith(
      "mcp-92",
      { action: "decline", content: null, _meta: null },
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
