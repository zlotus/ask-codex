// @vitest-environment node

import { EventEmitter, once } from "node:events";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodexGateway,
  CodexStatusEvent,
} from "./codex-app-server.js";
import { AskAgentServer, type AskAgentConfig } from "./server.js";
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
  readonly request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "thread/start") {
      return { thread: { id: "thread-owned" } };
    }
    return { ok: true };
  });
  readonly respond = vi.fn(async (): Promise<void> => undefined);
  readonly start = vi.fn(async (): Promise<void> => undefined);
  readonly close = vi.fn((): void => undefined);
}

function config(token?: string): AskAgentConfig {
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

describe("AskAgentServer", () => {
  const services: AskAgentServer[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  it("protects HTTP metadata with token and Origin checks", async () => {
    const gateway = new FakeGateway();
    const service = new AskAgentServer(config("test-token"), gateway);
    services.push(service);
    const { url } = await service.start();

    const unauthorized = await fetch(`${url}/api/bootstrap`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
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

  it("requires the first WebSocket frame to authenticate", async () => {
    const gateway = new FakeGateway();
    const service = new AskAgentServer(config("test-token"), gateway);
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

  it("routes approvals to the thread owner and broadcasts notifications", async () => {
    const gateway = new FakeGateway();
    const service = new AskAgentServer(config("test-token"), gateway);
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

  it("rejects relative cwd before forwarding an RPC", async () => {
    const gateway = new FakeGateway();
    const service = new AskAgentServer(config("test-token"), gateway);
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
    const service = new AskAgentServer(config("test-token"), gateway);
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
    const service = new AskAgentServer(config("test-token"), gateway);
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
        message: "RPC method is not available in Ask Agent: fs/remove",
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
