import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const socket = vi.hoisted(() => ({
  connection: "connected",
  rpc: vi.fn(),
  respond: vi.fn(),
}));

vi.mock("./hooks/useCodexSocket", () => ({
  useCodexSocket: () => ({
    connection: socket.connection,
    connectionDetail: "Ready",
    rpc: socket.rpc,
    respond: socket.respond,
    reconnect: vi.fn(),
  }),
}));

const existingThread = {
  id: "thread-existing",
  name: "Existing thread",
  cwd: "/workspace/existing",
  model: "gpt-5",
  turns: [],
};

function installRpcFixture() {
  socket.rpc.mockImplementation(async (method: string, params?: unknown) => {
    if (method === "thread/list") return { data: [existingThread], nextCursor: null };
    if (method === "model/list") return {
      data: [{
        model: "configured-model",
        displayName: "Configured Model",
        isDefault: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "max" },
        ],
      }],
    };
    if (method === "config/read") return { model: "configured-model", effort: "max" };
    if (method === "thread/start") {
      return { thread: { id: "thread-new", cwd: "/workspace/draft", turns: [] } };
    }
    if (method === "thread/resume") {
      const request = params as { initialTurnsPage?: unknown };
      return request.initialTurnsPage
        ? {
            thread: existingThread,
            cwd: existingThread.cwd,
            model: existingThread.model,
            sandbox: { type: "workspaceWrite" },
            initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
          }
        : { thread: existingThread };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-new", status: "inProgress", items: [] } };
    }
    return {};
  });
}

function installBootstrapFixture() {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      ready: true,
      defaultCwd: "/workspace/default-one",
      authRequired: false,
    }), { status: 200 }))
    .mockResolvedValue(new Response(JSON.stringify({
      ready: true,
      defaultCwd: "/workspace/default-two",
      authRequired: false,
    }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function changeConnectionToken(fetchMock: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole("button", { name: "Connection token" }));
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: "new-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
}

async function sendMessage() {
  fireEvent.change(screen.getByLabelText("Message Codex"), { target: { value: "continue" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith(
    "turn/start",
    expect.objectContaining({ input: expect.any(Array) }),
  ));
}

describe("App thread settings lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    socket.rpc.mockReset();
    socket.respond.mockReset();
    socket.connection = "connected";
    installRpcFixture();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not replace a selected thread cwd when a token refreshes bootstrap", async () => {
    const fetchMock = installBootstrapFixture();
    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");

    await changeConnectionToken(fetchMock);
    await sendMessage();

    expect(socket.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      cwd: "/workspace/existing",
    }));
  });

  it("selects and sends the configured model and effort without Default options", async () => {
    const fetchMock = installBootstrapFixture();
    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByLabelText("Model for next turn")).toHaveValue("configured-model");
      expect(screen.getByLabelText("Reasoning effort for next turn")).toHaveValue("max");
    });
    expect(screen.queryByText(/default model/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/default effort/i)).not.toBeInTheDocument();

    await sendMessage();
    expect(socket.rpc).toHaveBeenCalledWith("thread/start", expect.objectContaining({
      model: "configured-model",
    }));
    expect(socket.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      model: "configured-model",
      effort: "max",
    }));
  });

  it("does not let a late startup config replace a selected thread model", async () => {
    let resolveConfig: ((value: unknown) => void) | undefined;
    const pendingConfig = new Promise<unknown>((resolve) => {
      resolveConfig = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => (
      method === "config/read" ? pendingConfig : baseRpc?.(method, params)
    ));
    const fetchMock = installBootstrapFixture();
    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    expect(screen.getByLabelText("Model for next turn")).toHaveValue("gpt-5");

    resolveConfig?.({ model: "configured-model", effort: "max" });
    await screen.findByRole("option", { name: "Configured Model" });
    expect(screen.getByLabelText("Model for next turn")).toHaveValue("gpt-5");
  });

  it("does not replace config with catalog defaults when config/read fails", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => (
      method === "config/read"
        ? Promise.reject(new Error("temporary config failure"))
        : baseRpc?.(method, params)
    ));
    const fetchMock = installBootstrapFixture();
    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await screen.findByRole("option", { name: "Configured Model" });
    expect(screen.getByLabelText("Model for next turn")).toHaveValue("");
    expect(screen.getByLabelText("Reasoning effort for next turn")).toHaveValue("");
    expect(screen.getByText(/temporary config failure/)).toBeInTheDocument();

    await sendMessage();
    const threadStart = socket.rpc.mock.calls.find(([method]) => method === "thread/start");
    const turnStart = socket.rpc.mock.calls.find(([method]) => method === "turn/start");
    expect(threadStart?.[1]).not.toHaveProperty("model");
    expect(turnStart?.[1]).not.toHaveProperty("model");
    expect(turnStart?.[1]).not.toHaveProperty("effort");
  });

  it("ignores model settings returned by an older connection", async () => {
    let resolveOldConfig: ((value: unknown) => void) | undefined;
    const oldConfig = new Promise<unknown>((resolve) => {
      resolveOldConfig = resolve;
    });
    let modelReads = 0;
    let configReads = 0;
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "model/list") {
        modelReads += 1;
        const current = modelReads === 1
          ? { model: "old-model", displayName: "Old Model" }
          : { model: "new-model", displayName: "New Model" };
        return Promise.resolve({
          data: [{
            ...current,
            isDefault: true,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          }],
        });
      }
      if (method === "config/read") {
        configReads += 1;
        return configReads === 1
          ? oldConfig
          : Promise.resolve({ model: "new-model", effort: "high" });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    const { rerender } = render(<App />);

    await waitFor(() => expect(configReads).toBe(1));
    socket.connection = "disconnected";
    rerender(<App />);
    socket.connection = "connected";
    rerender(<App />);
    await waitFor(() => expect(screen.getByLabelText("Model for next turn")).toHaveValue("new-model"));

    await act(async () => {
      resolveOldConfig?.({ model: "old-model", effort: "high" });
      await oldConfig;
    });
    expect(screen.getByRole("option", { name: "New Model" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Old Model" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Create thread" }));
    expect(screen.getByLabelText("Model for next turn")).toHaveValue("new-model");
  });

  it("does not replace a configured new-thread cwd when a token refreshes bootstrap", async () => {
    const fetchMock = installBootstrapFixture();
    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.change(screen.getByLabelText("Working directory"), {
      target: { value: "/workspace/draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create thread" }));

    await changeConnectionToken(fetchMock);
    await sendMessage();

    expect(socket.rpc).toHaveBeenCalledWith("thread/start", expect.objectContaining({
      cwd: "/workspace/draft",
    }));
    expect(socket.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      cwd: "/workspace/draft",
    }));
  });
});
