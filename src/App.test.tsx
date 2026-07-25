import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { NotificationMessage } from "./types/protocol";

const socket = vi.hoisted(() => ({
  connection: "connected",
  rpc: vi.fn(),
  respond: vi.fn(),
  onNotification: null as ((message: NotificationMessage) => void) | null,
}));

vi.mock("./hooks/useCodexSocket", () => ({
  useCodexSocket: (options: { onNotification: (message: NotificationMessage) => void }) => {
    socket.onNotification = options.onNotification;
    return {
      connection: socket.connection,
      connectionDetail: "Ready",
      rpc: socket.rpc,
      respond: socket.respond,
      reconnect: vi.fn(),
    };
  },
}));

let objectUrlSequence = 0;
const createObjectURL = vi.fn((blob: Blob) => (
  `blob:${blob instanceof File ? blob.name : blob.type}:${++objectUrlSequence}`
));
const revokeObjectURL = vi.fn();

const existingThread = {
  id: "thread-existing",
  name: "Existing thread",
  cwd: "/workspace/existing",
  model: "gpt-5",
  turns: [],
};

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

function installRpcFixture() {
  socket.rpc.mockImplementation(async (method: string, params?: unknown) => {
    if (method === "thread/list") return { data: [existingThread], nextCursor: null };
    if (method === "model/list") return {
      data: [{
        model: "configured-model",
        displayName: "Configured Model",
        inputModalities: ["text", "image"],
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
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    objectUrlSequence = 0;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    socket.rpc.mockReset();
    socket.respond.mockReset();
    socket.onNotification = null;
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

  it("uploads generic-MIME image bytes and retains a preview with the detected MIME", async () => {
    sessionStorage.setItem("ASK_CODEX_TOKEN", "browser-token");
    const attachmentId = "a".repeat(32);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return new Response(JSON.stringify({
          ready: true,
          defaultCwd: "/workspace/default-one",
          authRequired: true,
        }), { status: 200 });
      }
      if (url === "/api/attachments" && init?.method === "POST") {
        return new Response(JSON.stringify({
          attachment: {
            id: attachmentId,
            mediaType: "image/png",
            size: 3,
            expiresAt: Date.now() + 60_000,
          },
        }), { status: 201 });
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => (
      method === "turn/start"
        ? Promise.resolve({
            turn: {
              id: "turn-image",
              status: "inProgress",
              items: [{
                id: "user-image",
                type: "userMessage",
                content: [
                  { type: "text", text: "Inspect this", text_elements: [] },
                  { type: "localImage", path: "/private/server/screen.png" },
                ],
              }],
            },
          })
        : baseRpc?.(method, params)
    ));
    render(<App />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/bootstrap",
      expect.objectContaining({
        headers: { Authorization: "Bearer browser-token" },
      }),
    ));
    const file = new File([PNG], "screen.png", { type: "application/octet-stream" });
    fireEvent.change(screen.getByLabelText("Choose images"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Message Codex"), { target: { value: "Inspect this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      input: [
        { type: "text", text: "Inspect this", text_elements: [] },
        { type: "localImage", attachmentId },
      ],
    })));
    const uploadCall = fetchMock.mock.calls.find(([input, init]) => (
      String(input) === "/api/attachments" && init?.method === "POST"
    ));
    expect(uploadCall?.[0]).toBe("/api/attachments");
    expect(String(uploadCall?.[0])).not.toContain("browser-token");
    expect(uploadCall?.[1]).toEqual(expect.objectContaining({
      body: file,
      headers: expect.objectContaining({
        Authorization: "Bearer browser-token",
        "Content-Type": "image/png",
      }),
    }));
    await waitFor(() => expect(screen.queryByText("screen.png")).not.toBeInTheDocument());
    const preview = await screen.findByRole("link", { name: "Open uploaded image 1 of 1" });
    expect(preview).toHaveAttribute("href", "blob:image/png:2");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:screen.png:1");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:image/png:2");
    expect(createObjectURL.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      size: file.size,
      type: "image/png",
    }));
    expect(document.body).not.toHaveTextContent("/private/server/screen.png");
  });

  it("keeps streamed conversation visible after a notLoaded completion notification", async () => {
    const fetchMock = installBootstrapFixture();
    render(<App />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await sendMessage();
    await screen.findByRole("button", { name: "Stop turn" });

    act(() => socket.onNotification?.({
      type: "notification",
      method: "item/started",
      params: {
        threadId: "thread-existing",
        turnId: "turn-new",
        item: { id: "agent-stream", type: "agentMessage" },
      },
    }));
    act(() => socket.onNotification?.({
      type: "notification",
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-existing",
        turnId: "turn-new",
        itemId: "agent-stream",
        delta: "Streamed response remains visible",
      },
    }));
    expect(await screen.findByText("Streamed response remains visible")).toBeInTheDocument();

    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/completed",
      params: {
        threadId: "thread-existing",
        turn: {
          id: "turn-new",
          status: "completed",
          itemsView: "notLoaded",
          items: [],
        },
      },
    }));

    expect(screen.getByText("Streamed response remains visible")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop turn" })).not.toBeInTheDocument();
  });

  it("cancels a prepared image turn when thread selection changes during upload", async () => {
    const attachmentId = "b".repeat(32);
    let resolveUpload: ((response: Response) => void) | undefined;
    const pendingUpload = new Promise<Response>((resolve) => {
      resolveUpload = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return Promise.resolve(new Response(JSON.stringify({
          ready: true,
          defaultCwd: "/workspace/default-one",
          authRequired: false,
        }), { status: 200 }));
      }
      if (url === "/api/attachments" && init?.method === "POST") return pendingUpload;
      if (url === `/api/attachments/${attachmentId}` && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByText("Existing thread");
    const file = new File([PNG], "delayed.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose images"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Message Codex"), { target: { value: "stay as draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/attachments",
      expect.objectContaining({ method: "POST", body: file }),
    ));

    fireEvent.click(screen.getByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await act(async () => {
      resolveUpload?.(new Response(JSON.stringify({
        attachment: {
          id: attachmentId,
          mediaType: "image/png",
          size: 3,
          expiresAt: Date.now() + 60_000,
        },
      }), { status: 201 }));
      await pendingUpload;
    });

    expect(await screen.findByText(/Thread changed while preparing the message/)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/attachments/${attachmentId}`,
      expect.objectContaining({ method: "DELETE" }),
    ));
    expect(socket.rpc.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(screen.getByLabelText("Message Codex")).toHaveValue("stay as draft");
    expect(screen.getByText("delayed.png")).toBeInTheDocument();
  });

  it("reports a failed image turn without waiting for attachment cleanup", async () => {
    const attachmentId = "c".repeat(32);
    let resolveDelete: ((response: Response) => void) | undefined;
    const pendingDelete = new Promise<Response>((resolve) => {
      resolveDelete = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return Promise.resolve(new Response(JSON.stringify({
          ready: true,
          defaultCwd: "/workspace/default-one",
          authRequired: false,
        }), { status: 200 }));
      }
      if (url === "/api/attachments" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({
          attachment: {
            id: attachmentId,
            mediaType: "image/png",
            size: 3,
            expiresAt: Date.now() + 60_000,
          },
        }), { status: 201 }));
      }
      if (url === `/api/attachments/${attachmentId}` && init?.method === "DELETE") {
        return pendingDelete;
      }
      return Promise.reject(new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => (
      method === "turn/start"
        ? Promise.reject(new Error("Codex rejected the image turn"))
        : baseRpc?.(method, params)
    ));
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add images" })).toBeEnabled());

    const file = new File([PNG], "retry-after-error.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose images"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Message Codex"), { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Codex rejected the image turn")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    expect(screen.getByLabelText("Message Codex")).toHaveValue("keep this draft");
    expect(screen.getByText("retry-after-error.png")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/attachments/${attachmentId}`,
      expect.objectContaining({ method: "DELETE" }),
    );

    await act(async () => {
      resolveDelete?.(new Response(null, { status: 204 }));
      await pendingDelete;
    });
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

  it("hydrates a large summary turn through item pages", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "thread/resume") {
        return {
          thread: existingThread,
          cwd: existingThread.cwd,
          model: existingThread.model,
          sandbox: { type: "workspaceWrite" },
          initialTurnsPage: {
            data: [{
              id: "turn-large",
              status: "completed",
              itemsView: "summary",
              items: [{ id: "summary", type: "agentMessage", text: "Summary only" }],
            }],
            nextCursor: null,
            backwardsCursor: null,
          },
        };
      }
      if (method === "thread/items/list") {
        const request = params as { cursor?: string };
        return request.cursor === "item-page-2"
          ? {
              data: [{
                turnId: "turn-large",
                item: { id: "agent", type: "agentMessage", text: "Second item page" },
              }],
              nextCursor: null,
              backwardsCursor: "item-page-2-backwards",
            }
          : {
              data: [{
                turnId: "turn-large",
                item: { id: "user", type: "userMessage", text: "First item page" },
              }],
              nextCursor: "item-page-2",
              backwardsCursor: "item-page-1-backwards",
            };
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    fireEvent.click(await screen.findByRole("button", { name: "Load full detail" }));

    expect(await screen.findByText("First item page")).toBeInTheDocument();
    expect(screen.queryByText("Summary only")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more detail" }));

    expect(await screen.findByText("Second item page")).toBeInTheDocument();
    expect(screen.queryByText("Large turn detail loaded in parts")).not.toBeInTheDocument();
    expect(socket.rpc).toHaveBeenCalledWith("thread/items/list", {
      threadId: "thread-existing",
      turnId: "turn-large",
      limit: 10,
      sortDirection: "asc",
    });
    expect(socket.rpc).toHaveBeenCalledWith("thread/items/list", {
      threadId: "thread-existing",
      turnId: "turn-large",
      cursor: "item-page-2",
      limit: 10,
      sortDirection: "asc",
    });
  });

  it("falls back to a full-turn retry when item pagination is unsupported", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "thread/resume") {
        return {
          thread: { ...existingThread, historyMode: "legacy" },
          initialTurnsPage: {
            data: [{
              id: "turn-legacy",
              status: "completed",
              itemsView: "summary",
              items: [],
            }],
            nextCursor: null,
            backwardsCursor: null,
          },
        };
      }
      if (method === "thread/turns/list") {
        return {
          data: [{
            id: "turn-legacy",
            status: "completed",
            itemsView: "full",
            items: [{ id: "agent", type: "agentMessage", text: "Legacy full detail" }],
          }],
          nextCursor: null,
          backwardsCursor: null,
        };
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    fireEvent.click(await screen.findByRole("button", { name: "Load full detail" }));

    expect(await screen.findByText("Legacy full detail")).toBeInTheDocument();
    expect(socket.rpc).toHaveBeenCalledWith("thread/turns/list", expect.objectContaining({
      threadId: "thread-existing",
      limit: 1,
      itemsView: "full",
    }));
    expect(socket.rpc).not.toHaveBeenCalledWith("thread/items/list", expect.anything());
  });
});
