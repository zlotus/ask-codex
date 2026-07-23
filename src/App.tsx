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
  CodexTurn,
  CodexTurnsPage,
  ModelInfo,
  NotificationMessage,
  ServerRequestMessage,
  ToastMessage,
} from "./types/protocol";
import {
  errorMessage,
  extractInitialTurnsPage,
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
import { loadStoredToken, saveStoredToken } from "./utils/tokenStorage";
import { filterSnapshotCoveredNotifications, ResyncCoordinator } from "./utils/resyncCoordinator";
import { requestFullTurnPage, requestTurnPage, resumeThreadForHistory } from "./utils/turnHistory";

function threadTitle(thread: CodexThread | null): string {
  return thread?.name?.trim() || thread?.preview?.trim() || (thread ? "Untitled thread" : "New thread");
}

function paramsRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

const TURN_PAGE_SIZE = 10;
const MAX_REASONING_PARTS = 16;

function reasoningPartIndex(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < MAX_REASONING_PARTS
    ? value as number
    : null;
}

function turnsForDisplay(page: CodexTurnsPage, cursor: string | null): CodexTurn[] {
  return [...page.data].reverse().map((turn) => turn.itemsView === "summary"
    ? {
        ...turn,
        historyDetail: {
          cursor,
          status: "idle",
          error: null,
        },
      }
    : turn);
}

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [token, setToken] = useState(loadStoredToken);
  const [bootstrap, setBootstrap] = useState<BootstrapInfo | null>(null);
  const [bootstrapError, setBootstrapError] = useState("");
  const [tokenOpen, setTokenOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadLoadError, setThreadLoadError] = useState<string | null>(null);
  const [resyncSignal, setResyncSignal] = useState(0);
  const [resyncing, setResyncing] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const toastIdRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const selectedThreadIdRef = useRef<string | null>(state.selectedThreadId);
  const currentThreadRef = useRef<CodexThread | null>(state.currentThread);
  const historyLoadsRef = useRef(new Set<string>());
  const detailLoadsRef = useRef(new Set<string>());
  const resyncCoordinatorRef = useRef(new ResyncCoordinator());

  useEffect(() => {
    selectedThreadIdRef.current = state.selectedThreadId;
    currentThreadRef.current = state.currentThread;
  }, [state.currentThread, state.selectedThreadId]);

  const showToast = useCallback((message: string, tone: ToastMessage["tone"] = "error") => {
    const id = ++toastIdRef.current;
    dispatch({ type: "toast", toast: { id, tone, message } });
    window.setTimeout(() => dispatch({ type: "removeToast", id }), 5_500);
  }, []);

  const applyNotification = useCallback((message: NotificationMessage) => {
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
        if (turnId && item) dispatch({
          type: "upsertItem",
          turnId,
          item,
          lifecycle: message.method === "item/started" ? "started" : "completed",
        });
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
      const index = reasoningPartIndex(params.summaryIndex);
      dispatch(index === null
        ? {
            type: "recordIndexedItemOmission",
            turnId,
            itemId,
            itemType: "reasoning",
            field: "summary",
            omitted: delta.length,
          }
        : {
            type: "appendIndexedItemDelta",
            turnId,
            itemId,
            itemType: "reasoning",
            field: "summary",
            index,
            delta,
          });
    } else if (message.method === "item/reasoning/textDelta") {
      const index = reasoningPartIndex(params.contentIndex);
      dispatch(index === null
        ? {
            type: "recordIndexedItemOmission",
            turnId,
            itemId,
            itemType: "reasoning",
            field: "content",
            omitted: delta.length,
          }
        : {
            type: "appendIndexedItemDelta",
            turnId,
            itemId,
            itemType: "reasoning",
            field: "content",
            index,
            delta,
          });
    } else if (message.method === "item/plan/delta") {
      dispatch({ type: "appendItemDelta", turnId, itemId, itemType: "plan", field: "text", delta });
    } else if (message.method === "item/commandExecution/outputDelta") {
      dispatch({ type: "appendItemDelta", turnId, itemId, itemType: "commandExecution", field: "aggregatedOutput", delta });
    } else if (message.method === "item/fileChange/outputDelta") {
      dispatch({ type: "appendItemDelta", turnId, itemId, itemType: "fileChange", field: "output", delta });
    }
  }, []);

  const onNotification = useCallback((message: NotificationMessage) => {
    const coordinator = resyncCoordinatorRef.current;
    if (message.method === "gateway/resyncRequired") {
      const params = paramsRecord(message.params);
      const lostMethod = readString(params.lostMethod);
      const turnId = readString(params.turnId);
      if (
        turnId &&
        (lostMethod === "turn/diff/updated" || lostMethod === "turn/plan/updated")
      ) {
        dispatch({
          type: "recordTurnRecoveryOmission",
          threadId: readString(params.threadId),
          turnId,
          method: lostMethod,
        });
      }
      coordinator.request();
      setResyncing(true);
      setResyncSignal((current) => current + 1);
      return;
    }
    if (coordinator.shouldBuffer(message)) {
      coordinator.buffer(message);
      return;
    }
    applyNotification(message);
  }, [applyNotification]);

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
        throw new Error(response.status === 401 ? "A valid ASK_CODEX_TOKEN is required" : `Bootstrap failed (${response.status})`);
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
          ...(cursor !== undefined ? { cursor } : {}),
        });
        threads.push(...extractThreads(result));
        const nextCursor = isRecord(result) ? readString(result.nextCursor) : undefined;
        if (nextCursor === undefined || seenCursors.has(nextCursor)) break;
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
    selectedThreadIdRef.current = threadId;
    dispatch({ type: "selectThread", threadId });
    setSidebarOpen(false);
    setThreadLoadError(null);
    setLoadingThread(true);
    try {
      const resumed = await resumeThreadForHistory(rpc, threadId, TURN_PAGE_SIZE);
      if (generation !== selectionGenerationRef.current) return;
      const thread = extractThread(resumed);
      if (!thread) throw new Error("Codex did not return the requested thread");
      let page = extractInitialTurnsPage(resumed);
      if (!page) {
        page = await requestTurnPage(rpc, {
          threadId,
          preferredLimit: TURN_PAGE_SIZE,
        });
      }
      if (generation !== selectionGenerationRef.current) return;
      if (!page) throw new Error("Codex did not return the requested turn page");
      dispatch({
        type: "setCurrentThread",
        thread: { ...thread, turns: turnsForDisplay(page, null) },
        history: { nextCursor: page.nextCursor },
      });
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
      if (generation === selectionGenerationRef.current) {
        const message = errorMessage(error);
        setThreadLoadError(message);
        showToast(message);
      }
    } finally {
      if (generation === selectionGenerationRef.current) setLoadingThread(false);
    }
  }, [bootstrap, rpc, showToast]);

  const loadResyncSnapshot = useCallback(async (threadId: string): Promise<CodexThread> => {
    const readResult = await rpc("thread/read", { threadId, includeTurns: false });
    const thread = extractThread(readResult);
    if (!thread) throw new Error("Codex did not return the requested thread");
    const page = await requestTurnPage(rpc, {
      threadId,
      preferredLimit: TURN_PAGE_SIZE,
    });
    return { ...thread, turns: turnsForDisplay(page, null) };
  }, [rpc]);

  const runResync = useCallback(async () => {
    const coordinator = resyncCoordinatorRef.current;
    if (!coordinator.startCycle()) return;

    setResyncing(true);
    void refreshThreads();
    let restart = false;
    let baseline = currentThreadRef.current;
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        const threadId = selectedThreadIdRef.current;
        const generation = selectionGenerationRef.current;
        if (!threadId) {
          for (const message of coordinator.abort()) applyNotification(message);
          return;
        }

        let snapshot: CodexThread;
        try {
          snapshot = await loadResyncSnapshot(threadId);
        } catch (error) {
          for (const message of coordinator.abort()) applyNotification(message);
          showToast(`Live state refresh failed: ${errorMessage(error)}`);
          return;
        }

        if (
          generation !== selectionGenerationRef.current ||
          selectedThreadIdRef.current !== threadId
        ) {
          for (const message of coordinator.abort()) applyNotification(message);
          return;
        }

        const result = coordinator.finishPass(pass === 0);
        const notifications = filterSnapshotCoveredNotifications(
          baseline,
          snapshot,
          result.notifications,
        );
        dispatch({ type: "reconcileCurrentThread", thread: snapshot });
        for (const message of notifications) applyNotification(message);
        baseline = snapshot;
        if (result.rerun) continue;
        restart = result.restart;
        break;
      }
    } finally {
      setResyncing(coordinator.isBuffering());
      if (restart) setResyncSignal((current) => current + 1);
    }
  }, [applyNotification, loadResyncSnapshot, refreshThreads, showToast]);

  useEffect(() => {
    if (connection !== "connected" || loadingThread) return;
    void runResync();
  }, [connection, loadingThread, resyncSignal, runResync]);

  const loadEarlierTurns = useCallback(async () => {
    const threadId = state.currentThread?.id;
    const cursor = state.turnHistory.threadId === threadId
      ? state.turnHistory.nextCursor
      : null;
    if (!threadId || cursor === null || state.turnHistory.status === "loading") return;

    const requestKey = `${threadId}:${cursor}`;
    if (historyLoadsRef.current.has(requestKey)) return;
    const generation = selectionGenerationRef.current;
    historyLoadsRef.current.add(requestKey);
    dispatch({ type: "loadOlderTurnsStarted", threadId, cursor });
    try {
      const page = await requestTurnPage(rpc, {
        threadId,
        cursor,
        preferredLimit: TURN_PAGE_SIZE,
      });
      if (page.nextCursor === cursor) throw new Error("Codex returned a non-advancing turn cursor");
      if (generation !== selectionGenerationRef.current) return;
      dispatch({
        type: "prependOlderTurns",
        threadId,
        cursor,
        turns: turnsForDisplay(page, cursor),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (generation === selectionGenerationRef.current) {
        dispatch({ type: "loadOlderTurnsFailed", threadId, cursor, error: errorMessage(error) });
      }
    } finally {
      historyLoadsRef.current.delete(requestKey);
    }
  }, [rpc, state.currentThread?.id, state.turnHistory]);

  const loadTurnDetail = useCallback(async (turnId: string) => {
    const thread = state.currentThread;
    const turn = thread?.turns?.find((entry) => entry.id === turnId);
    const detail = turn?.historyDetail;
    if (!thread || !detail || detail.status === "loading") return;

    const { cursor } = detail;
    const requestKey = JSON.stringify([thread.id, turnId, cursor]);
    if (detailLoadsRef.current.has(requestKey)) return;
    const generation = selectionGenerationRef.current;
    detailLoadsRef.current.add(requestKey);
    dispatch({ type: "loadTurnDetailStarted", threadId: thread.id, turnId, cursor });
    try {
      const page = await requestFullTurnPage(rpc, {
        threadId: thread.id,
        ...(cursor !== null ? { cursor } : {}),
      });
      const fullTurn = page.data.find((entry) => entry.id === turnId);
      if (!fullTurn || fullTurn.itemsView !== "full") {
        throw new Error("Codex did not return full detail for this turn");
      }
      if (generation !== selectionGenerationRef.current) return;
      dispatch({
        type: "loadTurnDetailSucceeded",
        threadId: thread.id,
        turnId,
        cursor,
        turn: fullTurn,
      });
    } catch (error) {
      if (generation === selectionGenerationRef.current) {
        dispatch({
          type: "loadTurnDetailFailed",
          threadId: thread.id,
          turnId,
          cursor,
          error: errorMessage(error),
        });
      }
    } finally {
      detailLoadsRef.current.delete(requestKey);
    }
  }, [rpc, state.currentThread]);

  const newThread = useCallback(() => {
    selectionGenerationRef.current += 1;
    selectedThreadIdRef.current = null;
    setLoadingThread(false);
    setThreadLoadError(null);
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
        selectedThreadIdRef.current = thread.id;
        dispatch({ type: "setCurrentThread", thread });
      }
      if (existingThread) {
        const resumed = await rpc("thread/resume", {
          threadId: thread.id,
          excludeTurns: true,
          cwd: state.settings.cwd.trim(),
          approvalPolicy: "on-request",
          ...(state.settings.sandbox === "external" ? {} : { sandbox: state.settings.sandbox }),
          ...(state.settings.model.trim() ? { model: state.settings.model.trim() } : {}),
        });
        const updatedThread = extractThread(resumed);
        if (updatedThread) {
          thread = { ...updatedThread, turns: thread.turns };
          dispatch({ type: "setCurrentThread", thread });
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
    saveStoredToken(nextToken);
    setToken(nextToken);
    setTokenOpen(false);
    setBootstrapError("");
  }, []);

  const requiredToken = Boolean(bootstrap?.authRequired && !token) || bootstrapError.includes("ASK_CODEX_TOKEN");
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
        <Conversation
          thread={state.currentThread}
          loading={loadingThread}
          loadError={threadLoadError}
          historyLoading={state.turnHistory.status === "loading"}
          hasMore={state.turnHistory.nextCursor !== null}
          historyError={state.turnHistory.error}
          onLoadEarlier={() => void loadEarlierTurns()}
          onLoadTurnDetail={(turnId) => void loadTurnDetail(turnId)}
          onRetryThread={() => {
            if (state.selectedThreadId) void selectThread(state.selectedThreadId);
          }}
        />
        <ApprovalPanel
          requests={state.pendingRequests}
          onResolve={resolveRequest}
          onReject={rejectRequest}
        />
        <Composer
          disabled={connection !== "connected" || loadingThread || resyncing || threadLoadError !== null}
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
