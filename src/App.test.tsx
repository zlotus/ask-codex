import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory as FakeIDBFactory } from "fake-indexeddb";
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { NotificationMessage, ServerRequestMessage } from "./types/protocol";
import { BrowserImagePreviewStore } from "./utils/browserImagePreviewStore";
import { sessionImagePreviewKey } from "./utils/sessionImagePreviews";

const socket = vi.hoisted(() => ({
  connection: "connected",
  rpc: vi.fn(),
  respond: vi.fn(),
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
      rpc: socket.rpc,
      respond: socket.respond,
      reconnect: vi.fn(),
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

function delayOpen(indexedDB: IDBFactory): {
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
    socket.onNotification = null;
    socket.onRequest = null;
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

  it("loads active and archived views and sends strict lifecycle RPCs", async () => {
    installBootstrapFixture();
    render(<App />);

    await screen.findByRole("button", { name: "Existing thread" });
    await waitFor(() => {
      expect(socket.rpc).toHaveBeenCalledWith("thread/list", expect.objectContaining({
        archived: false,
      }));
      expect(socket.rpc).toHaveBeenCalledWith("thread/list", expect.objectContaining({
        archived: true,
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
    const delayedOpen = delayOpen(indexedDB);
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Add images" })).toBeEnabled());
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
        },
      },
    }));

    expect(screen.getByText("Streamed response remains visible")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
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
    expect(screen.getByRole("region", { name: "Plan" })).toHaveTextContent("Verify the layout");
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Add images" })).toBeEnabled());

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
