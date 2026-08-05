// @vitest-environment node

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  CodexAppServer,
  type CodexProcess,
  type SpawnCodex,
} from "./codex-app-server.js";

class FakeCodexProcess extends EventEmitter implements CodexProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function captureJsonLines(stream: PassThrough): unknown[] {
  const messages: unknown[] = [];
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line) {
        messages.push(JSON.parse(line) as unknown);
      }
    }
  });
  return messages;
}

function sendJsonInFragments(
  process: FakeCodexProcess,
  message: unknown,
  fragmentBytes = 1,
): void {
  const encoded = Buffer.from(`${JSON.stringify(message)}\n`);
  for (let offset = 0; offset < encoded.length; offset += fragmentBytes) {
    process.stdout.write(encoded.subarray(offset, offset + fragmentBytes));
  }
}

describe("CodexAppServer", () => {
  it("initializes once and maps JSONL requests, notifications, and server requests", async () => {
    const fakeProcess = new FakeCodexProcess();
    const output = captureJsonLines(fakeProcess.stdin);
    const spawnCodex = vi.fn<SpawnCodex>(() => fakeProcess);
    const client = new CodexAppServer({ spawnCodex, clientVersion: "test-version" });
    const notification = vi.fn();
    const serverRequest = vi.fn();
    client.on("notification", notification);
    client.on("request", serverRequest);

    const starting = client.start();
    expect(spawnCodex).toHaveBeenCalledWith(
      "codex",
      ["app-server", "--listen", "stdio://"],
      expect.objectContaining({ env: expect.any(Object) }),
    );
    expect(output[0]).toEqual({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "ask_codex",
          title: "Ask Codex",
          version: "test-version",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    });

    fakeProcess.send({ id: 1, result: { userAgent: "codex-cli/test" } });
    await starting;
    expect(output[1]).toEqual({ method: "initialized" });
    expect(client.status).toBe("ready");
    expect(client.version).toBe("codex-cli/test");

    const rpc = client.request("thread/list", { limit: 20 });
    await vi.waitFor(() => expect(output).toHaveLength(3));
    expect(output[2]).toEqual({ method: "thread/list", id: 2, params: { limit: 20 } });
    fakeProcess.send({ id: 2, result: { data: [] } });
    await expect(rpc).resolves.toEqual({ data: [] });

    fakeProcess.send({ method: "turn/started", params: { threadId: "thread-1" } });
    fakeProcess.send({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1" },
    });
    expect(notification).toHaveBeenCalledWith(
      "turn/started",
      { threadId: "thread-1" },
    );
    expect(serverRequest).toHaveBeenCalledWith(
      "approval-1",
      "item/commandExecution/requestApproval",
      { threadId: "thread-1" },
    );

    await client.respond("approval-1", { decision: "accept" });
    expect(output[3]).toEqual({
      id: "approval-1",
      result: { decision: "accept" },
    });
    client.close();
  });

  it("forwards only valid notification emission timestamps without changing params or order", async () => {
    const fakeProcess = new FakeCodexProcess();
    const client = new CodexAppServer({ spawnCodex: () => fakeProcess });
    const notifications: Array<{
      method: string;
      params: unknown;
      emittedAtMs: number | undefined;
    }> = [];
    client.on("notification", (method, params, emittedAtMs) => {
      notifications.push({ method, params, emittedAtMs });
    });

    const starting = client.start();
    fakeProcess.send({ id: 1, result: { userAgent: "codex-cli/test" } });
    await starting;

    const notification = (sequence: number, emittedAtMs?: number): string => JSON.stringify({
      method: "turn/plan/updated",
      params: { threadId: "thread-1", turnId: "turn-1", sequence },
      ...(emittedAtMs === undefined ? {} : { emittedAtMs }),
    });
    fakeProcess.stdout.write([
      notification(1, 1_800_000_000_123),
      notification(2),
      notification(3, -1),
      notification(4, 1.5),
      notification(5, Number.MAX_SAFE_INTEGER + 1),
      "",
    ].join("\n"));

    await vi.waitFor(() => expect(notifications).toHaveLength(5));
    expect(notifications).toEqual([
      {
        method: "turn/plan/updated",
        params: { threadId: "thread-1", turnId: "turn-1", sequence: 1 },
        emittedAtMs: 1_800_000_000_123,
      },
      {
        method: "turn/plan/updated",
        params: { threadId: "thread-1", turnId: "turn-1", sequence: 2 },
        emittedAtMs: undefined,
      },
      {
        method: "turn/plan/updated",
        params: { threadId: "thread-1", turnId: "turn-1", sequence: 3 },
        emittedAtMs: undefined,
      },
      {
        method: "turn/plan/updated",
        params: { threadId: "thread-1", turnId: "turn-1", sequence: 4 },
        emittedAtMs: undefined,
      },
      {
        method: "turn/plan/updated",
        params: { threadId: "thread-1", turnId: "turn-1", sequence: 5 },
        emittedAtMs: undefined,
      },
    ]);
    client.close();
  });

  it("observes an RPC result before a later server request in the same stdout chunk", async () => {
    const fakeProcess = new FakeCodexProcess();
    const output = captureJsonLines(fakeProcess.stdin);
    const client = new CodexAppServer({ spawnCodex: () => fakeProcess });

    const starting = client.start();
    fakeProcess.send({ id: 1, result: { userAgent: "codex-cli/test" } });
    await starting;

    const order: string[] = [];
    client.on("request", () => order.push("serverRequest"));
    const rpc = client.requestWithResultObserver(
      "turn/start",
      { threadId: "thread-1", input: [] },
      () => order.push("result"),
    );
    await vi.waitFor(() => expect(output).toHaveLength(3));
    fakeProcess.stdout.write([
      JSON.stringify({
        id: 2,
        result: { turn: { id: "turn-1", status: "inProgress", items: [] } },
      }),
      JSON.stringify({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { threadId: "thread-1" },
      }),
      "",
    ].join("\n"));

    await expect(rpc).resolves.toMatchObject({ turn: { id: "turn-1" } });
    expect(order).toEqual(["result", "serverRequest"]);
    client.close();
  });

  it("observes an RPC result before a later protocol error in the same stdout chunk", async () => {
    const fakeProcess = new FakeCodexProcess();
    const output = captureJsonLines(fakeProcess.stdin);
    const client = new CodexAppServer({ spawnCodex: () => fakeProcess });

    const starting = client.start();
    fakeProcess.send({ id: 1, result: { userAgent: "codex-cli/test" } });
    await starting;

    const order: string[] = [];
    client.on("status", ({ status }) => {
      if (status === "error") order.push("error");
    });
    const rpc = client.requestWithResultObserver(
      "turn/start",
      { threadId: "thread-1", input: [] },
      () => order.push("result"),
    );
    await vi.waitFor(() => expect(output).toHaveLength(3));
    fakeProcess.stdout.write([
      JSON.stringify({
        id: 2,
        result: { turn: { id: "turn-1", status: "inProgress", items: [] } },
      }),
      "not-json",
      "",
    ].join("\n"));

    await expect(rpc).resolves.toMatchObject({ turn: { id: "turn-1" } });
    expect(order).toEqual(["result", "error"]);
    expect(client.status).toBe("error");
    expect(client.error).toEqual({ message: "Codex app-server emitted invalid JSONL" });
    expect(fakeProcess.killed).toBe(true);
    client.close();
  });

  it("rejects observer failures and does not observe RPC errors", async () => {
    const fakeProcess = new FakeCodexProcess();
    const output = captureJsonLines(fakeProcess.stdin);
    const client = new CodexAppServer({ spawnCodex: () => fakeProcess });

    const starting = client.start();
    fakeProcess.send({ id: 1, result: { userAgent: "codex-cli/test" } });
    await starting;

    const throwingObserver = vi.fn(() => {
      throw new Error("invalid observed result");
    });
    const invalidResult = client.requestWithResultObserver(
      "turn/start",
      { threadId: "thread-1", input: [] },
      throwingObserver,
    );
    await vi.waitFor(() => expect(output).toHaveLength(3));
    fakeProcess.send({
      id: 2,
      result: { turn: { id: "turn-1", status: "inProgress", items: [] } },
    });
    await expect(invalidResult).rejects.toThrow("invalid observed result");
    expect(throwingObserver).toHaveBeenCalledOnce();

    const errorObserver = vi.fn();
    const rpcError = client.requestWithResultObserver(
      "turn/start",
      { threadId: "thread-1", input: [] },
      errorObserver,
    );
    await vi.waitFor(() => expect(output).toHaveLength(4));
    fakeProcess.send({ id: 3, error: { code: -32_001, message: "turn rejected" } });
    await expect(rpcError).rejects.toThrow("turn rejected");
    expect(errorObserver).not.toHaveBeenCalled();
    client.close();
  });

  it("does not pass the web access token to the Codex process", async () => {
    const previousToken = process.env.ASK_CODEX_TOKEN;
    process.env.ASK_CODEX_TOKEN = "gateway-secret";
    const fakeProcess = new FakeCodexProcess();
    const spawnCodex = vi.fn<SpawnCodex>(() => fakeProcess);
    const client = new CodexAppServer({ spawnCodex });

    try {
      const starting = client.start();
      const spawnOptions = spawnCodex.mock.calls[0]?.[2];
      expect(spawnOptions?.env?.ASK_CODEX_TOKEN).toBeUndefined();
      fakeProcess.send({ id: 1, result: { userAgent: "codex-cli/test" } });
      await starting;
    } finally {
      client.close();
      if (previousToken === undefined) {
        delete process.env.ASK_CODEX_TOKEN;
      } else {
        process.env.ASK_CODEX_TOKEN = previousToken;
      }
    }
  });

  it("rejects pending requests and reports error when the child exits", async () => {
    const fakeProcess = new FakeCodexProcess();
    const replacementProcess = new FakeCodexProcess();
    const output = captureJsonLines(fakeProcess.stdin);
    const replacementOutput = captureJsonLines(replacementProcess.stdin);
    const spawnCodex = vi.fn<SpawnCodex>()
      .mockReturnValueOnce(fakeProcess)
      .mockReturnValueOnce(replacementProcess);
    const client = new CodexAppServer({ spawnCodex });
    const statuses: string[] = [];
    client.on("status", ({ status }) => statuses.push(status));

    const starting = client.start();
    fakeProcess.send({ id: 1, result: { userAgent: "codex-cli/test" } });
    await starting;
    const pending = client.request("model/list", {});
    await vi.waitFor(() => expect(output).toHaveLength(3));

    fakeProcess.emit("exit", 1, null);
    await expect(pending).rejects.toThrow("exited with code 1");
    expect(client.status).toBe("error");
    expect(client.error).toEqual({ message: "Codex app-server exited with code 1" });
    expect(statuses).toContain("error");

    const retried = client.request("model/list", {});
    await vi.waitFor(() => expect(replacementOutput).toHaveLength(1));
    expect(replacementOutput[0]).toMatchObject({ method: "initialize", id: 3 });
    replacementProcess.send({ id: 3, result: { userAgent: "codex-cli/restarted" } });
    await vi.waitFor(() => expect(replacementOutput).toHaveLength(3));
    expect(replacementOutput[2]).toEqual({ method: "model/list", id: 4, params: {} });
    replacementProcess.send({ id: 4, result: { data: ["model"] } });
    await expect(retried).resolves.toEqual({ data: ["model"] });
    expect(spawnCodex).toHaveBeenCalledTimes(2);
    client.close();
  });

  it("fails an oversized stdout line and restarts cleanly on the next request", async () => {
    const fakeProcess = new FakeCodexProcess();
    const replacementProcess = new FakeCodexProcess();
    const output = captureJsonLines(fakeProcess.stdin);
    const replacementOutput = captureJsonLines(replacementProcess.stdin);
    const spawnCodex = vi.fn<SpawnCodex>()
      .mockReturnValueOnce(fakeProcess)
      .mockReturnValueOnce(replacementProcess);
    const client = new CodexAppServer({
      spawnCodex,
      maxStdoutLineBytes: 128,
    });

    const starting = client.start();
    const initialized = JSON.stringify({
      id: 1,
      result: { userAgent: "codex-cli/test" },
    });
    fakeProcess.stdout.write(initialized.slice(0, 10));
    fakeProcess.stdout.write(`${initialized.slice(10)}\n`);
    await starting;

    const pending = client.request("model/list", {});
    await vi.waitFor(() => expect(output).toHaveLength(3));
    fakeProcess.stdout.write("x".repeat(129));

    await expect(pending).rejects.toThrow(
      "Codex app-server stdout JSONL line exceeded 128 byte limit",
    );
    expect(client.status).toBe("error");
    expect(client.error).toEqual({
      message: "Codex app-server stdout JSONL line exceeded 128 byte limit",
    });
    expect(fakeProcess.killed).toBe(true);

    const retried = client.request("model/list", {});
    await vi.waitFor(() => expect(replacementOutput).toHaveLength(1));
    fakeProcess.emit("exit", null, "SIGTERM");
    expect(client.status).toBe("starting");
    replacementProcess.send({ id: 3, result: { userAgent: "codex-cli/restarted" } });
    await vi.waitFor(() => expect(replacementOutput).toHaveLength(3));
    replacementProcess.send({ id: 4, result: { data: ["model"] } });
    await expect(retried).resolves.toEqual({ data: ["model"] });
    expect(spawnCodex).toHaveBeenCalledTimes(2);
    client.close();
  });

  it("parses highly fragmented stdout lines without repeated concatenation", async () => {
    const fakeProcess = new FakeCodexProcess();
    const output = captureJsonLines(fakeProcess.stdin);
    const client = new CodexAppServer({
      spawnCodex: () => fakeProcess,
      maxStdoutLineBytes: 256,
    });
    const concat = vi.spyOn(Buffer, "concat");

    try {
      const starting = client.start();
      sendJsonInFragments(fakeProcess, {
        id: 1,
        result: { userAgent: "codex-cli/fragmented" },
      });
      await starting;

      const request = client.request("model/list", {});
      await vi.waitFor(() => expect(output).toHaveLength(3));
      sendJsonInFragments(fakeProcess, {
        id: 2,
        result: { data: ["x".repeat(120)] },
      });
      await expect(request).resolves.toEqual({ data: ["x".repeat(120)] });
      expect(concat).not.toHaveBeenCalled();
    } finally {
      concat.mockRestore();
      client.close();
    }
  });

  it("times out initialization and exposes a cleaned status error", async () => {
    const fakeProcess = new FakeCodexProcess();
    const client = new CodexAppServer({
      spawnCodex: () => fakeProcess,
      initializeTimeoutMs: 5,
    });

    await expect(client.start()).rejects.toThrow("initialize timed out after 5ms");
    expect(client.status).toBe("error");
    expect(client.error).toEqual({
      message: "Codex RPC initialize timed out after 5ms",
    });
    expect(fakeProcess.killed).toBe(true);
    client.close();
  });
});
