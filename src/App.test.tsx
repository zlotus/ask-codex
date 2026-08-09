import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { NotificationMessage, ServerRequestMessage } from "./types/protocol";
import { BrowserFileAttachmentStore } from "./utils/browserFileAttachmentStore";
import { BrowserImagePreviewStore } from "./utils/browserImagePreviewStore";
import { sessionFileAttachmentKey } from "./utils/sessionFileAttachments";
import { sessionImagePreviewKey } from "./utils/sessionImagePreviews";

const socket = vi.hoisted(() => ({
  connection: "connected",
  retryAttempt: 0,
  readySequence: 1,
  rpc: vi.fn(),
  respond: vi.fn(),
  reconnect: vi.fn(),
  onNotification: null as ((message: NotificationMessage) => void) | null,
  onRequest: null as ((message: ServerRequestMessage) => void) | null,
}));

vi.mock("./hooks/useCodexSocket", () => ({
  useCodexSocket: (options: {
    onNotification: (message: NotificationMessage) => void;
    onRequest: (message: ServerRequestMessage) => void;
  }) => {
    socket.onNotification = options.onNotification;
    socket.onRequest = options.onRequest;
    return {
      connection: socket.connection,
      connectionDetail: "Ready",
      retryAttempt: socket.retryAttempt,
      readySequence: socket.readySequence,
      rpc: socket.rpc,
      respond: socket.respond,
      reconnect: socket.reconnect,
    };
  },
}));

let objectUrlSequence = 0;
const createObjectURL = vi.fn((blob: Blob) => (
  `blob:${"name" in blob && typeof blob.name === "string" ? blob.name : blob.type}:${++objectUrlSequence}`
));
const revokeObjectURL = vi.fn();

const existingThread = {
  id: "thread-existing",
  name: "Existing thread",
  cwd: "/workspace/existing",
  model: "gpt-5",
  turns: [],
};

const archivedThread = {
  id: "thread-archived",
  name: "Archived thread",
  cwd: "/workspace/archived",
  model: "gpt-5",
  turns: [],
};

const newThread = {
  id: "thread-new",
  preview: "",
  createdAt: 1_800_000_000,
  updatedAt: 1_800_000_000,
  recencyAt: 1_800_000_000,
  status: { type: "idle" },
  cwd: "/workspace/draft",
  turns: [],
};

const queuedMessage = {
  id: "q".repeat(32),
  threadId: existingThread.id,
  text: "Continue this later",
  expectedLastTurnId: null,
  status: "queued",
  revision: 1,
  createdAt: 1_800_000_001_000,
  updatedAt: 1_800_000_001_000,
  expiresAt: 1_800_604_801_000,
};

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

function installRpcFixture() {
  socket.rpc.mockImplementation(async (method: string, params?: unknown) => {
    if (method === "thread/list") {
      return {
        data: (params as { archived?: boolean } | undefined)?.archived
          ? [archivedThread]
          : [existingThread],
        nextCursor: null,
      };
    }
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
    if (method === "skills/list") return { data: [] };
    if (method === "messageQueue/list") return { revision: 0, items: [] };
    if (method === "messageQueue/enqueue") return { item: queuedMessage };
    if (method === "messageQueue/send") {
      return {
        item: {
          ...queuedMessage,
          status: "confirmed",
          revision: 4,
          confirmedTurnId: "turn-queued",
        },
        turn: { id: "turn-queued", status: "inProgress", items: [] },
      };
    }
    if (method === "messageQueue/cancel") {
      return { item: { ...queuedMessage, status: "cancelled", revision: 2 } };
    }
    if (method === "thread/read") return { thread: existingThread };
    if (method === "thread/turns/list") {
      return { data: [], nextCursor: null, backwardsCursor: null };
    }
    if (method === "account/rateLimits/read") {
      return { rateLimits: null, rateLimitsByLimitId: null };
    }
    if (method === "account/usage/read") {
      return {
        summary: {
          lifetimeTokens: null,
          peakDailyTokens: null,
          longestRunningTurnSec: null,
          currentStreakDays: null,
          longestStreakDays: null,
        },
        dailyUsageBuckets: null,
      };
    }
    if (method === "thread/start") {
      const requestedCwd = (params as { cwd?: unknown } | undefined)?.cwd;
      return {
        thread: {
          ...newThread,
          ...(typeof requestedCwd === "string" ? { cwd: requestedCwd } : {}),
        },
      };
    }
    if (method === "thread/fork") {
      return {
        thread: {
          ...existingThread,
          id: "thread-fork",
          name: "Existing thread fork",
          forkedFromId: "thread-existing",
          historyMode: "legacy",
          turns: [],
        },
        model: existingThread.model,
        cwd: existingThread.cwd,
        sandbox: { type: "workspaceWrite" },
        reasoningEffort: "high",
      };
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
    if (method === "turn/steer") {
      return { turnId: (params as { expectedTurnId?: string } | undefined)?.expectedTurnId };
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

function delayOpen(indexedDB: IDBFactory, delayedDbName: string): {
  factory: IDBFactory;
  ready: Promise<void>;
  release: () => void;
} {
  let markReady!: () => void;
  let releaseOpen: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const factory = {
    open(name: string, version?: number) {
      const source = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
      if (name !== delayedDbName) return source;
      const proxy: Record<string, unknown> = {
        onblocked: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
      };
      Object.defineProperties(proxy, {
        error: { get: () => source.error },
        result: { get: () => source.result },
      });
      const callHandler = (name: string, event: Event) => {
        const handler = proxy[name];
        if (typeof handler === "function") handler.call(proxy, event);
      };
      source.onblocked = (event) => callHandler("onblocked", event);
      source.onerror = (event) => callHandler("onerror", event);
      source.onupgradeneeded = (event) => callHandler("onupgradeneeded", event);
      source.onsuccess = (event) => {
        releaseOpen = () => callHandler("onsuccess", event);
        markReady();
      };
      return proxy as unknown as IDBOpenDBRequest;
    },
  } as IDBFactory;
  return {
    factory,
    ready,
    release: () => {
      if (!releaseOpen) throw new Error("IndexedDB open is not ready to release");
      const release = releaseOpen;
      releaseOpen = undefined;
      release();
    },
  };
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
    socket.reconnect.mockReset();
    socket.onNotification = null;
    socket.onRequest = null;
    socket.connection = "connected";
    socket.retryAttempt = 0;
    socket.readySequence = 1;
    installRpcFixture();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts a new thread in the bootstrap working directory when no thread is selected", async () => {
    const fetchMock = installBootstrapFixture();
    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    expect(screen.getByLabelText("Working directory")).toHaveValue("/workspace/default-one");
    expect(screen.getByLabelText("Sandbox")).toHaveValue("workspace-write");
  });

  it("queues composer text for the selected thread and explicitly sends it", async () => {
    installBootstrapFixture();
    render(<App />);
    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByRole("region", { name: "Message queue" });
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("messageQueue/list", {
      threadId: existingThread.id,
    }));
    const queueToggle = screen.getByRole("button", { name: /Expand message queue/ });
    expect(queueToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(queueToggle);

    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "Continue this later" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("messageQueue/enqueue", {
      threadId: existingThread.id,
      text: "Continue this later",
      expectedLastTurnId: null,
    }));
    expect(await screen.findByText("Continue this later")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send queued message" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("messageQueue/send", {
      id: queuedMessage.id,
      revision: queuedMessage.revision,
    }));
    await waitFor(() => expect(screen.queryByText("Continue this later")).not.toBeInTheDocument());
  });

  it("uses auto approval for one direct turn, then restores manual approval", async () => {
    installBootstrapFixture();
    render(<App />);

    const autoToggle = screen.getByLabelText("Auto-run next turn without approval prompts");
    expect(autoToggle).toBeDisabled();
    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    expect(autoToggle).toBeEnabled();
    fireEvent.click(autoToggle);
    expect(autoToggle).toBeChecked();

    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "queue without consuming auto mode" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("messageQueue/enqueue", {
      threadId: existingThread.id,
      text: "queue without consuming auto mode",
      expectedLastTurnId: null,
    }));
    expect(autoToggle).toBeChecked();

    await sendMessage();
    expect(socket.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId: existingThread.id,
      approvalPolicy: "never",
    }));
    expect(autoToggle).toBeChecked();
    expect(autoToggle).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "steer without consuming auto mode" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Steer active turn" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("turn/steer", {
      threadId: existingThread.id,
      expectedTurnId: "turn-new",
      input: [{
        type: "text",
        text: "steer without consuming auto mode",
        text_elements: [],
      }],
    }));
    expect(autoToggle).toBeChecked();

    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/completed",
      params: {
        threadId: existingThread.id,
        turn: { id: "turn-new", status: "completed", itemsView: "full", items: [] },
      },
    }));
    await waitFor(() => expect(autoToggle).not.toBeChecked());
    expect(autoToggle).toBeEnabled();

    await sendMessage();
    const turnStarts = socket.rpc.mock.calls.filter(([method]) => method === "turn/start");
    expect(turnStarts.at(-1)?.[1]).toEqual(expect.objectContaining({
      threadId: existingThread.id,
      approvalPolicy: "on-request",
    }));
  });

  it("uses auto approval for the first turn of a configured new thread", async () => {
    const fetchMock = installBootstrapFixture();
    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const autoToggle = screen.getByLabelText("Auto-run next turn without approval prompts");
    expect(autoToggle).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Create thread" }));
    expect(autoToggle).toBeEnabled();
    fireEvent.click(autoToggle);
    expect(autoToggle).toBeChecked();

    await sendMessage();

    expect(socket.rpc).toHaveBeenCalledWith("thread/start", expect.objectContaining({
      approvalPolicy: "on-request",
    }));
    expect(socket.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      threadId: newThread.id,
      approvalPolicy: "never",
    }));
    expect(autoToggle).toBeChecked();
    expect(autoToggle).toBeDisabled();

    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/completed",
      params: {
        threadId: newThread.id,
        turn: { id: "turn-new", status: "completed", itemsView: "full", items: [] },
      },
    }));
    await waitFor(() => expect(autoToggle).not.toBeChecked());
    expect(autoToggle).toBeEnabled();
  });

  it("restores manual approval when an armed new thread cannot be created", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => (
      method === "thread/start"
        ? Promise.reject(new Error("thread/start failed"))
        : baseRpc?.(method, params)
    ));
    const fetchMock = installBootstrapFixture();
    render(<App />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Create thread" }));
    const autoToggle = screen.getByLabelText("Auto-run next turn without approval prompts");
    fireEvent.click(autoToggle);
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "start automatically" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("thread/start failed");
    expect(autoToggle).not.toBeChecked();
    expect(autoToggle).toBeEnabled();
    expect(socket.rpc).not.toHaveBeenCalledWith("turn/start", expect.anything());
  });

  it("restores manual approval when an auto turn start fails", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => (
      method === "turn/start"
        ? Promise.reject(new Error("turn/start failed"))
        : baseRpc?.(method, params)
    ));
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    const autoToggle = screen.getByLabelText("Auto-run next turn without approval prompts");
    fireEvent.click(autoToggle);
    await sendMessage();

    expect(await screen.findByRole("alert")).toHaveTextContent("turn/start failed");
    expect(autoToggle).not.toBeChecked();
  });

  it("refreshes the selected thread queue after a cross-client notification", async () => {
    installBootstrapFixture();
    let visibleItems: unknown[] = [];
    const baseImplementation = socket.rpc.getMockImplementation()!;
    socket.rpc.mockImplementation(async (method: string, params?: unknown) => (
      method === "messageQueue/list"
        ? { revision: visibleItems.length, items: visibleItems }
        : await baseImplementation(method, params)
    ));
    render(<App />);
    fireEvent.click(await screen.findByText("Existing thread"));
    fireEvent.click(await screen.findByRole("button", { name: /Expand message queue/ }));
    await screen.findByText("No queued messages");
    visibleItems = [queuedMessage];

    act(() => socket.onNotification?.({
      type: "notification",
      method: "messageQueue/changed",
      params: { threadId: existingThread.id, revision: 1 },
    }));

    expect(await screen.findByText("Continue this later")).toBeInTheDocument();
  });

  it("inherits the selected thread working directory and returns to the default after archiving it", async () => {
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(screen.getByLabelText("Working directory")).toHaveValue("/workspace/existing");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "More actions for Existing thread" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("thread/archive", {
      threadId: existingThread.id,
    }));
    await waitFor(() => expect(
      screen.queryByRole("button", { name: "Existing thread" }),
    ).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    expect(screen.getByLabelText("Working directory")).toHaveValue("/workspace/default-one");
    expect(screen.getByLabelText("Sandbox")).toHaveValue("workspace-write");
  });

  it("uses the selected active summary cwd when loading that thread fails", async () => {
    const otherThread = {
      ...existingThread,
      id: "thread-other",
      name: "Other thread",
      cwd: "/workspace/other",
    };
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "thread/list" && !(params as { archived?: boolean } | undefined)?.archived) {
        return Promise.resolve({ data: [existingThread, otherThread], nextCursor: null });
      }
      if (
        method === "thread/resume" &&
        (params as { threadId?: string } | undefined)?.threadId === otherThread.id
      ) {
        return Promise.reject(new Error("Could not load other thread"));
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    fireEvent.click(screen.getByRole("button", { name: "Other thread" }));
    await screen.findByRole("button", { name: "Retry thread" });
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    expect(screen.getByLabelText("Working directory")).toHaveValue("/workspace/other");
  });

  it("uses the selected archived summary cwd when loading that thread fails", async () => {
    const movedThread = {
      ...existingThread,
      id: "thread-moved-to-archive",
      name: "Moved thread",
      cwd: "/workspace/moved",
    };
    let movedToArchive = false;
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "thread/list") {
        const archived = (params as { archived?: boolean } | undefined)?.archived;
        return Promise.resolve({
          data: archived
            ? (movedToArchive ? [movedThread] : [])
            : (movedToArchive ? [existingThread] : [existingThread, movedThread]),
          nextCursor: null,
        });
      }
      if (
        method === "thread/resume" &&
        (params as { threadId?: string } | undefined)?.threadId === movedThread.id
      ) {
        return Promise.reject(new Error("Could not load moved thread"));
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    fireEvent.click(await screen.findByRole("button", { name: "Moved thread" }));
    await screen.findByRole("button", { name: "Retry thread" });
    movedToArchive = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh threads" }));
    await waitFor(() => expect(
      screen.queryByRole("button", { name: "Moved thread" }),
    ).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    expect(screen.getByLabelText("Working directory")).toHaveValue("/workspace/moved");
  });

  it("uses an authoritative cwd update when starting from the selected thread", async () => {
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/settings/updated",
      params: {
        threadId: existingThread.id,
        threadSettings: { cwd: "/workspace/updated" },
      },
    }));
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    expect(screen.getByLabelText("Working directory")).toHaveValue("/workspace/updated");
    expect(screen.getByLabelText("Sandbox")).toHaveValue("workspace-write");
    fireEvent.click(screen.getByRole("button", { name: "Create thread" }));
    await sendMessage();

    expect(socket.rpc).toHaveBeenCalledWith("thread/start", expect.objectContaining({
      cwd: "/workspace/updated",
      sandbox: "workspace-write",
    }));
    expect(socket.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      cwd: "/workspace/updated",
    }));
  });

  it("steers the exact active turn without starting another turn", async () => {
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await sendMessage();
    await screen.findByRole("button", { name: "Stop turn" });
    const turnStarts = socket.rpc.mock.calls.filter(([method]) => method === "turn/start").length;

    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "  focus on the failing test  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Steer active turn" }));

    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("turn/steer", {
      threadId: existingThread.id,
      expectedTurnId: "turn-new",
      input: [{ type: "text", text: "focus on the failing test", text_elements: [] }],
    }));
    expect(socket.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(turnStarts);
  });

  it("keeps later typing when the steered turn completes before the response", async () => {
    let resolveSteer!: (value: unknown) => void;
    const pendingSteer = new Promise<unknown>((resolve) => {
      resolveSteer = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => (
      method === "turn/steer" ? pendingSteer : baseRpc?.(method, params)
    ));
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await sendMessage();
    await screen.findByRole("button", { name: "Stop turn" });
    const textarea = screen.getByLabelText("Message Codex");
    fireEvent.change(textarea, { target: { value: "steer snapshot" } });
    fireEvent.click(screen.getByRole("button", { name: "Steer active turn" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith(
      "turn/steer",
      expect.objectContaining({ expectedTurnId: "turn-new" }),
    ));
    fireEvent.change(textarea, { target: { value: "draft after steering" } });
    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/completed",
      params: {
        threadId: existingThread.id,
        turn: { id: "turn-new", status: "completed", itemsView: "full", items: [] },
      },
    }));

    await act(async () => {
      resolveSteer({ turnId: "turn-new" });
      await pendingSteer;
    });

    expect(textarea).toHaveValue("draft after steering");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("retries failed steering only against its captured active turn", async () => {
    let steerAttempts = 0;
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "turn/steer") {
        steerAttempts += 1;
        if (steerAttempts === 1) return Promise.reject(new Error("Connection closed"));
        return Promise.resolve({ turnId: "turn-new" });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await sendMessage();
    const turnStarts = socket.rpc.mock.calls.filter(([method]) => method === "turn/start").length;
    fireEvent.change(screen.getByLabelText("Message Codex"), { target: { value: "retry guidance" } });
    fireEvent.click(await screen.findByRole("button", { name: "Steer active turn" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Guidance not confirmed");
    fireEvent.click(screen.getByRole("button", { name: "Retry unconfirmed guidance" }));
    await waitFor(() => expect(socket.rpc.mock.calls.filter(([method]) => (
      method === "turn/steer"
    ))).toHaveLength(2));
    for (const [, params] of socket.rpc.mock.calls.filter(([method]) => method === "turn/steer")) {
      expect(params).toEqual({
        threadId: existingThread.id,
        expectedTurnId: "turn-new",
        input: [{ type: "text", text: "retry guidance", text_elements: [] }],
      });
    }
    expect(socket.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(turnStarts);
  });

  it("keeps failed guidance and disables retry after its turn completes", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => (
      method === "turn/steer"
        ? Promise.reject(new Error("Connection closed"))
        : baseRpc?.(method, params)
    ));
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await sendMessage();
    const textarea = screen.getByLabelText("Message Codex");
    fireEvent.change(textarea, { target: { value: "original guidance" } });
    fireEvent.click(await screen.findByRole("button", { name: "Steer active turn" }));
    await screen.findByText("Guidance not confirmed");
    fireEvent.change(textarea, { target: { value: "later draft" } });

    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/completed",
      params: {
        threadId: existingThread.id,
        turn: { id: "turn-new", status: "completed", itemsView: "full", items: [] },
      },
    }));

    const recovery = screen.getByRole("alert");
    expect(recovery).toHaveTextContent("original guidance");
    expect(recovery).toHaveTextContent("The original turn is no longer active");
    expect(screen.getByRole("button", { name: "Retry unconfirmed guidance" })).toBeDisabled();
    expect(textarea).toHaveValue("later draft");
    expect(socket.rpc.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1);
  });

  it("keeps steering disabled while the connection is unavailable", async () => {
    installBootstrapFixture();
    const view = render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await sendMessage();
    socket.connection = "disconnected";
    socket.retryAttempt = 1;
    view.rerender(<App />);

    const textarea = screen.getByLabelText("Message Codex");
    fireEvent.change(textarea, { target: { value: "keep this guidance" } });
    expect(screen.getByRole("button", { name: "Steer active turn" })).toBeDisabled();
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(socket.rpc.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(0);
    expect(textarea).toHaveValue("keep this guidance");
  });

  it("does not let a late resume result overwrite a cwd update", async () => {
    let resolveResume: ((value: unknown) => void) | undefined;
    const pendingResume = new Promise<unknown>((resolve) => {
      resolveResume = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => (
      method === "thread/resume" &&
      (params as { threadId?: string } | undefined)?.threadId === existingThread.id
        ? pendingResume
        : baseRpc?.(method, params)
    ));
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith(
      "thread/resume",
      expect.objectContaining({ threadId: existingThread.id }),
    ));
    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/settings/updated",
      params: {
        threadId: existingThread.id,
        threadSettings: { cwd: "/workspace/updated-during-resume" },
      },
    }));
    await act(async () => {
      resolveResume?.({
        thread: existingThread,
        cwd: existingThread.cwd,
        model: existingThread.model,
        sandbox: { type: "workspaceWrite" },
        initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
      });
      await pendingResume;
    });
    await screen.findByTitle("Existing thread");

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(screen.getByLabelText("Working directory"))
      .toHaveValue("/workspace/updated-during-resume");
  });

  it("does not let a late thread list overwrite a cwd update", async () => {
    let deferActiveList = false;
    let resolveActiveList: ((value: unknown) => void) | undefined;
    let markActiveListRequested: (() => void) | undefined;
    const pendingActiveList = new Promise<unknown>((resolve) => {
      resolveActiveList = resolve;
    });
    const activeListRequested = new Promise<void>((resolve) => {
      markActiveListRequested = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (
        deferActiveList &&
        method === "thread/list" &&
        !(params as { archived?: boolean } | undefined)?.archived
      ) {
        deferActiveList = false;
        markActiveListRequested?.();
        return pendingActiveList;
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh threads" })).toBeEnabled());
    deferActiveList = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh threads" }));
    await activeListRequested;
    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/settings/updated",
      params: {
        threadId: existingThread.id,
        threadSettings: { cwd: "/workspace/updated-during-list" },
      },
    }));
    await act(async () => {
      resolveActiveList?.({ data: [existingThread], nextCursor: null });
      await pendingActiveList;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh threads" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(screen.getByLabelText("Working directory"))
      .toHaveValue("/workspace/updated-during-list");
  });

  it("synchronizes a newer thread list cwd before the next send", async () => {
    const listedCwd = "/workspace/from-newer-list";
    let useUpdatedList = false;
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      const request = params as { archived?: boolean; initialTurnsPage?: unknown } | undefined;
      if (useUpdatedList && method === "thread/list" && !request?.archived) {
        return Promise.resolve({
          data: [{ ...existingThread, cwd: listedCwd }],
          nextCursor: null,
        });
      }
      if (useUpdatedList && method === "thread/resume" && !request?.initialTurnsPage) {
        return Promise.resolve({
          thread: { ...existingThread, cwd: listedCwd },
          cwd: listedCwd,
        });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh threads" })).toBeEnabled());
    const activeListCallsBefore = socket.rpc.mock.calls.filter(([method, params]) => (
      method === "thread/list" && !(params as { archived?: boolean } | undefined)?.archived
    )).length;

    useUpdatedList = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh threads" }));
    await waitFor(() => expect(socket.rpc.mock.calls.filter(([method, params]) => (
      method === "thread/list" && !(params as { archived?: boolean } | undefined)?.archived
    )).length).toBeGreaterThan(activeListCallsBefore));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh threads" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(screen.getByLabelText("Working directory")).toHaveValue(listedCwd);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "send from the listed cwd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: existingThread.id, cwd: listedCwd }),
    ));
    expect(screen.queryByText(/Working directory changed while preparing/))
      .not.toBeInTheDocument();
  });

  it("does not start a turn when cwd changes while a message is being prepared", async () => {
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    const turnStartsBeforeSend = socket.rpc.mock.calls.filter(([method]) => (
      method === "turn/start"
    )).length;
    let resolveResume: ((value: unknown) => void) | undefined;
    let markResumeRequested: (() => void) | undefined;
    const pendingResume = new Promise<unknown>((resolve) => {
      resolveResume = resolve;
    });
    const resumeRequested = new Promise<void>((resolve) => {
      markResumeRequested = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    let deferResume = true;
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (
        deferResume &&
        method === "thread/resume" &&
        (params as { threadId?: string } | undefined)?.threadId === existingThread.id
      ) {
        deferResume = false;
        markResumeRequested?.();
        return pendingResume;
      }
      return baseRpc?.(method, params);
    });

    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "keep this draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await resumeRequested;
    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/settings/updated",
      params: {
        threadId: existingThread.id,
        threadSettings: { cwd: "/workspace/changed-before-turn" },
      },
    }));
    await act(async () => {
      resolveResume?.({
        thread: existingThread,
        cwd: existingThread.cwd,
        sandbox: { type: "workspaceWrite" },
      });
      await pendingResume;
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Working directory changed while preparing the message; nothing was sent",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("keep this draft");
    expect(socket.rpc.mock.calls.filter(([method]) => method === "turn/start"))
      .toHaveLength(turnStartsBeforeSend);
  });

  it("adopts a cwd returned by resume before retrying an unconfirmed message", async () => {
    const resumedCwd = "/workspace/from-send-resume";
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      const request = params as { initialTurnsPage?: unknown; threadId?: string } | undefined;
      if (
        method === "thread/resume" &&
        request?.threadId === existingThread.id &&
        !request.initialTurnsPage
      ) {
        return Promise.resolve({
          thread: { ...existingThread, cwd: resumedCwd },
          cwd: resumedCwd,
        });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    const turnStartsBeforeSend = socket.rpc.mock.calls.filter(([method]) => (
      method === "turn/start"
    )).length;
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "retry after cwd refresh" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const failedSubmission = await screen.findByRole("alert");
    expect(failedSubmission).toHaveTextContent(
      "Working directory changed while preparing the message; nothing was sent",
    );
    expect(failedSubmission).toHaveTextContent("retry after cwd refresh");
    expect(socket.rpc.mock.calls.filter(([method]) => method === "turn/start"))
      .toHaveLength(turnStartsBeforeSend);

    fireEvent.click(screen.getByRole("button", { name: "Retry unconfirmed message" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: existingThread.id, cwd: resumedCwd }),
    ));
    await waitFor(() => expect(screen.queryByText("Message not confirmed")).not.toBeInTheDocument());
  });

  it("keeps a same-cwd notification authoritative over an older resume result", async () => {
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    let resolveResume: ((value: unknown) => void) | undefined;
    let markResumeRequested: (() => void) | undefined;
    const pendingResume = new Promise<unknown>((resolve) => {
      resolveResume = resolve;
    });
    const resumeRequested = new Promise<void>((resolve) => {
      markResumeRequested = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    let deferResume = true;
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (
        deferResume &&
        method === "thread/resume" &&
        (params as { threadId?: string } | undefined)?.threadId === existingThread.id
      ) {
        deferResume = false;
        markResumeRequested?.();
        return pendingResume;
      }
      return baseRpc?.(method, params);
    });

    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "continue in this directory" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await resumeRequested;
    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/settings/updated",
      params: {
        threadId: existingThread.id,
        threadSettings: { cwd: existingThread.cwd },
      },
    }));
    await act(async () => {
      resolveResume?.({
        thread: { ...existingThread, cwd: "/workspace/stale-resume" },
        cwd: "/workspace/stale-resume",
        sandbox: { type: "workspaceWrite" },
      });
      await pendingResume;
    });

    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({
        threadId: existingThread.id,
        cwd: existingThread.cwd,
      }),
    ));
    expect(screen.queryByText(/Working directory changed while preparing/))
      .not.toBeInTheDocument();
  });

  it("does not start the first turn when a new thread cwd changes during creation", async () => {
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Create thread" }));
    let resolveThreadStart: ((value: unknown) => void) | undefined;
    let markThreadStartRequested: (() => void) | undefined;
    const pendingThreadStart = new Promise<unknown>((resolve) => {
      resolveThreadStart = resolve;
    });
    const threadStartRequested = new Promise<void>((resolve) => {
      markThreadStartRequested = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    let deferThreadStart = true;
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (deferThreadStart && method === "thread/start") {
        deferThreadStart = false;
        markThreadStartRequested?.();
        return pendingThreadStart;
      }
      return baseRpc?.(method, params);
    });

    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "first message" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await threadStartRequested;
    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/settings/updated",
      params: {
        threadId: newThread.id,
        threadSettings: { cwd: "/workspace/changed-during-create" },
      },
    }));
    await act(async () => {
      resolveThreadStart?.({
        thread: { ...newThread, cwd: "/workspace/default-one" },
      });
      await pendingThreadStart;
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Working directory changed while preparing the message; nothing was sent",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("first message");
    expect(socket.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(screen.getByLabelText("Working directory"))
      .toHaveValue("/workspace/changed-during-create");
  });

  it("does not start a first turn from a result older than thread started cwd", async () => {
    const startedCwd = "/workspace/from-thread-started";
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Create thread" }));
    let resolveThreadStart: ((value: unknown) => void) | undefined;
    let markThreadStartRequested: (() => void) | undefined;
    const pendingThreadStart = new Promise<unknown>((resolve) => {
      resolveThreadStart = resolve;
    });
    const threadStartRequested = new Promise<void>((resolve) => {
      markThreadStartRequested = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    let deferThreadStart = true;
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (deferThreadStart && method === "thread/start") {
        deferThreadStart = false;
        markThreadStartRequested?.();
        return pendingThreadStart;
      }
      return baseRpc?.(method, params);
    });

    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "first message after thread started" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await threadStartRequested;
    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/started",
      params: { thread: { ...newThread, cwd: startedCwd } },
    }));
    await act(async () => {
      resolveThreadStart?.({
        thread: { ...newThread, cwd: "/workspace/default-one" },
      });
      await pendingThreadStart;
    });

    const failedSubmission = await screen.findByRole("alert");
    expect(failedSubmission).toHaveTextContent(
      "Working directory changed while preparing the message; nothing was sent",
    );
    expect(failedSubmission).toHaveTextContent("first message after thread started");
    expect(socket.rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(screen.getByLabelText("Working directory")).toHaveValue(startedCwd);
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

  it("loads active and archived views and sends strict lifecycle RPCs", async () => {
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    await waitFor(() => {
      expect(socket.rpc).toHaveBeenCalledWith("thread/list", expect.objectContaining({
        archived: false,
        sortKey: "recency_at",
        sortDirection: "desc",
      }));
      expect(socket.rpc).toHaveBeenCalledWith("thread/list", expect.objectContaining({
        archived: true,
        sortKey: "recency_at",
        sortDirection: "desc",
      }));
    });

    fireEvent.click(screen.getByRole("button", { name: "More actions for Existing thread" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("thread/archive", {
      threadId: "thread-existing",
    }));

    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(screen.getByRole("button", { name: "Existing thread" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Existing thread" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("thread/unarchive", {
      threadId: "thread-existing",
    }));

    fireEvent.click(screen.getByRole("button", { name: "More actions for Archived thread" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(socket.rpc).not.toHaveBeenCalledWith("thread/delete", expect.anything());
    expect(screen.getByRole("dialog", { name: "Delete thread permanently?" }))
      .toHaveTextContent(/descendant sessions/i);
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("thread/delete", {
      threadId: "thread-archived",
    }));
    expect(screen.queryByRole("button", { name: "Archived thread" })).not.toBeInTheDocument();
  });

  it("forks an idle thread, loads its bounded history, and selects it", async () => {
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    fireEvent.click(screen.getByRole("button", { name: "More actions for Existing thread" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fork" }));

    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("thread/fork", {
      threadId: "thread-existing",
    }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("thread/turns/list", {
      threadId: "thread-fork",
      limit: 10,
      sortDirection: "desc",
      itemsView: "full",
    }));
    expect(await screen.findByTitle("Existing thread fork")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Existing thread fork" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("surfaces bounded thread activity and normalized usage notifications", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "account/rateLimits/read") {
        return Promise.resolve({
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
            secondary: null,
            credits: null,
            planType: "plus",
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
        });
      }
      if (method === "account/usage/read") {
        return Promise.resolve({
          summary: {
            lifetimeTokens: 25_000,
            peakDailyTokens: 8_000,
            longestRunningTurnSec: 90,
            currentStreakDays: 3,
            longestStreakDays: 7,
          },
          dailyUsageBuckets: [{ startDate: "2026-08-02", tokens: 1_200 }],
        });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/tokenUsage/updated",
      params: {
        threadId: existingThread.id,
        tokenUsage: {
          total: {
            totalTokens: 2_200,
            inputTokens: 1_500,
            cachedInputTokens: 500,
            cacheWriteInputTokens: 0,
            outputTokens: 700,
            reasoningOutputTokens: 200,
          },
          last: {
            totalTokens: 1_000,
            inputTokens: 700,
            cachedInputTokens: 300,
            cacheWriteInputTokens: 0,
            outputTokens: 300,
            reasoningOutputTokens: 100,
          },
          modelContextWindow: 4_000,
        },
      },
    }));

    fireEvent.click(screen.getByRole("button", { name: "Usage and limits" }));
    expect(await screen.findByRole("dialog", { name: "Usage and limits" })).toBeInTheDocument();
    await waitFor(() => {
      expect(socket.rpc).toHaveBeenCalledWith("account/rateLimits/read", {});
      expect(socket.rpc).toHaveBeenCalledWith("account/usage/read", {});
    });
    expect(screen.getByRole("progressbar", { name: "Latest context window used" }))
      .toHaveAttribute("value", "25");
    expect(screen.getByText("Thread total").parentElement).toHaveTextContent("2.2K");
    expect(await screen.findByText("25% used")).toBeInTheDocument();

    act(() => socket.onNotification?.({
      type: "notification",
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 75 },
        },
      },
    }));
    expect(await screen.findByText("75% used")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/completed",
      params: {
        threadId: existingThread.id,
        turn: {
          id: "turn-activity",
          status: "completed",
          itemsView: "notLoaded",
          items: [],
          completedAt: 1_800_000_010,
          durationMs: 2_500,
        },
      },
    }));
    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/status/changed",
      params: { threadId: existingThread.id, status: { type: "idle" } },
    }));
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByRole("button", { name: /Existing thread.*Completed.*2.5s/ }))
      .toBeInTheDocument();
  });

  it("treats unsupported account usage APIs as an in-panel unavailable state", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "account/rateLimits/read" || method === "account/usage/read") {
        return Promise.reject(new Error("not supported for API key authentication"));
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    fireEvent.click(screen.getByRole("button", { name: "Usage and limits" }));
    expect(await screen.findByText(
      "Account activity and rate limits are unavailable for this sign-in.",
    )).toBeInTheDocument();
    expect(document.querySelector(".toast")).not.toBeInTheDocument();
  });

  it("uses a read-only snapshot to resync the selected thread after reconnecting", async () => {
    let resolveThreadRead: ((value: unknown) => void) | undefined;
    const pendingThreadRead = new Promise<unknown>((resolve) => {
      resolveThreadRead = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => (
      method === "thread/read" ? pendingThreadRead : baseRpc?.(method, params)
    ));
    installBootstrapFixture();
    const { rerender } = render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    expect(socket.rpc).not.toHaveBeenCalledWith("thread/read", expect.anything());
    expect(screen.getByLabelText("Model for next turn")).toBeEnabled();
    const resumeCallsBeforeReconnect = socket.rpc.mock.calls
      .filter(([method]) => method === "thread/resume").length;

    socket.connection = "disconnected";
    socket.retryAttempt = 1;
    rerender(<App />);
    await waitFor(() => expect(screen.getByLabelText("Model for next turn")).toBeDisabled());

    socket.connection = "connected";
    socket.retryAttempt = 0;
    socket.readySequence = 2;
    rerender(<App />);
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("thread/read", {
      threadId: existingThread.id,
      includeTurns: false,
    }));
    expect(screen.getByLabelText("Model for next turn")).toBeDisabled();
    expect(socket.rpc.mock.calls.filter(([method]) => method === "thread/resume"))
      .toHaveLength(resumeCallsBeforeReconnect);

    await act(async () => {
      resolveThreadRead?.({ thread: existingThread });
      await pendingThreadRead;
    });
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("thread/turns/list", {
      threadId: existingThread.id,
      limit: 10,
      sortDirection: "desc",
      itemsView: "full",
    }));
    await waitFor(() => expect(screen.getByLabelText("Model for next turn")).toBeEnabled());
    expect(socket.rpc.mock.calls.filter(([method]) => method === "thread/read")).toHaveLength(1);
  });

  it("restores a missed plan update from the read-only reconnect snapshot", async () => {
    let recovering = false;
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (recovering && method === "thread/read") {
        return Promise.resolve({ thread: existingThread });
      }
      if (recovering && method === "thread/turns/list") {
        return Promise.resolve({
          data: [{
            id: "turn-new",
            status: "inProgress",
            itemsView: "full",
            items: [],
            plan: {
              explanation: "Recovered after reconnecting.",
              plan: [
                { step: "Inspect", status: "completed" },
                { step: "Repair", status: "completed" },
                { step: "Verify", status: "inProgress" },
              ],
              emittedAtMs: 1_800_000_000_200,
              gatewayReceivedAtMs: 1_800_000_000_210,
            },
          }],
          nextCursor: null,
          backwardsCursor: null,
        });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    const { rerender } = render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await sendMessage();
    await screen.findByRole("button", { name: "Stop turn" });
    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/plan/updated",
      params: {
        threadId: existingThread.id,
        turnId: "turn-new",
        explanation: "Initial live plan.",
        plan: [
          { step: "Inspect", status: "inProgress" },
          { step: "Repair", status: "pending" },
          { step: "Verify", status: "pending" },
        ],
      },
      emittedAtMs: 1_800_000_000_100,
      gatewayReceivedAtMs: 1_800_000_000_110,
    }));
    expect(screen.getByRole("button", {
      name: /Step 1 of 3: Inspect/,
    })).toBeInTheDocument();
    const resumeCallsBeforeReconnect = socket.rpc.mock.calls
      .filter(([method]) => method === "thread/resume").length;

    socket.connection = "disconnected";
    socket.retryAttempt = 1;
    rerender(<App />);
    await waitFor(() => expect(screen.getByLabelText("Model for next turn")).toBeDisabled());

    recovering = true;
    socket.connection = "connected";
    socket.retryAttempt = 0;
    socket.readySequence = 2;
    rerender(<App />);

    expect(await screen.findByRole("button", {
      name: /Step 3 of 3: Verify/,
    })).toBeInTheDocument();
    expect(socket.rpc.mock.calls.filter(([method]) => method === "thread/resume"))
      .toHaveLength(resumeCallsBeforeReconnect);
  });

  it("replays a newer buffered plan after an older reconnect snapshot", async () => {
    let recovering = false;
    let resolveTurnsPage: ((value: unknown) => void) | undefined;
    const pendingTurnsPage = new Promise<unknown>((resolve) => {
      resolveTurnsPage = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (recovering && method === "thread/read") {
        return Promise.resolve({ thread: existingThread });
      }
      if (recovering && method === "thread/turns/list") return pendingTurnsPage;
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    const { rerender } = render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await sendMessage();
    await screen.findByRole("button", { name: "Stop turn" });
    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/plan/updated",
      params: {
        threadId: existingThread.id,
        turnId: "turn-new",
        askCodexPlanRevision: 1,
        plan: [
          { step: "Inspect", status: "inProgress" },
          { step: "Repair", status: "pending" },
          { step: "Verify", status: "pending" },
        ],
      },
    }));
    expect(screen.getByRole("button", { name: /Step 1 of 3: Inspect/ }))
      .toBeInTheDocument();

    socket.connection = "disconnected";
    socket.retryAttempt = 1;
    rerender(<App />);
    await waitFor(() => expect(screen.getByLabelText("Model for next turn")).toBeDisabled());

    recovering = true;
    socket.connection = "connected";
    socket.retryAttempt = 0;
    socket.readySequence = 2;
    rerender(<App />);
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("thread/turns/list", {
      threadId: existingThread.id,
      limit: 10,
      sortDirection: "desc",
      itemsView: "full",
    }));

    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/plan/updated",
      params: {
        threadId: existingThread.id,
        turnId: "turn-new",
        askCodexPlanRevision: 3,
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Repair", status: "completed" },
          { step: "Verify", status: "inProgress" },
        ],
      },
    }));

    await act(async () => {
      resolveTurnsPage?.({
        data: [{
          id: "turn-new",
          status: "inProgress",
          itemsView: "full",
          items: [],
          askCodexPlanRevision: 2,
          plan: {
            plan: [
              { step: "Inspect", status: "completed" },
              { step: "Repair", status: "inProgress" },
              { step: "Verify", status: "pending" },
            ],
          },
        }],
        nextCursor: null,
        backwardsCursor: null,
      });
      await pendingTurnsPage;
    });

    expect(await screen.findByRole("button", { name: /Step 3 of 3: Verify/ }))
      .toBeInTheDocument();
  });

  it("does not let an older thread list overwrite a newer reconnect snapshot cwd", async () => {
    const snapshotCwd = "/workspace/from-reconnect-read";
    let deferActiveList = false;
    let useSnapshotCwd = false;
    let resolveActiveList: ((value: unknown) => void) | undefined;
    let markActiveListRequested: (() => void) | undefined;
    const pendingActiveList = new Promise<unknown>((resolve) => {
      resolveActiveList = resolve;
    });
    const activeListRequested = new Promise<void>((resolve) => {
      markActiveListRequested = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      const request = params as {
        archived?: boolean;
        initialTurnsPage?: unknown;
        threadId?: string;
      } | undefined;
      if (deferActiveList && method === "thread/list" && !request?.archived) {
        deferActiveList = false;
        markActiveListRequested?.();
        return pendingActiveList;
      }
      if (useSnapshotCwd && method === "thread/list" && !request?.archived) {
        return Promise.resolve({
          data: [{ ...existingThread, cwd: snapshotCwd }],
          nextCursor: null,
        });
      }
      if (useSnapshotCwd && method === "thread/read") {
        return Promise.resolve({ thread: { ...existingThread, cwd: snapshotCwd } });
      }
      if (
        useSnapshotCwd &&
        method === "thread/resume" &&
        request?.threadId === existingThread.id &&
        !request.initialTurnsPage
      ) {
        return Promise.resolve({
          thread: { ...existingThread, cwd: snapshotCwd },
          cwd: snapshotCwd,
        });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    const { rerender } = render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh threads" })).toBeEnabled());
    socket.connection = "disconnected";
    socket.retryAttempt = 1;
    rerender(<App />);
    await waitFor(() => expect(screen.getByLabelText("Model for next turn")).toBeDisabled());

    useSnapshotCwd = true;
    deferActiveList = true;
    socket.connection = "connected";
    socket.retryAttempt = 0;
    socket.readySequence = 2;
    rerender(<App />);
    await activeListRequested;
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("thread/read", {
      threadId: existingThread.id,
      includeTurns: false,
    }));
    await waitFor(() => expect(screen.getByLabelText("Model for next turn")).toBeEnabled());

    await act(async () => {
      resolveActiveList?.({ data: [existingThread], nextCursor: null });
      await pendingActiveList;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh threads" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(screen.getByLabelText("Working directory")).toHaveValue(snapshotCwd);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "send after reconnect" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: existingThread.id, cwd: snapshotCwd }),
    ));
  });

  it("blocks writes after a failed resync until a read-only retry succeeds", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    let failNextRead = true;
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "thread/read" && failNextRead) {
        failNextRead = false;
        return Promise.reject(new Error("snapshot unavailable"));
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    const { rerender } = render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");

    socket.connection = "disconnected";
    socket.retryAttempt = 1;
    rerender(<App />);
    socket.connection = "connected";
    socket.retryAttempt = 0;
    socket.readySequence = 2;
    rerender(<App />);

    const retry = await screen.findByRole("button", { name: /Retry live state sync/ });
    expect(screen.getByLabelText("Model for next turn")).toBeDisabled();
    fireEvent.click(retry);

    await waitFor(() => expect(socket.rpc.mock.calls.filter(([method]) => method === "thread/read"))
      .toHaveLength(2));
    await waitFor(() => expect(screen.getByLabelText("Model for next turn")).toBeEnabled());
    expect(screen.queryByRole("button", { name: /Retry live state sync/ })).not.toBeInTheDocument();
  });

  it("requires an explicit thread retry when disconnect interrupts the initial load", async () => {
    let rejectResume: ((reason?: unknown) => void) | undefined;
    const pendingResume = new Promise<unknown>((_resolve, reject) => {
      rejectResume = reject;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    let resumeReady = false;
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "thread/resume" && !resumeReady) return pendingResume;
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    const { rerender } = render(<App />);

    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByText("Loading thread");
    socket.connection = "disconnected";
    socket.retryAttempt = 1;
    rerender(<App />);
    await act(async () => rejectResume?.(new Error("Connection closed before Codex replied")));
    await screen.findByRole("button", { name: "Retry thread" });

    socket.connection = "connected";
    socket.retryAttempt = 0;
    socket.readySequence = 2;
    rerender(<App />);
    expect(await screen.findByText(/Connection restored\. Retry the thread/)).toBeInTheDocument();
    expect(socket.rpc.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(1);
    expect(screen.getByLabelText("Model for next turn")).toBeDisabled();

    resumeReady = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry thread" }));
    await screen.findByTitle("Existing thread");
    expect(socket.rpc.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(2);
  });

  it("clears stale approval requests when the transport disconnects", async () => {
    installBootstrapFixture();
    const { rerender } = render(<App />);
    await screen.findByRole("button", { name: "Existing thread" });

    act(() => socket.onRequest?.({
      type: "request",
      id: "stale-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: existingThread.id,
        turnId: "turn-stale",
        itemId: "command-stale",
        command: "npm test",
        cwd: existingThread.cwd,
        availableDecisions: ["accept", "decline"],
      },
    }));
    expect(document.querySelector(".approval-panel")).toBeInTheDocument();

    socket.connection = "disconnected";
    socket.retryAttempt = 1;
    rerender(<App />);
    await waitFor(() => expect(document.querySelector(".approval-panel")).not.toBeInTheDocument());
  });

  it("merges rate-limit notifications that arrive while a usage read is pending", async () => {
    let resolveRateLimits: ((value: unknown) => void) | undefined;
    const pendingRateLimits = new Promise<unknown>((resolve) => {
      resolveRateLimits = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => (
      method === "account/rateLimits/read" ? pendingRateLimits : baseRpc?.(method, params)
    ));
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    fireEvent.click(screen.getByRole("button", { name: "Usage and limits" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("account/rateLimits/read", {}));
    act(() => socket.onNotification?.({
      type: "notification",
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 75, windowDurationMins: 300, resetsAt: null },
        },
      },
    }));
    expect(await screen.findByText("75% used")).toBeInTheDocument();

    await act(async () => {
      resolveRateLimits?.({
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: null },
          secondary: null,
          credits: null,
          spendControlReached: false,
          planType: "plus",
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: null,
      });
      await pendingRateLimits;
    });
    expect(await screen.findByText("75% used")).toBeInTheDocument();
    expect(screen.queryByText("25% used")).not.toBeInTheDocument();
  });

  it("uses a read-only probe to restart Codex after an app-server error", async () => {
    socket.connection = "error";
    installBootstrapFixture();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Retry connection now/ }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("model/list", { limit: 1 }));
    expect(socket.reconnect).not.toHaveBeenCalled();
  });

  it("renames and pins a thread through the bounded metadata RPCs", async () => {
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    fireEvent.click(screen.getByRole("button", { name: "More actions for Existing thread" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Thread name" }), {
      target: { value: "  Project navigation  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("thread/name/set", {
      threadId: "thread-existing",
      name: "Project navigation",
    }));
    await screen.findByRole("button", { name: "Project navigation" });

    fireEvent.click(screen.getByRole("button", { name: "More actions for Project navigation" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("thread/metadata/update", {
      threadId: "thread-existing",
      isPinned: true,
    }));

    fireEvent.click(screen.getByRole("button", { name: "More actions for Project navigation" }));
    expect(screen.getByRole("menuitem", { name: "Unpin" })).toBeInTheDocument();
  });

  it("loads the read-only Skills directory on demand and refreshes invalidated data", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "skills/list") {
        return Promise.resolve({
          data: [{
            cwd: "/workspace/existing",
            skills: [{
              name: "repo-review",
              description: "Review repository changes",
              shortDescription: "Review changes",
              scope: "repo",
              enabled: true,
              path: "/private/repo-review/SKILL.md",
            }],
            errorCount: 1,
          }],
        });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    expect(socket.rpc).not.toHaveBeenCalledWith("skills/list", expect.anything());
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));

    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("skills/list", {
      cwds: expect.arrayContaining([
        "/workspace/existing",
        "/workspace/archived",
      ]),
    }));
    expect(await screen.findByText("repo-review")).toBeInTheDocument();
    expect(screen.getByText("Review changes")).toBeInTheDocument();
    expect(screen.getByText("repo")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("/private/repo-review/SKILL.md");

    fireEvent.click(screen.getByRole("button", { name: "Refresh skills" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("skills/list", {
      cwds: expect.any(Array),
      forceReload: true,
    }));

    const callsBeforeInvalidation = socket.rpc.mock.calls.filter(([method]) => method === "skills/list").length;
    act(() => socket.onNotification?.({
      type: "notification",
      method: "skills/changed",
      params: {},
    }));
    await waitFor(() => expect(
      socket.rpc.mock.calls.filter(([method]) => method === "skills/list").length,
    ).toBe(callsBeforeInvalidation + 1));

    const callsAfterInvalidation = socket.rpc.mock.calls
      .filter(([method]) => method === "skills/list").length;
    fireEvent.click(screen.getByRole("tab", { name: "Active" }));
    fireEvent.click(screen.getByRole("button", { name: "Existing thread" }));
    await screen.findByTitle("Existing thread");
    await waitFor(() => expect(
      socket.rpc.mock.calls.filter(([method]) => method === "skills/list").length,
    ).toBe(callsAfterInvalidation + 1));
    const latestSkillsCall = socket.rpc.mock.calls.filter(([method]) => method === "skills/list").at(-1);
    expect(latestSkillsCall?.[1]).not.toHaveProperty("forceReload");

    const callsBeforeReentry = socket.rpc.mock.calls.filter(([method]) => method === "skills/list").length;
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(socket.rpc.mock.calls.filter(([method]) => method === "skills/list")).toHaveLength(
      callsBeforeReentry,
    );
  });

  it("keeps valid Skills visible when an archived project directory no longer exists", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method !== "skills/list") return baseRpc?.(method, params);
      const cwds = (params as { cwds: string[] }).cwds;
      const archivedIndex = cwds.indexOf("/workspace/archived");
      if (archivedIndex >= 0) {
        return Promise.reject(new Error(`skills/list cwds[${archivedIndex}] does not exist`));
      }
      return Promise.resolve({
        data: cwds.map((cwd) => ({
          cwd,
          skills: cwd === "/workspace/existing"
            ? [{
                name: "repo-review",
                description: "Review repository changes",
                scope: "repo",
                enabled: true,
              }]
            : [],
          errorCount: 0,
        })),
      });
    });
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));

    expect(await screen.findByText("repo-review")).toBeInTheDocument();
    expect(screen.getByText("/workspace/archived")).toBeInTheDocument();
    expect(screen.getByText("1 skill could not be loaded")).toBeInTheDocument();
    expect(screen.queryByText(/Could not load Skills/)).not.toBeInTheDocument();

    const calls = socket.rpc.mock.calls.filter(([method]) => method === "skills/list");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toEqual({
      cwds: expect.arrayContaining(["/workspace/existing", "/workspace/archived"]),
    });
    expect(calls[1]?.[1]).toEqual({
      cwds: expect.not.arrayContaining(["/workspace/archived"]),
    });
  });

  it("does not fall back to the session cwd when every project directory is unavailable", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method !== "skills/list") return baseRpc?.(method, params);
      return Promise.reject(new Error("skills/list cwds[0] does not exist"));
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ready: true,
      defaultCwd: existingThread.cwd,
      authRequired: false,
    }), { status: 200 })));
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));

    await waitFor(() => expect(screen.getAllByText("1 skill could not be loaded")).toHaveLength(2));
    const calls = socket.rpc.mock.calls.filter(([method]) => method === "skills/list");
    expect(calls).toHaveLength(2);
    expect(calls.map(([, params]) => (params as { cwds: string[] }).cwds.length)).toEqual([2, 1]);
    expect(calls.some(([, params]) => (params as { cwds: string[] }).cwds.length === 0)).toBe(false);
  });

  it("shows an explicit Skills error and retries only through refresh after the first load", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => (
      method === "skills/list"
        ? Promise.reject(new Error("temporary Skills failure"))
        : baseRpc?.(method, params)
    ));
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(await screen.findByText("Skills could not be loaded")).toBeInTheDocument();
    expect(screen.queryByText("No skills found")).not.toBeInTheDocument();

    const callsAfterFailure = socket.rpc.mock.calls.filter(([method]) => method === "skills/list").length;
    fireEvent.click(screen.getByRole("tab", { name: "Active" }));
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(socket.rpc.mock.calls.filter(([method]) => method === "skills/list")).toHaveLength(
      callsAfterFailure,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh skills" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("skills/list", {
      cwds: expect.any(Array),
      forceReload: true,
    }));
  });

  it("keeps the current cwd inside the bounded Skills project selection", async () => {
    const projects = Array.from({ length: 18 }, (_, index) => ({
      ...existingThread,
      id: `thread-project-${index}`,
      name: `Project ${index}`,
      cwd: `/workspace/project-${index}`,
    }));
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "thread/list") {
        return Promise.resolve({
          data: (params as { archived?: boolean } | undefined)?.archived ? [] : projects,
          nextCursor: null,
        });
      }
      if (method === "skills/list") {
        const cwds = (params as { cwds: string[] }).cwds;
        return Promise.resolve({
          data: cwds.map((cwd) => ({ cwd, skills: [], errorCount: 0 })),
        });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Project 17" });
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("skills/list", {
      cwds: expect.any(Array),
    }));

    const request = socket.rpc.mock.calls.find(([method]) => method === "skills/list")?.[1] as {
      cwds: string[];
    };
    expect(request.cwds).toHaveLength(16);
    expect(request.cwds[0]).toBe("/workspace/default-one");
    expect(request.cwds).not.toContain("/workspace/project-15");
    expect(screen.getByText("Showing the 16 most relevant projects")).toBeInTheDocument();
  });

  it("keeps a new thread visible until the canonical list hydrates its first-turn metadata", async () => {
    let threadStarted = false;
    let completionStarted = false;
    let postStartListCalls = 0;
    let completionListCalls = 0;
    const postStartSnapshot = {
      ...existingThread,
      id: "thread-post-start-snapshot",
      name: "Post-start snapshot",
    };
    const completionSnapshot = {
      ...existingThread,
      id: "thread-completion-snapshot",
      name: "Completion omission",
    };
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "thread/list" && !(params as { archived?: boolean } | undefined)?.archived) {
        if (!threadStarted) {
          return Promise.resolve({ data: [existingThread], nextCursor: null });
        }
        if (!completionStarted) {
          postStartListCalls += 1;
          return Promise.resolve({ data: [postStartSnapshot], nextCursor: null });
        }
        completionListCalls += 1;
        return Promise.resolve({
          data: completionListCalls === 1
            ? [completionSnapshot]
            : [{
                ...newThread,
                preview: "First request",
                updatedAt: 1_800_000_010,
                recencyAt: 1_800_000_010,
              }, existingThread],
          nextCursor: null,
        });
      }
      if (method === "thread/start") threadStarted = true;
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh threads" })).toBeEnabled());
    await sendMessage();
    await screen.findByRole("button", { name: "Post-start snapshot" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh threads" })).toBeEnabled());
    expect(postStartListCalls).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: "Untitled thread" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Untitled thread" }).querySelector(".thread-meta"))
      .not.toHaveTextContent("thread-n");

    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/status/changed",
      params: { threadId: newThread.id, status: { type: "idle" } },
    }));
    expect(screen.getByRole("button", { name: "Untitled thread" }).querySelector(".thread-meta"))
      .not.toHaveTextContent("thread-n");

    completionStarted = true;
    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/completed",
      params: {
        threadId: newThread.id,
        turn: { id: "turn-new", status: "completed", itemsView: "notLoaded", items: [] },
      },
    }));

    await screen.findByRole("button", { name: "Completion omission" });
    expect(screen.getByRole("button", { name: "Untitled thread" })).toBeInTheDocument();
    const hydratedThread = await screen.findByRole("button", { name: "First request" });
    expect(completionListCalls).toBe(2);
    expect(hydratedThread.querySelector(".thread-meta")).not.toHaveTextContent("thread-n");
    expect(document.querySelector(".toolbar-title strong")).toHaveTextContent("First request");
  });

  it("reloads the thread list when a name notification races the initial response", async () => {
    let activeListCalls = 0;
    let resolveInitialList: ((value: unknown) => void) | undefined;
    let markInitialListRequested: (() => void) | undefined;
    const initialList = new Promise<unknown>((resolve) => {
      resolveInitialList = resolve;
    });
    const initialListRequested = new Promise<void>((resolve) => {
      markInitialListRequested = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "thread/list" && !(params as { archived?: boolean } | undefined)?.archived) {
        activeListCalls += 1;
        if (activeListCalls === 1) {
          markInitialListRequested?.();
          return initialList;
        }
        return Promise.resolve({
          data: [{ ...existingThread, name: "Renamed during load" }],
          nextCursor: null,
        });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    await initialListRequested;
    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/name/updated",
      params: { threadId: existingThread.id, threadName: "Renamed during load" },
    }));
    await act(async () => {
      resolveInitialList?.({ data: [], nextCursor: null });
      await initialList;
    });

    expect(await screen.findByRole("button", { name: "Renamed during load" })).toBeInTheDocument();
    expect(activeListCalls).toBeGreaterThanOrEqual(2);
  });

  it("ignores an older thread-list refresh that finishes after first-turn hydration", async () => {
    let threadStarted = false;
    let completionStarted = false;
    let resolveStaleList: ((value: unknown) => void) | undefined;
    let markStaleListRequested: (() => void) | undefined;
    const staleList = new Promise<unknown>((resolve) => {
      resolveStaleList = resolve;
    });
    const staleListRequested = new Promise<void>((resolve) => {
      markStaleListRequested = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "thread/list" && !(params as { archived?: boolean } | undefined)?.archived) {
        if (!threadStarted) {
          return Promise.resolve({ data: [existingThread], nextCursor: null });
        }
        if (!completionStarted) {
          markStaleListRequested?.();
          return staleList;
        }
        return Promise.resolve({
          data: [{
            ...newThread,
            preview: "First request",
            updatedAt: 1_800_000_010,
            recencyAt: 1_800_000_010,
          }, existingThread],
          nextCursor: null,
        });
      }
      if (method === "thread/start") threadStarted = true;
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh threads" })).toBeEnabled());
    await sendMessage();
    await screen.findByRole("button", { name: "Untitled thread" });
    await staleListRequested;

    completionStarted = true;
    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/completed",
      params: {
        threadId: newThread.id,
        turn: { id: "turn-new", status: "completed", itemsView: "notLoaded", items: [] },
      },
    }));
    await screen.findByRole("button", { name: "First request" });

    await act(async () => {
      resolveStaleList?.({ data: [existingThread], nextCursor: null });
      await staleList;
    });
    expect(screen.getByRole("button", { name: "First request" })).toBeInTheDocument();
    expect(document.querySelector(".toolbar-title strong")).toHaveTextContent("First request");
  });

  it("does not let a pre-mutation list response restore a deleted thread", async () => {
    let deferNextActiveList = false;
    let resolveStaleList: ((value: unknown) => void) | undefined;
    let markStaleListRequested: (() => void) | undefined;
    const staleList = new Promise<unknown>((resolve) => {
      resolveStaleList = resolve;
    });
    const staleListRequested = new Promise<void>((resolve) => {
      markStaleListRequested = resolve;
    });
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (
        deferNextActiveList &&
        method === "thread/list" &&
        !(params as { archived?: boolean } | undefined)?.archived
      ) {
        deferNextActiveList = false;
        markStaleListRequested?.();
        return staleList;
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh threads" })).toBeEnabled());
    deferNextActiveList = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh threads" }));
    await staleListRequested;

    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/deleted",
      params: { threadId: existingThread.id },
    }));
    expect(screen.queryByRole("button", { name: "Existing thread" })).not.toBeInTheDocument();

    await act(async () => {
      resolveStaleList?.({ data: [existingThread], nextCursor: null });
      await staleList;
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh threads" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Existing thread" })).not.toBeInTheDocument();
  });

  it("protects a cross-client thread until the canonical list includes it", async () => {
    let afterRemoteStart = false;
    const listMarker = {
      ...existingThread,
      id: "thread-list-marker",
      name: "Canonical omission",
    };
    const remoteThread = {
      ...newThread,
      id: "thread-remote",
      name: "Remote thread",
    };
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (
        afterRemoteStart &&
        method === "thread/list" &&
        !(params as { archived?: boolean } | undefined)?.archived
      ) {
        return Promise.resolve({ data: [listMarker], nextCursor: null });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh threads" })).toBeEnabled());
    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/started",
      params: { thread: remoteThread },
    }));
    await screen.findByRole("button", { name: "Remote thread" });

    afterRemoteStart = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh threads" }));
    await screen.findByRole("button", { name: "Canonical omission" });
    expect(screen.getByRole("button", { name: "Remote thread" })).toBeInTheDocument();
  });

  it("does not move a thread or regress its displayed activity time after resume", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    const listThread = {
      ...existingThread,
      createdAt: 100,
      updatedAt: 300,
      recencyAt: 300,
    };
    const otherThread = {
      ...existingThread,
      id: "thread-other",
      name: "Other thread",
      createdAt: 150,
      updatedAt: 200,
      recencyAt: 200,
    };
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "thread/list" && !(params as { archived?: boolean } | undefined)?.archived) {
        return Promise.resolve({ data: [listThread, otherThread], nextCursor: null });
      }
      if (method === "thread/resume") {
        return Promise.resolve({
          thread: {
            ...existingThread,
            createdAt: 100,
            updatedAt: 100,
            recencyAt: 100,
          },
          cwd: existingThread.cwd,
          model: existingThread.model,
          sandbox: { type: "workspaceWrite" },
          initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
        });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    const titlesBefore = Array.from(document.querySelectorAll(".thread-title"))
      .map((element) => element.textContent);
    const activityBefore = screen.getByRole("button", { name: "Existing thread" })
      .querySelector(".thread-meta")?.textContent;
    expect(titlesBefore).toEqual(["Existing thread", "Other thread"]);

    fireEvent.click(screen.getByRole("button", { name: "Existing thread" }));
    await screen.findByTitle("Existing thread");

    const titlesAfter = Array.from(document.querySelectorAll(".thread-title"))
      .map((element) => element.textContent);
    const activityAfter = screen.getByRole("button", { name: "Existing thread" })
      .querySelector(".thread-meta")?.textContent;
    expect(titlesAfter).toEqual(["Existing thread", "Other thread"]);
    expect(activityAfter).toBe(activityBefore);
  });

  it("keeps archive and permanent delete unavailable for an active thread", async () => {
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "thread/list" && !(params as { archived?: boolean } | undefined)?.archived) {
        return Promise.resolve({
          data: [{ ...existingThread, status: { type: "active", activeFlags: [] } }],
          nextCursor: null,
        });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    fireEvent.click(screen.getByRole("button", { name: "More actions for Existing thread" }));
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    expect(socket.rpc.mock.calls.some(([method]) => (
      method === "thread/archive" || method === "thread/delete"
    ))).toBe(false);
  });

  it("reacts to cross-client lifecycle notifications and removes deleted preview data", async () => {
    const indexedDB = new FakeIDBFactory();
    vi.stubGlobal("indexedDB", indexedDB);
    const deletedPreviewKey = sessionImagePreviewKey("thread-existing", "turn-deleted-preview");
    const retainedPreviewKey = sessionImagePreviewKey("thread-other", "turn-retained-preview");
    const seeder = new BrowserImagePreviewStore({ indexedDB });
    await seeder.remember(deletedPreviewKey, [
      new NodeBlob([PNG], { type: "image/png" }) as unknown as Blob,
    ]);
    await seeder.remember(retainedPreviewKey, [
      new NodeBlob([PNG], { type: "image/png" }) as unknown as Blob,
    ]);
    seeder.close();
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));

    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/archived",
      params: { threadId: "thread-existing" },
    }));
    expect(screen.queryByRole("button", { name: "Existing thread" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(screen.getByRole("button", { name: "Existing thread" })).toBeInTheDocument();

    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/unarchived",
      params: { threadId: "thread-existing" },
    }));
    expect(screen.queryByRole("button", { name: "Existing thread" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Active" }));
    expect(screen.getByRole("button", { name: "Existing thread" })).toBeInTheDocument();

    act(() => socket.onNotification?.({
      type: "notification",
      method: "thread/deleted",
      params: { threadId: "thread-existing" },
    }));
    expect(screen.queryByRole("button", { name: "Existing thread" })).not.toBeInTheDocument();

    const persistedStore = new BrowserImagePreviewStore({ indexedDB });
    await waitFor(async () => {
      expect((await persistedStore.loadAll()).map((entry) => entry.key)).toEqual([
        retainedPreviewKey,
      ]);
    });
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    persistedStore.close();
  });

  it("uploads generic-MIME image bytes and retains a preview with the detected MIME", async () => {
    const indexedDB = new FakeIDBFactory();
    const existingPreviewKey = sessionImagePreviewKey("thread-existing", "turn-existing-image");
    const seeder = new BrowserImagePreviewStore({ indexedDB });
    await seeder.remember(existingPreviewKey, [
      new NodeBlob([PNG], { type: "image/png" }) as unknown as Blob,
    ]);
    seeder.close();
    const delayedOpen = delayOpen(indexedDB, "ask-codex-image-previews");
    vi.stubGlobal("indexedDB", delayedOpen.factory);
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
    await delayedOpen.ready;
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/bootstrap",
      expect.objectContaining({
        headers: { Authorization: "Bearer browser-token" },
      }),
    ));
    const file = new NodeFile(
      [PNG],
      "screen.png",
      { type: "application/octet-stream" },
    ) as unknown as File;
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
    expect(await screen.findByRole("link", { name: "Open uploaded image 1 of 1" }))
      .toHaveAttribute("href", expect.stringMatching(/^blob:image\/png:/));
    delayedOpen.release();

    const persistedStore = new BrowserImagePreviewStore({ indexedDB });
    const sentPreviewKey = sessionImagePreviewKey("thread-new", "turn-image");
    await waitFor(async () => {
      expect((await persistedStore.loadAll()).map((entry) => entry.key))
        .toEqual([existingPreviewKey, sentPreviewKey]);
    });
    const preview = await screen.findByRole("link", { name: "Open uploaded image 1 of 1" });
    const previewUrl = preview.getAttribute("href");
    expect(previewUrl).toMatch(/^blob:image\/png:/);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:screen.png:1");
    expect(revokeObjectURL).not.toHaveBeenCalledWith(previewUrl);
    expect(createObjectURL.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      size: file.size,
      type: "image/png",
    }));
    expect(document.body).not.toHaveTextContent("/private/server/screen.png");

    const persisted = await persistedStore.loadAll();
    const sentPreview = persisted.find((entry) => entry.key === sentPreviewKey);
    expect(sentPreview?.blobs).toHaveLength(1);
    expect(sentPreview?.blobs[0]).toEqual(expect.objectContaining({
      size: file.size,
      type: "image/png",
    }));
    expect("name" in sentPreview!.blobs[0]).toBe(false);
    persistedStore.close();
  });

  it("uploads an ordinary file by opaque id and keeps a browser-local download copy", async () => {
    const indexedDB = new FakeIDBFactory();
    vi.stubGlobal("indexedDB", indexedDB);
    sessionStorage.setItem("ASK_CODEX_TOKEN", "browser-token");
    const attachmentId = "f".repeat(32);
    const file = new NodeFile(
      ["report contents"],
      "report.pdf",
      { type: "application/pdf" },
    ) as unknown as File;
    const markerText = "Attached file: report.pdf";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return new Response(JSON.stringify({
          ready: true,
          defaultCwd: "/workspace/default-one",
          authRequired: true,
        }), { status: 200 });
      }
      if (url === "/api/file-attachments" && init?.method === "POST") {
        return new Response(JSON.stringify({
          attachment: {
            id: attachmentId,
            name: file.name,
            mediaType: file.type,
            size: file.size,
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
              id: "turn-file",
              status: "inProgress",
              items: [{
                id: "user-file",
                type: "userMessage",
                content: [
                  { type: "text", text: "Inspect this report", text_elements: [] },
                  {
                    type: "text",
                    text: markerText,
                    text_elements: [{
                      byteRange: { start: 0, end: markerText.length },
                      placeholder: JSON.stringify({
                        type: "askCodexFile",
                        name: file.name,
                        mediaType: file.type,
                        size: file.size,
                      }),
                    }],
                  },
                ],
              }],
            },
          })
        : baseRpc?.(method, params)
    ));
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add attachment" })).toBeEnabled());

    fireEvent.change(screen.getByLabelText("Choose files"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Message Codex"), { target: { value: "Inspect this report" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(socket.rpc).toHaveBeenCalledWith("turn/start", expect.objectContaining({
      input: [
        { type: "text", text: "Inspect this report", text_elements: [] },
        { type: "file", attachmentId },
      ],
    })));
    expect(fetchMock).toHaveBeenCalledWith("/api/file-attachments", expect.objectContaining({
      body: file,
      headers: expect.objectContaining({
        Authorization: "Bearer browser-token",
        "X-Ask-Codex-File-Name": encodeURIComponent(file.name),
      }),
    }));
    expect(await screen.findByRole("button", { name: "Download report.pdf" })).toBeEnabled();
    expect(document.body).not.toHaveTextContent("/private/");

    const persistedStore = new BrowserFileAttachmentStore({ indexedDB });
    const storedKey = sessionFileAttachmentKey("thread-new", "turn-file");
    await waitFor(async () => {
      expect((await persistedStore.loadAll()).map((entry) => entry.key)).toContain(storedKey);
    });
    const stored = (await persistedStore.loadAll()).find((entry) => entry.key === storedKey);
    expect(stored?.files[0]).toEqual(expect.objectContaining({
      name: file.name,
      mediaType: file.type,
      size: file.size,
    }));
    persistedStore.close();
  });

  it("does not block an accepted image turn when browser persistence stalls", async () => {
    const stalledRequest = {} as IDBOpenDBRequest;
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => stalledRequest),
    } as unknown as IDBFactory);
    const attachmentId = "d".repeat(32);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return new Response(JSON.stringify({
          ready: true,
          defaultCwd: "/workspace/default-one",
          authRequired: false,
        }), { status: 200 });
      }
      if (url === "/api/attachments" && init?.method === "POST") {
        return new Response(JSON.stringify({
          attachment: {
            id: attachmentId,
            mediaType: "image/png",
            size: PNG.byteLength,
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
              id: "turn-storage-disabled",
              status: "inProgress",
              items: [{
                id: "user-storage-disabled",
                type: "userMessage",
                content: [{ type: "localImage", path: "/private/server/image.png" }],
              }],
            },
          })
        : baseRpc?.(method, params)
    ));

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add attachment" })).toBeEnabled());
    const file = new File([PNG], "storage-disabled.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose images"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const preview = await screen.findByRole("link", { name: "Open uploaded image 1 of 1" });
    expect(preview).toHaveAttribute("href", "blob:image/png:2");
    await waitFor(() => expect(screen.queryByText("storage-disabled.png")).not.toBeInTheDocument());
    expect(socket.rpc).toHaveBeenCalledWith("turn/start", expect.any(Object));
  });

  it("restores persisted previews after StrictMode remounts, reloads, and thread switches", async () => {
    const indexedDB = new FakeIDBFactory();
    vi.stubGlobal("indexedDB", indexedDB);
    const previewKey = sessionImagePreviewKey("thread-existing", "turn-persisted-image");
    const seeder = new BrowserImagePreviewStore({ indexedDB });
    await seeder.remember(previewKey, [
      new NodeBlob([PNG], { type: "image/png" }) as unknown as Blob,
    ]);
    seeder.close();

    const imageTurn = {
      id: "turn-persisted-image",
      status: "completed",
      itemsView: "full",
      items: [{
        id: "user-persisted-image",
        type: "userMessage",
        content: [{ type: "localImage", path: "/private/server/reloaded.png" }],
      }],
    };
    const baseRpc = socket.rpc.getMockImplementation();
    socket.rpc.mockImplementation((method: string, params?: unknown) => {
      if (method === "thread/resume" && (params as { initialTurnsPage?: unknown })?.initialTurnsPage) {
        return Promise.resolve({
          thread: existingThread,
          cwd: existingThread.cwd,
          model: existingThread.model,
          sandbox: { type: "workspaceWrite" },
          initialTurnsPage: {
            data: [imageTurn],
            nextCursor: null,
            backwardsCursor: null,
          },
        });
      }
      return baseRpc?.(method, params);
    });
    installBootstrapFixture();

    const firstPage = render(<StrictMode><App /></StrictMode>);
    fireEvent.click(await screen.findByText("Existing thread"));
    const initialPreview = await screen.findByRole("link", { name: "Open uploaded image 1 of 1" });
    expect(initialPreview.getAttribute("href")).toMatch(/^blob:image\/png:/);

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Create thread" }));
    expect(screen.queryByRole("link", { name: "Open uploaded image 1 of 1" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByText("Existing thread"));
    expect(await screen.findByRole("link", { name: "Open uploaded image 1 of 1" })).toBeInTheDocument();

    firstPage.unmount();
    render(<StrictMode><App /></StrictMode>);
    fireEvent.click(await screen.findByText("Existing thread"));
    const reloadedPreview = await screen.findByRole("link", { name: "Open uploaded image 1 of 1" });
    expect(reloadedPreview.getAttribute("href")).toMatch(/^blob:image\/png:/);
    expect(document.body).not.toHaveTextContent("/private/server/reloaded.png");
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
          startedAt: 1_800_000_000,
          completedAt: 1_800_000_002.5,
          durationMs: 2_500,
        },
      },
    }));

    expect(screen.getByText("Streamed response remains visible")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Turn details" })).toHaveTextContent("Duration 2.5s");
    expect(screen.queryByRole("button", { name: "Stop turn" })).not.toBeInTheDocument();
  });

  it("docks the active plan above approvals and keeps the historical plan after completion", async () => {
    installBootstrapFixture();
    render(<App />);
    fireEvent.click(await screen.findByText("Existing thread"));
    await screen.findByTitle("Existing thread");
    await sendMessage();
    await screen.findByRole("button", { name: "Stop turn" });

    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/plan/updated",
      params: {
        threadId: "thread-existing",
        turnId: "turn-new",
        explanation: "Keep the current execution state visible.",
        plan: [
          { step: "Inspect the flow", status: "completed" },
          { step: "Build the dock", status: "inProgress" },
          { step: "Verify the layout", status: "pending" },
        ],
      },
    }));
    act(() => socket.onRequest?.({
      type: "request",
      id: "plan-approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-existing",
        turnId: "turn-new",
        itemId: "plan-command",
        command: "npm test",
        cwd: "/workspace/existing",
        availableDecisions: ["accept", "decline"],
      },
    }));

    const dock = screen.getByRole("region", { name: "Current plan" });
    const historicalPlan = screen.getByRole("region", { name: "Plan" });
    const conversation = screen.getByRole("main", { name: "Conversation" }).parentElement!;
    const approval = document.querySelector(".approval-panel")!;
    const composer = document.querySelector(".composer-wrap")!;
    const workspaceChildren = [...dock.parentElement!.children];

    expect(dock).toHaveTextContent("2/3");
    expect(dock).toHaveTextContent("Build the dock");
    expect(historicalPlan).toHaveTextContent("Keep the current execution state visible.");
    expect(workspaceChildren.indexOf(conversation)).toBeLessThan(workspaceChildren.indexOf(dock));
    expect(workspaceChildren.indexOf(dock)).toBeLessThan(workspaceChildren.indexOf(approval));
    expect(workspaceChildren.indexOf(approval)).toBeLessThan(workspaceChildren.indexOf(composer));

    act(() => socket.onNotification?.({
      type: "notification",
      method: "turn/plan/updated",
      params: {
        threadId: "thread-existing",
        turnId: "turn-new",
        explanation: "Keep the current execution state visible.",
        plan: [
          { step: "Inspect the flow", status: "completed" },
          { step: "Build the dock", status: "completed" },
          { step: "Verify the layout", status: "inProgress" },
        ],
      },
    }));
    expect(screen.getByRole("button", {
      name: /Step 3 of 3: Verify the layout/,
    })).toBeInTheDocument();

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

    expect(screen.queryByRole("region", { name: "Current plan" })).not.toBeInTheDocument();
    const terminalPlan = screen.getByRole("region", { name: "Plan" });
    expect(terminalPlan).toHaveTextContent("Verify the layout");
    expect(within(terminalPlan).getByRole("status")).toHaveTextContent(
      "Turn ended without a final plan update",
    );
    expect(within(terminalPlan).getByRole("listitem", {
      name: "In progress when turn ended: Verify the layout",
    })).toBeInTheDocument();
    expect(terminalPlan.querySelector(".spin")).not.toBeInTheDocument();
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
    expect(screen.getByLabelText("Message Codex")).toHaveValue("");
    const recovery = screen.getByText("Message not confirmed").closest('[role="alert"]');
    expect(recovery).toHaveTextContent("stay as draft");
    expect(recovery).toHaveTextContent("1 image");
    expect(screen.getByRole("button", { name: "Retry unconfirmed message" })).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Add attachment" })).toBeEnabled());

    const file = new File([PNG], "retry-after-error.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose images"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Message Codex"), { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Codex rejected the image turn")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry unconfirmed message" })).toBeEnabled());
    expect(screen.getByLabelText("Message Codex")).toHaveValue("");
    const recovery = screen.getByText("Message not confirmed").closest('[role="alert"]');
    expect(recovery).toHaveTextContent("keep this draft");
    expect(recovery).toHaveTextContent("1 image");
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
