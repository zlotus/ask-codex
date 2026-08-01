import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { ActivePlanDock } from "./components/ActivePlanDock";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Sidebar } from "./components/Sidebar";
import { ThreadSettingsDialog } from "./components/ThreadSettingsDialog";
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
  SkillsDirectoryEntry,
  ThreadSettings,
  ToastMessage,
} from "./types/protocol";
import {
  commandApprovalTarget,
  errorMessage,
  extractInitialTurnsPage,
  extractThread,
  extractThreads,
  extractTurn,
  extractModels,
  extractSkillsDirectory,
  isRecord,
  normalizeItem,
  normalizeThread,
  normalizeTurn,
  parsePlan,
  readString,
  sandboxMode,
} from "./utils/protocol";
import { loadStoredToken, saveStoredToken } from "./utils/tokenStorage";
import {
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_IMAGE_PREVIEW_COUNT,
  SessionImagePreviewRegistry,
  sessionImagePreviewKey,
  sessionImagePreviewThreadId,
  type SessionImagePreviewSnapshot,
} from "./utils/sessionImagePreviews";
import { BrowserImagePreviewStore } from "./utils/browserImagePreviewStore";
import { filterSnapshotCoveredNotifications, ResyncCoordinator } from "./utils/resyncCoordinator";
import {
  configuredTurnSettings,
  existingThreadResumeParams,
  newThreadSettings,
  nextTurnOverrides,
  normalizeEffortForModel,
} from "./utils/threadSettings";
import {
  isOversizedHistoryResponseError,
  isThreadItemPaginationUnsupported,
  requestFullTurnPage,
  requestTurnItemPage,
  requestTurnPage,
  resumeThreadForHistory,
  TurnDetailUnavailableError,
} from "./utils/turnHistory";
import {
  discardAttachments,
  uploadImageAttachments,
  type UploadedAttachment,
} from "./utils/attachments";

function threadTitle(thread: CodexThread | null): string {
  return thread?.name?.trim() || thread?.preview?.trim() || (thread ? "Untitled thread" : "New thread");
}

function threadIsActive(thread: CodexThread | undefined): boolean {
  if (!thread) return false;
  if (typeof thread.status === "string") {
    const status = thread.status.toLowerCase();
    return status === "active" || status === "inprogress" || status === "in_progress";
  }
  return thread.status?.type === "active";
}

function paramsRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

const TURN_PAGE_SIZE = 10;
const TURN_ITEM_PAGE_SIZE = 10;
const MAX_REASONING_PARTS = 16;
const MAX_PENDING_CANONICAL_THREADS = 8;
const MAX_SKILLS_PROJECT_CWDS = 16;
const THREAD_HYDRATION_RETRY_DELAYS_MS = [0, 250, 1_000] as const;

interface SkillsProjectSelection {
  cwds: string[];
  truncated: boolean;
}

function unavailableSkillsCwdIndex(error: unknown, cwdCount: number): number | null {
  const match = /^skills\/list cwds\[(\d+)\] (?:does not exist|must be a directory)$/
    .exec(errorMessage(error));
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index >= 0 && index < cwdCount ? index : null;
}

interface ThreadDialogState {
  mode: "new" | "existing";
  settings: ThreadSettings;
}

interface PendingImagePreviewGroup {
  blobs: readonly Blob[];
  byteSize: number;
}

type NextTurnSettings = Pick<ThreadSettings, "model" | "effort">;

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

function rememberPendingCanonicalThread(threadIds: Set<string>, threadId: string): void {
  threadIds.delete(threadId);
  threadIds.add(threadId);
  while (threadIds.size > MAX_PENDING_CANONICAL_THREADS) {
    const oldest = threadIds.values().next().value as string | undefined;
    if (oldest === undefined) break;
    threadIds.delete(oldest);
  }
}

function queuePendingImagePreview(
  groups: Map<string, PendingImagePreviewGroup>,
  key: string,
  blobs: readonly Blob[],
): void {
  groups.delete(key);
  groups.set(key, {
    blobs,
    byteSize: blobs.reduce((total, blob) => total + blob.size, 0),
  });
  let imageCount = [...groups.values()]
    .reduce((total, group) => total + group.blobs.length, 0);
  let byteSize = [...groups.values()]
    .reduce((total, group) => total + group.byteSize, 0);
  while (imageCount > MAX_IMAGE_PREVIEW_COUNT || byteSize > MAX_IMAGE_PREVIEW_BYTES) {
    const oldestKey = groups.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = groups.get(oldestKey)!;
    groups.delete(oldestKey);
    imageCount -= oldest.blobs.length;
    byteSize -= oldest.byteSize;
  }
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
  const [skillsDirectory, setSkillsDirectory] = useState<SkillsDirectoryEntry[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillsInvalidationSignal, setSkillsInvalidationSignal] = useState(0);
  const [loadingThread, setLoadingThread] = useState(false);
  const [threadLoadError, setThreadLoadError] = useState<string | null>(null);
  const [resyncSignal, setResyncSignal] = useState(0);
  const [resyncing, setResyncing] = useState(false);
  const [threadHydrationSignal, setThreadHydrationSignal] = useState(0);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [nextTurnSettings, setNextTurnSettings] = useState<NextTurnSettings>({ model: "", effort: "" });
  const [configuredDefaults, setConfiguredDefaults] = useState<NextTurnSettings>({ model: "", effort: "" });
  const [threadDialog, setThreadDialog] = useState<ThreadDialogState | null>(null);
  const [draftThreadConfigured, setDraftThreadConfigured] = useState(false);
  const [sandboxOverride, setSandboxOverride] = useState<ThreadSettings["sandbox"] | null>(null);
  const [imagePreviews, setImagePreviews] = useState<SessionImagePreviewSnapshot>({});
  const toastIdRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const selectedThreadIdRef = useRef<string | null>(state.selectedThreadId);
  const currentThreadRef = useRef<CodexThread | null>(state.currentThread);
  const historyLoadsRef = useRef(new Set<string>());
  const detailLoadsRef = useRef(new Set<string>());
  const resyncCoordinatorRef = useRef(new ResyncCoordinator());
  const bootstrapCwdInitializedRef = useRef(false);
  const nextTurnSettingsInitializedRef = useRef(false);
  const settingsLoadGenerationRef = useRef(0);
  const threadListRefreshGenerationRef = useRef(0);
  const threadListMutationEpochRef = useRef(0);
  const skillsLoadGenerationRef = useRef(0);
  const skillsLoadedRef = useRef(false);
  const handledSkillsInvalidationRef = useRef(0);
  const pendingCanonicalThreadIdsRef = useRef(new Set<string>());
  const imagePreviewsMountedRef = useRef(false);
  const imagePreviewRegistryRef = useRef<SessionImagePreviewRegistry | null>(null);
  const imagePreviewStoreRef = useRef<BrowserImagePreviewStore | null>(null);
  const imagePreviewHydratedRef = useRef(false);
  const pendingImagePreviewGroupsRef = useRef(new Map<string, PendingImagePreviewGroup>());
  const removedImagePreviewThreadIdsRef = useRef(new Set<string>());
  if (imagePreviewRegistryRef.current === null) {
    imagePreviewRegistryRef.current = new SessionImagePreviewRegistry();
  }
  const composerSettings = useMemo<ThreadSettings>(
    () => ({ ...state.settings, ...nextTurnSettings }),
    [nextTurnSettings, state.settings],
  );
  const projectCwdsKey = useMemo(() => {
    const seen = new Set<string>();
    const cwds: string[] = [];
    let truncated = false;
    const add = (value: string | undefined): void => {
      const cwd = value?.trim();
      if (!cwd || seen.has(cwd)) return;
      seen.add(cwd);
      if (cwds.length < MAX_SKILLS_PROJECT_CWDS) cwds.push(cwd);
      else truncated = true;
    };
    add(state.settings.cwd);
    add(state.currentThread?.cwd);
    for (const thread of state.threads) add(thread.cwd);
    for (const thread of state.archivedThreads) add(thread.cwd);
    add(bootstrap?.defaultCwd);
    return JSON.stringify({ cwds, truncated });
  }, [
    bootstrap?.defaultCwd,
    state.archivedThreads,
    state.currentThread?.cwd,
    state.settings.cwd,
    state.threads,
  ]);
  const projectSelection = useMemo<SkillsProjectSelection>(
    () => JSON.parse(projectCwdsKey) as SkillsProjectSelection,
    [projectCwdsKey],
  );
  const projectCwds = projectSelection.cwds;

  useEffect(() => {
    selectedThreadIdRef.current = state.selectedThreadId;
    currentThreadRef.current = state.currentThread;
  }, [state.currentThread, state.selectedThreadId]);

  useEffect(() => {
    const registry = imagePreviewRegistryRef.current!;
    const store = new BrowserImagePreviewStore();
    const pendingGroups = pendingImagePreviewGroupsRef.current;
    let active = true;

    registry.clear();
    setImagePreviews(registry.snapshot());
    imagePreviewsMountedRef.current = true;
    imagePreviewHydratedRef.current = false;
    pendingGroups.clear();
    imagePreviewStoreRef.current = store;
    void (async () => {
      let entries: Awaited<ReturnType<BrowserImagePreviewStore["loadAll"]>> | null = null;
      try {
        entries = await store.loadAll();
      } catch {
        // Browser storage is optional; current-page previews remain in memory.
      }
      if (!active) return;

      const pending = [...pendingGroups];
      if (entries) {
        registry.clear();
        for (const entry of entries) {
          const threadId = sessionImagePreviewThreadId(entry.key);
          if (threadId && !removedImagePreviewThreadIdsRef.current.has(threadId)) {
            registry.remember(entry.key, entry.blobs);
          }
        }
        for (const [key, group] of pending) {
          const threadId = sessionImagePreviewThreadId(key);
          if (threadId && !removedImagePreviewThreadIdsRef.current.has(threadId)) {
            registry.remember(key, group.blobs);
          }
        }
        setImagePreviews(registry.snapshot());
      }
      pendingGroups.clear();
      imagePreviewHydratedRef.current = true;
      for (const [key, group] of pending) {
        const threadId = sessionImagePreviewThreadId(key);
        if (!threadId || removedImagePreviewThreadIdsRef.current.has(threadId)) continue;
        void store.remember(key, group.blobs).catch(() => {
          // A local preview write never changes the accepted Codex turn.
        });
      }
    })();

    return () => {
      active = false;
      imagePreviewsMountedRef.current = false;
      if (imagePreviewStoreRef.current === store) {
        imagePreviewStoreRef.current = null;
        imagePreviewHydratedRef.current = false;
        pendingGroups.clear();
      }
      store.close();
      registry.clear();
    };
  }, []);

  const rememberImagePreviews = useCallback((
    threadId: string,
    turnId: string,
    images: readonly File[],
    attachments: readonly UploadedAttachment[],
  ): void => {
    const registry = imagePreviewRegistryRef.current;
    if (!registry || !imagePreviewsMountedRef.current || images.length === 0) return;
    try {
      const previewBlobs = images.map((image, index) => (
        image.slice(0, image.size, attachments[index]?.mediaType ?? image.type)
      ));
      const key = sessionImagePreviewKey(threadId, turnId);
      setImagePreviews(registry.remember(key, previewBlobs));
      if (!imagePreviewHydratedRef.current) {
        queuePendingImagePreview(pendingImagePreviewGroupsRef.current, key, previewBlobs);
        return;
      }
      void imagePreviewStoreRef.current?.remember(key, previewBlobs).catch(() => {
        // A local preview write never changes the accepted Codex turn.
      });
    } catch {
      // Object URL and Blob failures fall back to the existing image placeholder.
    }
  }, []);

  const showToast = useCallback((message: string, tone: ToastMessage["tone"] = "error") => {
    const id = ++toastIdRef.current;
    dispatch({ type: "toast", toast: { id, tone, message } });
    window.setTimeout(() => dispatch({ type: "removeToast", id }), 5_500);
  }, []);

  const removeImagePreviewsForThread = useCallback((threadId: string): void => {
    removedImagePreviewThreadIdsRef.current.add(threadId);
    for (const key of [...pendingImagePreviewGroupsRef.current.keys()]) {
      if (sessionImagePreviewThreadId(key) === threadId) {
        pendingImagePreviewGroupsRef.current.delete(key);
      }
    }
    const registry = imagePreviewRegistryRef.current;
    if (registry && imagePreviewsMountedRef.current) {
      setImagePreviews(registry.removeThread(threadId));
    }
    void imagePreviewStoreRef.current?.removeThread(threadId).catch(() => {
      // The Codex thread is already deleted; local preview cleanup is best-effort.
    });
  }, []);

  const invalidateSelectedThread = useCallback((threadId: string): void => {
    if (
      selectedThreadIdRef.current !== threadId &&
      currentThreadRef.current?.id !== threadId
    ) {
      return;
    }
    selectionGenerationRef.current += 1;
    selectedThreadIdRef.current = null;
    currentThreadRef.current = null;
    setLoadingThread(false);
    setThreadLoadError(null);
    setSandboxOverride(null);
    setThreadDialog(null);
  }, []);

  const applyNotification = useCallback((message: NotificationMessage) => {
    const params = paramsRecord(message.params);
    const threadId = readString(params.threadId);
    const turnId = readString(params.turnId);
    const itemId = readString(params.itemId);

    switch (message.method) {
      case "thread/started": {
        const thread = normalizeThread(params.thread);
        if (thread) {
          threadListMutationEpochRef.current += 1;
          rememberPendingCanonicalThread(pendingCanonicalThreadIdsRef.current, thread.id);
          dispatch({ type: "upsertThread", thread });
        }
        return;
      }
      case "thread/name/updated": {
        const name = readString(params.threadName) ?? readString(params.name);
        if (threadId) {
          threadListMutationEpochRef.current += 1;
          dispatch({
            type: "updateThreadMetadata",
            threadId,
            metadata: { name },
          });
          setThreadHydrationSignal((current) => current + 1);
        }
        return;
      }
      case "thread/status/changed": {
        if (threadId) dispatch({ type: "upsertThread", thread: { id: threadId, status: params.status as CodexThread["status"] } });
        return;
      }
      case "thread/archived": {
        if (threadId) {
          threadListMutationEpochRef.current += 1;
          pendingCanonicalThreadIdsRef.current.delete(threadId);
          invalidateSelectedThread(threadId);
          dispatch({ type: "archiveThread", threadId });
        }
        return;
      }
      case "thread/unarchived": {
        if (threadId) {
          threadListMutationEpochRef.current += 1;
          dispatch({ type: "unarchiveThread", threadId });
        }
        return;
      }
      case "thread/deleted": {
        if (threadId) {
          threadListMutationEpochRef.current += 1;
          pendingCanonicalThreadIdsRef.current.delete(threadId);
          invalidateSelectedThread(threadId);
          removeImagePreviewsForThread(threadId);
          dispatch({ type: "deleteThread", threadId });
        }
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
        if (threadId) setThreadHydrationSignal((current) => current + 1);
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
  }, [invalidateSelectedThread, removeImagePreviewsForThread]);

  const onNotification = useCallback((message: NotificationMessage) => {
    if (message.method === "skills/changed") {
      if (skillsLoadedRef.current) {
        setSkillsInvalidationSignal((current) => current + 1);
      }
      return;
    }
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
      dispatch({ type: "clearActiveReasoningItems" });
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
    const params = paramsRecord(message.params);
    const approvalTarget = commandApprovalTarget(message.method, params);
    if (approvalTarget) {
      dispatch({
        type: "recordCommandApprovalReason",
        ...approvalTarget,
      });
    }
    dispatch({
      type: "addRequest",
      request: {
        id: message.id,
        method: message.method,
        params,
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

  useEffect(() => {
    if (connection !== "connected") dispatch({ type: "clearActiveReasoningItems" });
  }, [connection]);

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
      if (!bootstrapCwdInitializedRef.current) {
        bootstrapCwdInitializedRef.current = true;
        dispatch({ type: "settings", settings: { cwd: info.defaultCwd } });
      }
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
    if (connection !== "connected") return false;
    const generation = ++threadListRefreshGenerationRef.current;
    const mutationEpoch = threadListMutationEpochRef.current;
    setLoadingThreads(true);
    try {
      const listThreads = async (archived: boolean): Promise<CodexThread[]> => {
        const threads: CodexThread[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 50; page += 1) {
          const result = await rpc("thread/list", {
            limit: 100,
            sortKey: "recency_at",
            sortDirection: "desc",
            sourceKinds: [],
            archived,
            ...(cursor !== undefined ? { cursor } : {}),
          });
          threads.push(...extractThreads(result));
          const nextCursor = isRecord(result) ? readString(result.nextCursor) : undefined;
          if (nextCursor === undefined || seenCursors.has(nextCursor)) break;
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        return threads;
      };
      const [threads, archivedThreads] = await Promise.all([
        listThreads(false),
        listThreads(true),
      ]);
      if (
        generation !== threadListRefreshGenerationRef.current ||
        mutationEpoch !== threadListMutationEpochRef.current
      ) {
        return false;
      }
      const canonicalThreadIds = new Set([
        ...threads.map((thread) => thread.id),
        ...archivedThreads.map((thread) => thread.id),
      ]);
      for (const threadId of pendingCanonicalThreadIdsRef.current) {
        if (canonicalThreadIds.has(threadId)) {
          pendingCanonicalThreadIdsRef.current.delete(threadId);
        }
      }
      dispatch({
        type: "setThreads",
        threads,
        protectedThreadIds: [...pendingCanonicalThreadIdsRef.current],
      });
      dispatch({ type: "setArchivedThreads", threads: archivedThreads });
      return true;
    } catch (error) {
      if (generation === threadListRefreshGenerationRef.current) {
        showToast(errorMessage(error));
      }
      return false;
    } finally {
      if (generation === threadListRefreshGenerationRef.current) {
        setLoadingThreads(false);
      }
    }
  }, [connection, rpc, showToast]);

  const loadSkillsDirectory = useCallback(async (forceReload = false) => {
    if (connection !== "connected") return;
    const generation = ++skillsLoadGenerationRef.current;
    skillsLoadedRef.current = true;
    setSkillsLoaded(true);
    setLoadingSkills(true);
    setSkillsError(null);
    try {
      const unavailableCwds = new Set<string>();
      let remainingCwds = [...projectCwds];
      let directory: SkillsDirectoryEntry[] = [];

      while (true) {
        try {
          const result = await rpc("skills/list", {
            cwds: remainingCwds,
            ...(forceReload ? { forceReload: true } : {}),
          });
          directory = extractSkillsDirectory(result);
          break;
        } catch (error) {
          const unavailableIndex = unavailableSkillsCwdIndex(error, remainingCwds.length);
          if (unavailableIndex === null) throw error;
          unavailableCwds.add(remainingCwds[unavailableIndex]);
          remainingCwds = remainingCwds.filter((_, index) => index !== unavailableIndex);
          if (remainingCwds.length === 0 || generation !== skillsLoadGenerationRef.current) break;
        }
      }

      if (generation !== skillsLoadGenerationRef.current) return;
      setSkillsError(null);
      if (projectCwds.length === 0) {
        setSkillsDirectory(directory);
      } else {
        const directoryByCwd = new Map(directory.map((entry) => [entry.cwd, entry]));
        setSkillsDirectory(projectCwds.flatMap((cwd) => {
          if (unavailableCwds.has(cwd)) {
            return [{ cwd, skills: [], errorCount: 1 }];
          }
          const entry = directoryByCwd.get(cwd);
          return entry ? [entry] : [];
        }));
      }
    } catch (error) {
      if (generation === skillsLoadGenerationRef.current) {
        setSkillsError("Skills could not be loaded");
        showToast(`Could not load Skills: ${errorMessage(error)}`);
      }
    } finally {
      if (generation === skillsLoadGenerationRef.current) {
        setLoadingSkills(false);
      }
    }
  }, [connection, projectCwds, rpc, showToast]);

  useEffect(() => {
    if (
      connection !== "connected" ||
      !skillsLoadedRef.current ||
      skillsInvalidationSignal !== handledSkillsInvalidationRef.current
    ) {
      return;
    }
    void loadSkillsDirectory();
  }, [connection, loadSkillsDirectory, skillsInvalidationSignal]);

  useEffect(() => {
    if (
      connection !== "connected" ||
      skillsInvalidationSignal === 0 ||
      skillsInvalidationSignal === handledSkillsInvalidationRef.current ||
      !skillsLoadedRef.current
    ) {
      return;
    }
    handledSkillsInvalidationRef.current = skillsInvalidationSignal;
    void loadSkillsDirectory(true);
  }, [connection, loadSkillsDirectory, skillsInvalidationSignal]);

  useEffect(() => {
    if (connection !== "connected" || threadHydrationSignal === 0) return;
    let cancelled = false;
    let timer: number | undefined;
    const runAttempt = (attempt: number): void => {
      timer = window.setTimeout(() => {
        void refreshThreads().then((applied) => {
          const nextAttempt = attempt + 1;
          if (
            cancelled ||
            !applied ||
            pendingCanonicalThreadIdsRef.current.size === 0 ||
            nextAttempt >= THREAD_HYDRATION_RETRY_DELAYS_MS.length
          ) {
            return;
          }
          runAttempt(nextAttempt);
        });
      }, THREAD_HYDRATION_RETRY_DELAYS_MS[attempt]);
    };
    runAttempt(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [connection, refreshThreads, threadHydrationSignal]);

  useEffect(() => {
    if (connection !== "connected") return;
    const generation = ++settingsLoadGenerationRef.current;
    const timer = window.setTimeout(() => {
      void refreshThreads();
      void Promise.allSettled([
        rpc("model/list", { limit: 100 }),
        rpc("config/read", {}),
      ]).then(([modelResult, configResult]) => {
        if (generation !== settingsLoadGenerationRef.current) return;
        const nextModels = modelResult.status === "fulfilled" ? extractModels(modelResult.value) : [];
        setModels(nextModels);
        if (configResult.status === "rejected") {
          showToast(`Could not load configured model settings: ${errorMessage(configResult.reason)}`);
          return;
        }
        const defaults = configuredTurnSettings(configResult.value, nextModels);
        setConfiguredDefaults(defaults);
        if (
          !nextTurnSettingsInitializedRef.current &&
          (defaults.model.length > 0 || defaults.effort.length > 0)
        ) {
          nextTurnSettingsInitializedRef.current = true;
          setNextTurnSettings(defaults);
        }
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (settingsLoadGenerationRef.current === generation) {
        settingsLoadGenerationRef.current += 1;
      }
    };
  }, [connection, refreshThreads, rpc, showToast]);

  const selectThread = useCallback(async (threadId: string) => {
    const generation = ++selectionGenerationRef.current;
    nextTurnSettingsInitializedRef.current = true;
    selectedThreadIdRef.current = threadId;
    setDraftThreadConfigured(false);
    setSandboxOverride(null);
    setThreadDialog(null);
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
      const model = readString(resumeRecord.model) ?? thread.model ?? configuredDefaults.model;
      const resumedEffort = readString(resumeRecord.effort) ?? readString(resumeRecord.reasoningEffort);
      const effort = resumedEffort ?? (model === configuredDefaults.model
        ? configuredDefaults.effort
        : normalizeEffortForModel(models, model, ""));
      setNextTurnSettings({ model, effort });
      dispatch({
        type: "settings",
        settings: {
          cwd: readString(resumeRecord.cwd) ?? thread.cwd ?? bootstrap?.defaultCwd ?? "",
          model,
          effort,
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
  }, [bootstrap, configuredDefaults, models, rpc, showToast]);

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
    if (
      !thread ||
      !detail ||
      turn.status === "inProgress" ||
      detail.status === "loading" ||
      detail.status === "unavailable"
    ) return;

    const { cursor, nextItemCursor: itemCursor } = detail;
    const requestKey = JSON.stringify([thread.id, turnId, cursor, itemCursor ?? null]);
    if (detailLoadsRef.current.has(requestKey)) return;
    const generation = selectionGenerationRef.current;
    detailLoadsRef.current.add(requestKey);
    dispatch({ type: "loadTurnDetailStarted", threadId: thread.id, turnId, cursor, itemCursor });
    try {
      let itemPaginationUnsupported = thread.historyMode === "legacy";
      if (!itemPaginationUnsupported) {
        try {
          const page = await requestTurnItemPage(rpc, {
            threadId: thread.id,
            turnId,
            ...(itemCursor !== undefined ? { cursor: itemCursor } : {}),
            preferredLimit: TURN_ITEM_PAGE_SIZE,
          });
          if (generation !== selectionGenerationRef.current) return;
          dispatch({
            type: "loadTurnItemPageSucceeded",
            threadId: thread.id,
            turnId,
            cursor,
            itemCursor,
            items: page.data.map((entry) => entry.item),
            nextItemCursor: page.nextCursor,
          });
          return;
        } catch (error) {
          if (!isThreadItemPaginationUnsupported(error)) throw error;
          itemPaginationUnsupported = true;
        }
      }

      let fullPage: CodexTurnsPage;
      try {
        fullPage = await requestFullTurnPage(rpc, {
          threadId: thread.id,
          ...(cursor !== null ? { cursor } : {}),
        });
      } catch (error) {
        if (itemPaginationUnsupported && isOversizedHistoryResponseError(error)) {
          throw new TurnDetailUnavailableError(
            "This legacy Codex thread cannot load item pages, and its full detail exceeds the gateway limit",
            { cause: error },
          );
        }
        throw error;
      }
      const fullTurn = fullPage.data.find((entry) => entry.id === turnId);
      if (!fullTurn || fullTurn.itemsView !== "full") {
        throw new Error("Codex did not return full detail for this turn");
      }
      if (generation !== selectionGenerationRef.current) return;
      dispatch({
        type: "loadTurnDetailSucceeded",
        threadId: thread.id,
        turnId,
        cursor,
        itemCursor,
        turn: fullTurn,
      });
    } catch (error) {
      if (generation === selectionGenerationRef.current) {
        dispatch({
          type: "loadTurnDetailFailed",
          threadId: thread.id,
          turnId,
          cursor,
          itemCursor,
          error: errorMessage(error),
          unavailable: error instanceof TurnDetailUnavailableError,
        });
      }
    } finally {
      detailLoadsRef.current.delete(requestKey);
    }
  }, [rpc, state.currentThread]);

  const openNewThread = useCallback(() => {
    const defaults = {
      ...composerSettings,
      model: configuredDefaults.model || composerSettings.model,
      effort: configuredDefaults.effort || composerSettings.effort,
    };
    setThreadDialog({
      mode: "new",
      settings: newThreadSettings(bootstrap?.defaultCwd ?? "", defaults),
    });
    setSidebarOpen(false);
  }, [bootstrap?.defaultCwd, composerSettings, configuredDefaults]);

  const openThreadSettings = useCallback(() => {
    setThreadDialog({
      mode: state.currentThread || draftThreadConfigured ? "existing" : "new",
      settings: composerSettings.sandbox === "external" && !state.currentThread && !draftThreadConfigured
        ? { ...composerSettings, sandbox: "workspace-write" }
        : composerSettings,
    });
  }, [composerSettings, draftThreadConfigured, state.currentThread]);

  const confirmThreadSettings = useCallback((settings: ThreadSettings) => {
    if (threadDialog?.mode === "new") {
      selectionGenerationRef.current += 1;
      selectedThreadIdRef.current = null;
      setLoadingThread(false);
      setThreadLoadError(null);
      setDraftThreadConfigured(true);
      setSandboxOverride(null);
      nextTurnSettingsInitializedRef.current = true;
      setNextTurnSettings({ model: settings.model, effort: settings.effort });
      dispatch({ type: "selectThread", threadId: null });
      dispatch({ type: "settings", settings });
      setSidebarOpen(false);
    } else if (
      threadDialog?.mode === "existing" &&
      state.settings.sandbox !== "external" &&
      settings.sandbox !== state.settings.sandbox
    ) {
      dispatch({ type: "settings", settings: { sandbox: settings.sandbox } });
      setSandboxOverride(state.currentThread ? settings.sandbox : null);
    }
    setThreadDialog(null);
  }, [state.currentThread, state.settings.sandbox, threadDialog?.mode]);

  const sendMessage = useCallback(async (text: string, images: readonly File[]) => {
    const selectionGeneration = selectionGenerationRef.current;
    let thread = state.currentThread;
    const existingThread = Boolean(thread);
    const cwd = state.settings.cwd.trim();
    let uploaded: UploadedAttachment[] = [];
    let turnAccepted = false;
    const assertSelectionUnchanged = (): void => {
      if (selectionGeneration !== selectionGenerationRef.current) {
        throw new Error("Thread changed while preparing the message; nothing was sent");
      }
    };
    try {
      if (!cwd) throw new Error("Choose an absolute working directory first");
      uploaded = await uploadImageAttachments(images, token);
      assertSelectionUnchanged();
      if (!thread) {
        const result = await rpc("thread/start", {
          cwd,
          approvalPolicy: "on-request",
          sandbox: state.settings.sandbox === "external" ? "workspace-write" : state.settings.sandbox,
          ...(nextTurnSettings.model.trim() ? { model: nextTurnSettings.model.trim() } : {}),
        });
        assertSelectionUnchanged();
        thread = extractThread(result);
        if (!thread) throw new Error("Codex did not return a new thread");
        setDraftThreadConfigured(false);
        threadListMutationEpochRef.current += 1;
        rememberPendingCanonicalThread(pendingCanonicalThreadIdsRef.current, thread.id);
        selectedThreadIdRef.current = thread.id;
        currentThreadRef.current = thread;
        dispatch({ type: "setCurrentThread", thread });
      }
      if (existingThread) {
        const resumed = await rpc(
          "thread/resume",
          existingThreadResumeParams(thread.id, sandboxOverride, state.settings.sandbox),
        );
        assertSelectionUnchanged();
        if (sandboxOverride) setSandboxOverride(null);
        const updatedThread = extractThread(resumed);
        if (updatedThread) {
          thread = { ...updatedThread, turns: thread.turns };
          dispatch({ type: "setCurrentThread", thread });
        }
      }
      assertSelectionUnchanged();
      const result = await rpc("turn/start", {
        threadId: thread.id,
        input: [
          ...(text ? [{ type: "text", text, text_elements: [] }] : []),
          ...uploaded.map((attachment) => ({
            type: "localImage",
            attachmentId: attachment.id,
          })),
        ],
        cwd,
        ...nextTurnOverrides(nextTurnSettings),
      });
      turnAccepted = true;
      const turn = extractTurn(result);
      if (turn) rememberImagePreviews(thread.id, turn.id, images, uploaded);
      if (turn && selectionGeneration === selectionGenerationRef.current) {
        dispatch({ type: "upsertTurn", turn, threadId: thread.id });
      }
      void refreshThreads();
    } catch (error) {
      if (!turnAccepted && uploaded.length > 0) {
        void discardAttachments(uploaded, token);
      }
      throw error;
    }
  }, [nextTurnSettings, refreshThreads, rememberImagePreviews, rpc, sandboxOverride, state.currentThread, state.settings, token]);

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

  const isThreadActive = useCallback((threadId: string): boolean => {
    const thread = state.threads.find((entry) => entry.id === threadId)
      ?? state.archivedThreads.find((entry) => entry.id === threadId);
    return threadIsActive(thread) || (
      state.currentThread?.id === threadId && Boolean(state.activeTurnId)
    );
  }, [state.activeTurnId, state.archivedThreads, state.currentThread?.id, state.threads]);

  const renameThread = useCallback(async (threadId: string, requestedName: string) => {
    const name = requestedName.trim();
    if (!name) return;
    try {
      await rpc("thread/name/set", { threadId, name });
      threadListMutationEpochRef.current += 1;
      dispatch({ type: "updateThreadMetadata", threadId, metadata: { name } });
      showToast("Thread renamed", "success");
    } catch (error) {
      showToast(errorMessage(error));
    }
  }, [rpc, showToast]);

  const setThreadPinned = useCallback(async (threadId: string, isPinned: boolean) => {
    try {
      const result = await rpc("thread/metadata/update", { threadId, isPinned });
      const returnedThread = extractThread(result);
      const nextPinned = returnedThread?.isPinned ?? isPinned;
      threadListMutationEpochRef.current += 1;
      dispatch({
        type: "updateThreadMetadata",
        threadId,
        metadata: { isPinned: nextPinned },
      });
      showToast(nextPinned ? "Thread pinned" : "Thread unpinned", "success");
    } catch (error) {
      showToast(errorMessage(error));
    }
  }, [rpc, showToast]);

  const archiveThread = useCallback(async (threadId: string) => {
    if (isThreadActive(threadId)) {
      showToast("Active threads cannot be archived");
      return;
    }
    try {
      await rpc("thread/archive", { threadId });
      threadListMutationEpochRef.current += 1;
      pendingCanonicalThreadIdsRef.current.delete(threadId);
      invalidateSelectedThread(threadId);
      dispatch({ type: "archiveThread", threadId });
      showToast("Thread archived", "success");
    } catch (error) {
      showToast(errorMessage(error));
    }
  }, [invalidateSelectedThread, isThreadActive, rpc, showToast]);

  const unarchiveThread = useCallback(async (threadId: string) => {
    try {
      await rpc("thread/unarchive", { threadId });
      threadListMutationEpochRef.current += 1;
      dispatch({ type: "unarchiveThread", threadId });
      showToast("Thread restored", "success");
    } catch (error) {
      showToast(errorMessage(error));
    }
  }, [rpc, showToast]);

  const deleteThread = useCallback(async (threadId: string) => {
    if (isThreadActive(threadId)) {
      showToast("Active threads cannot be deleted");
      return;
    }
    try {
      await rpc("thread/delete", { threadId });
      threadListMutationEpochRef.current += 1;
      pendingCanonicalThreadIdsRef.current.delete(threadId);
      invalidateSelectedThread(threadId);
      removeImagePreviewsForThread(threadId);
      dispatch({ type: "deleteThread", threadId });
      showToast("Thread permanently deleted", "success");
    } catch (error) {
      showToast(errorMessage(error));
    }
  }, [invalidateSelectedThread, isThreadActive, removeImagePreviewsForThread, rpc, showToast]);

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
  const activeTurn = state.activeTurnId && state.currentThread?.id === state.selectedThreadId
    ? state.currentThread.turns?.find((turn) => (
        turn.id === state.activeTurnId && turn.status === "inProgress"
      ))
    : undefined;
  const activePlan = activeTurn?.plan?.plan.length ? activeTurn.plan : undefined;

  return (
    <div className="app-shell">
      <Sidebar
        threads={state.threads}
        archivedThreads={state.archivedThreads}
        selectedThreadId={state.selectedThreadId}
        search={search}
        open={sidebarOpen}
        loading={loadingThreads}
        connection={connection}
        skills={skillsDirectory}
        skillsLoading={loadingSkills}
        skillsLoaded={skillsLoaded}
        skillsError={skillsError}
        skillsTruncated={projectSelection.truncated}
        isThreadActive={isThreadActive}
        onSearch={setSearch}
        onSelect={(threadId) => void selectThread(threadId)}
        onArchive={(threadId) => void archiveThread(threadId)}
        onUnarchive={(threadId) => void unarchiveThread(threadId)}
        onDelete={(threadId) => void deleteThread(threadId)}
        onRename={(threadId, name) => void renameThread(threadId, name)}
        onPin={(threadId, isPinned) => void setThreadPinned(threadId, isPinned)}
        onNew={openNewThread}
        onRefresh={(view) => {
          if (view === "skills") void loadSkillsDirectory(true);
          else void refreshThreads();
        }}
        onSkillsView={() => void loadSkillsDirectory()}
        onClose={() => setSidebarOpen(false)}
        onToken={() => setTokenOpen(true)}
      />
      <section className="workspace">
        <Toolbar
          settings={state.settings}
          title={title}
          connection={connection}
          connectionDetail={bootstrapError || connectionDetail}
          running={Boolean(state.activeTurnId)}
          onSettings={openThreadSettings}
          onMenu={() => setSidebarOpen(true)}
        />
        <Conversation
          thread={state.currentThread}
          activeReasoningItemIdsByTurn={state.activeReasoningItemIdsByTurn}
          loading={loadingThread}
          loadError={threadLoadError}
          historyLoading={state.turnHistory.status === "loading"}
          hasMore={state.turnHistory.nextCursor !== null}
          historyError={state.turnHistory.error}
          imagePreviews={imagePreviews}
          onLoadEarlier={() => void loadEarlierTurns()}
          onLoadTurnDetail={(turnId) => void loadTurnDetail(turnId)}
          onRetryThread={() => {
            if (state.selectedThreadId) void selectThread(state.selectedThreadId);
          }}
        />
        {activeTurn && activePlan && (
          <ActivePlanDock
            key={activeTurn.id}
            plan={activePlan}
            updateUnavailable={activeTurn.recoveryOmissions?.includes("turn/plan/updated")}
          />
        )}
        <ApprovalPanel
          requests={state.pendingRequests}
          onResolve={resolveRequest}
          onReject={rejectRequest}
        />
        <Composer
          disabled={connection !== "connected" || loadingThread || resyncing || threadLoadError !== null}
          running={Boolean(state.activeTurnId)}
          settings={composerSettings}
          models={models}
          onSettingsChange={(settings) => {
            nextTurnSettingsInitializedRef.current = true;
            setNextTurnSettings((current) => ({
              model: settings.model ?? current.model,
              effort: settings.effort ?? current.effort,
            }));
          }}
          onSend={sendMessage}
          onStop={stopTurn}
        />
      </section>
      {threadDialog && (
        <ThreadSettingsDialog
          key={`${threadDialog.mode}:${threadDialog.settings.cwd}:${threadDialog.settings.sandbox}`}
          open
          mode={threadDialog.mode}
          settings={threadDialog.settings}
          running={Boolean(state.activeTurnId)}
          onConfirm={confirmThreadSettings}
          onClose={() => setThreadDialog(null)}
        />
      )}
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
