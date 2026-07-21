import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Sidebar } from "./components/Sidebar";
import { Toasts } from "./components/Toasts";
import { TokenDialog } from "./components/TokenDialog";
import { Toolbar } from "./components/Toolbar";
import { useCodexSocket } from "./hooks/useCodexSocket";
import { appReducer, initialState } from "./state/appReducer";
import type {
  BootstrapInfo,
  CodexThread,
  ModelInfo,
  NotificationMessage,
  ServerRequestMessage,
  ToastMessage,
} from "./types/protocol";
import {
  errorMessage,
  extractThread,
  extractThreads,
  extractTurn,
  extractModels,
  isRecord,
  normalizeItem,
  normalizeThread,
  normalizeTurn,
  parsePlan,
  readString,
  sandboxMode,
} from "./utils/protocol";

const TOKEN_KEY = "ASK_AGENT_TOKEN";

function threadTitle(thread: CodexThread | null): string {
  return thread?.name?.trim() || thread?.preview?.trim() || (thread ? "Untitled thread" : "New thread");
}

function paramsRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
  const [bootstrap, setBootstrap] = useState<BootstrapInfo | null>(null);
  const [bootstrapError, setBootstrapError] = useState("");
  const [tokenOpen, setTokenOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const toastIdRef = useRef(0);
  const selectionGenerationRef = useRef(0);

  const showToast = useCallback((message: string, tone: ToastMessage["tone"] = "error") => {
    const id = ++toastIdRef.current;
    dispatch({ type: "toast", toast: { id, tone, message } });
    window.setTimeout(() => dispatch({ type: "removeToast", id }), 5_500);
  }, []);

  const onNotification = useCallback((message: NotificationMessage) => {
    const params = paramsRecord(message.params);
    const threadId = readString(params.threadId);
    const turnId = readString(params.turnId);
    const itemId = readString(params.itemId);

    switch (message.method) {
      case "thread/started": {
        const thread = normalizeThread(params.thread);
        if (thread) dispatch({ type: "upsertThread", thread });
        return;
      }
      case "thread/name/updated": {
        if (threadId) dispatch({
          type: "upsertThread",
          thread: { id: threadId, name: readString(params.threadName) ?? readString(params.name) },
        });
        return;
      }
      case "thread/status/changed": {
        if (threadId) dispatch({ type: "upsertThread", thread: { id: threadId, status: params.status as CodexThread["status"] } });
        return;
      }
      case "thread/settings/updated": {
        const rawSettings = paramsRecord(params.threadSettings);
        const sandbox = sandboxMode(rawSettings.sandboxPolicy ?? rawSettings.sandbox);
        if (threadId) dispatch({
          type: "threadSettings",
          threadId,
          settings: {
            ...(readString(rawSettings.cwd) ? { cwd: readString(rawSettings.cwd) } : {}),
            ...(readString(rawSettings.model) ? { model: readString(rawSettings.model) } : {}),
            effort: readString(rawSettings.effort) ?? "",
            ...(sandbox ? { sandbox } : {}),
          },
        });
        return;
      }
      case "turn/started": {
        const turn = normalizeTurn(params.turn);
        if (turn) dispatch({ type: "upsertTurn", turn, threadId });
        return;
      }
      case "turn/completed": {
        const turn = normalizeTurn(params.turn);
        if (turn) dispatch({ type: "upsertTurn", turn, threadId });
        else if (turnId) dispatch({ type: "setTurnStatus", turnId, status: readString(params.status) ?? "completed", error: params.error });
        return;
      }
      case "turn/diff/updated": {
        const diff = readString(params.diff);
        if (turnId && diff !== undefined) dispatch({ type: "setTurnDiff", turnId, diff });
        return;
      }
      case "turn/plan/updated": {
        const plan = parsePlan(params);
        if (turnId && plan) dispatch({ type: "setTurnPlan", turnId, plan });
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = normalizeItem(params.item);
        if (turnId && item) dispatch({ type: "upsertItem", turnId, item });
        return;
      }
      case "serverRequest/resolved": {
        if (typeof params.requestId === "string" || typeof params.requestId === "number") {
          dispatch({ type: "removeRequest", id: params.requestId });
        }
        return;
      }
      default:
        break;
    }

    const delta = readString(params.delta);
    if (!turnId || !itemId || delta === undefined) return;
    if (message.method === "item/agentMessage/delta") {
      dispatch({ type: "appendItemDelta", turnId, itemId, itemType: "agentMessage", field: "text", delta });
    } else if (message.method === "item/reasoning/summaryTextDelta") {
      dispatch({
        type: "appendIndexedItemDelta",
        turnId,
        itemId,
        itemType: "reasoning",
        field: "summary",
        index: typeof params.summaryIndex === "number" ? params.summaryIndex : 0,
        delta,
      });
    } else if (message.method === "item/reasoning/textDelta") {
      dispatch({
        type: "appendIndexedItemDelta",
        turnId,
        itemId,
        itemType: "reasoning",
        field: "content",
        index: typeof params.contentIndex === "number" ? params.contentIndex : 0,
        delta,
      });
    } else if (message.method === "item/plan/delta") {
      dispatch({ type: "appendItemDelta", turnId, itemId, itemType: "plan", field: "text", delta });
    } else if (message.method === "item/commandExecution/outputDelta") {
      dispatch({ type: "appendItemDelta", turnId, itemId, itemType: "commandExecution", field: "aggregatedOutput", delta });
    }
  }, []);

  const onRequest = useCallback((message: ServerRequestMessage) => {
    dispatch({
      type: "addRequest",
      request: {
        id: message.id,
        method: message.method,
        params: paramsRecord(message.params),
        receivedAt: Date.now(),
      },
    });
  }, []);

  const socketEnabled = Boolean(bootstrap && (!bootstrap.authRequired || token));
  const { connection, connectionDetail, rpc, respond } = useCodexSocket({
    enabled: socketEnabled,
    token,
    onNotification,
    onRequest,
    onError: showToast,
    onStatus: (message) => {
      if (message.status === "error") dispatch({ type: "clearRequests" });
      setBootstrap((current) => current ? {
        ...current,
        ready: message.status === "ready",
        defaultCwd: message.defaultCwd || current.defaultCwd,
        codexVersion: message.version ?? current.codexVersion,
      } : current);
    },
  });

  const loadBootstrap = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/bootstrap", {
        signal,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      setBootstrapError("");
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) setTokenOpen(true);
        throw new Error(response.status === 401 ? "A valid ASK_AGENT_TOKEN is required" : `Bootstrap failed (${response.status})`);
      }
      const raw: unknown = await response.json();
      if (!isRecord(raw) || typeof raw.ready !== "boolean" || typeof raw.defaultCwd !== "string" || typeof raw.authRequired !== "boolean") {
        throw new Error("The server returned an invalid bootstrap response");
      }
      const info: BootstrapInfo = {
        ready: raw.ready,
        defaultCwd: raw.defaultCwd,
        authRequired: raw.authRequired,
        codexVersion: readString(raw.codexVersion),
      };
      setBootstrap(info);
      if (info.authRequired && !token) setTokenOpen(true);
      dispatch({ type: "settings", settings: { cwd: info.defaultCwd } });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const message = errorMessage(error);
      setBootstrap(null);
      setBootstrapError(message);
      showToast(message);
    }
  }, [showToast, token]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadBootstrap(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadBootstrap]);

  const refreshThreads = useCallback(async () => {
    if (connection !== "connected") return;
    setLoadingThreads(true);
    try {
      const threads: CodexThread[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const result = await rpc("thread/list", {
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: [],
          ...(cursor ? { cursor } : {}),
        });
        threads.push(...extractThreads(result));
        const nextCursor = isRecord(result) ? readString(result.nextCursor) : undefined;
        if (!nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      dispatch({ type: "setThreads", threads });
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setLoadingThreads(false);
    }
  }, [connection, rpc, showToast]);

  useEffect(() => {
    if (connection !== "connected") return;
    const timer = window.setTimeout(() => {
      void refreshThreads();
      void rpc("model/list", { limit: 100 })
        .then((result) => setModels(extractModels(result)))
        .catch(() => setModels([]));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [connection, refreshThreads, rpc]);

  const selectThread = useCallback(async (threadId: string) => {
    const generation = ++selectionGenerationRef.current;
    dispatch({ type: "selectThread", threadId });
    setSidebarOpen(false);
    setLoadingThread(true);
    try {
      const resumed = await rpc("thread/resume", { threadId });
      let thread = extractThread(resumed);
      if (!thread?.turns) {
        const read = await rpc("thread/read", { threadId, includeTurns: true });
        thread = extractThread(read);
      }
      if (generation !== selectionGenerationRef.current) return;
      if (!thread) throw new Error("Codex did not return the requested thread");
      dispatch({ type: "setCurrentThread", thread });
      const resumeRecord = paramsRecord(resumed);
      dispatch({
        type: "settings",
        settings: {
          cwd: readString(resumeRecord.cwd) ?? thread.cwd ?? bootstrap?.defaultCwd ?? "",
          model: readString(resumeRecord.model) ?? thread.model ?? "",
          effort: readString(resumeRecord.effort) ?? readString(resumeRecord.reasoningEffort) ?? "",
          sandbox: sandboxMode(resumeRecord.sandbox) ?? "workspace-write",
        },
      });
    } catch (error) {
      if (generation === selectionGenerationRef.current) showToast(errorMessage(error));
    } finally {
      if (generation === selectionGenerationRef.current) setLoadingThread(false);
    }
  }, [bootstrap, rpc, showToast]);

  const newThread = useCallback(() => {
    selectionGenerationRef.current += 1;
    setLoadingThread(false);
    dispatch({ type: "selectThread", threadId: null });
    dispatch({
      type: "settings",
      settings: {
        cwd: bootstrap?.defaultCwd ?? state.settings.cwd,
        effort: "",
        sandbox: "workspace-write",
      },
    });
    setSidebarOpen(false);
  }, [bootstrap, state.settings.cwd]);

  const sendMessage = useCallback(async (text: string) => {
    let thread = state.currentThread;
    const existingThread = Boolean(thread);
    try {
      if (!thread) {
        if (!state.settings.cwd.trim()) throw new Error("Choose an absolute working directory first");
        const result = await rpc("thread/start", {
          cwd: state.settings.cwd.trim(),
          approvalPolicy: "on-request",
          sandbox: state.settings.sandbox === "external" ? "workspace-write" : state.settings.sandbox,
          ...(state.settings.model.trim() ? { model: state.settings.model.trim() } : {}),
        });
        thread = extractThread(result);
        if (!thread) throw new Error("Codex did not return a new thread");
        dispatch({ type: "setCurrentThread", thread });
      }
      if (existingThread) {
        const resumed = await rpc("thread/resume", {
          threadId: thread.id,
          cwd: state.settings.cwd.trim(),
          approvalPolicy: "on-request",
          ...(state.settings.sandbox === "external" ? {} : { sandbox: state.settings.sandbox }),
          ...(state.settings.model.trim() ? { model: state.settings.model.trim() } : {}),
        });
        const updatedThread = extractThread(resumed);
        if (updatedThread) {
          thread = updatedThread;
          dispatch({ type: "setCurrentThread", thread: updatedThread });
        }
      }
      const result = await rpc("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text, text_elements: [] }],
        cwd: state.settings.cwd.trim(),
        ...(state.settings.model.trim() ? { model: state.settings.model.trim() } : {}),
        ...(state.settings.effort ? { effort: state.settings.effort } : {}),
      });
      const turn = extractTurn(result);
      if (turn) dispatch({ type: "upsertTurn", turn, threadId: thread.id });
      void refreshThreads();
    } catch (error) {
      showToast(errorMessage(error));
      throw error;
    }
  }, [refreshThreads, rpc, showToast, state.currentThread, state.settings]);

  const stopTurn = useCallback(async () => {
    if (!state.currentThread || !state.activeTurnId) return;
    try {
      await rpc("turn/interrupt", {
        threadId: state.currentThread.id,
        turnId: state.activeTurnId,
      });
    } catch (error) {
      showToast(errorMessage(error));
    }
  }, [rpc, showToast, state.activeTurnId, state.currentThread]);

  const resolveRequest = useCallback((id: string | number, result: unknown) => {
    try {
      respond(id, result);
      dispatch({ type: "removeRequest", id });
    } catch (error) {
      showToast(errorMessage(error));
    }
  }, [respond, showToast]);

  const rejectRequest = useCallback((id: string | number, message: string) => {
    try {
      respond(id, undefined, { code: -32601, message });
      dispatch({ type: "removeRequest", id });
    } catch (error) {
      showToast(errorMessage(error));
    }
  }, [respond, showToast]);

  const saveToken = useCallback((nextToken: string) => {
    if (nextToken) sessionStorage.setItem(TOKEN_KEY, nextToken);
    else sessionStorage.removeItem(TOKEN_KEY);
    setToken(nextToken);
    setTokenOpen(false);
    setBootstrapError("");
  }, []);

  const requiredToken = Boolean(bootstrap?.authRequired && !token) || bootstrapError.includes("ASK_AGENT_TOKEN");
  const title = useMemo(() => threadTitle(state.currentThread), [state.currentThread]);

  return (
    <div className="app-shell">
      <Sidebar
        threads={state.threads}
        selectedThreadId={state.selectedThreadId}
        search={search}
        open={sidebarOpen}
        loading={loadingThreads}
        connection={connection}
        onSearch={setSearch}
        onSelect={(threadId) => void selectThread(threadId)}
        onNew={newThread}
        onRefresh={() => void refreshThreads()}
        onClose={() => setSidebarOpen(false)}
        onToken={() => setTokenOpen(true)}
      />
      <section className="workspace">
        <Toolbar
          settings={state.settings}
          title={title}
          connectionDetail={bootstrapError || connectionDetail}
          models={models}
          onChange={(settings) => dispatch({ type: "settings", settings })}
          onMenu={() => setSidebarOpen(true)}
        />
        <Conversation thread={state.currentThread} loading={loadingThread} />
        <ApprovalPanel
          requests={state.pendingRequests}
          onResolve={resolveRequest}
          onReject={rejectRequest}
        />
        <Composer
          disabled={connection !== "connected"}
          running={Boolean(state.activeTurnId)}
          onSend={sendMessage}
          onStop={stopTurn}
        />
      </section>
      <TokenDialog
        key={`${tokenOpen || requiredToken}:${token}`}
        open={tokenOpen || requiredToken}
        required={requiredToken}
        token={token}
        error={bootstrapError || undefined}
        onSave={saveToken}
        onClose={() => setTokenOpen(false)}
      />
      <Toasts toasts={state.toasts} onClose={(id) => dispatch({ type: "removeToast", id })} />
    </div>
  );
}
