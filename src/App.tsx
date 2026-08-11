import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { ActivePlanDock } from "./components/ActivePlanDock";
import { Composer } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { MessageQueueDock } from "./components/MessageQueueDock";
import { Sidebar } from "./components/Sidebar";
import { ThreadSettingsDialog } from "./components/ThreadSettingsDialog";
import { Toasts } from "./components/Toasts";
import { TokenDialog } from "./components/TokenDialog";
import { Toolbar } from "./components/Toolbar";
import { UsageDialog } from "./components/UsageDialog";
import { useCodexSocket } from "./hooks/useCodexSocket";
import { appReducer, initialState } from "./state/appReducer";
import type {
  AccountRateLimitsSnapshot,
  AccountUsageSnapshot,
  BootstrapInfo,
  CodexThread,
  CodexTurn,
  CodexTurnsPage,
  ModelInfo,
  MessageQueueItem,
  NotificationMessage,
  ServerRequestMessage,
  SkillsDirectoryEntry,
  ThreadActivityEvent,
  ThreadSettings,
  ThreadTokenUsage,
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
  parsePlanRevision,
  readString,
  sandboxMode,
} from "./utils/protocol";
import { loadStoredToken, saveStoredToken } from "./utils/tokenStorage";
import {
  activityEventFromNotification,
  extractAccountRateLimits,
  extractAccountUsage,
  extractThreadTokenUsage,
  mergeAccountRateLimitUpdate,
} from "./utils/monitoring";
import {
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_IMAGE_PREVIEW_COUNT,
  SessionImagePreviewRegistry,
  sessionImagePreviewKey,
  sessionImagePreviewThreadId,
  type SessionImagePreviewSnapshot,
} from "./utils/sessionImagePreviews";
import { BrowserImagePreviewStore } from "./utils/browserImagePreviewStore";
import { BrowserFileAttachmentStore } from "./utils/browserFileAttachmentStore";
import {
  MAX_LOCAL_FILE_BYTES,
  MAX_LOCAL_FILE_COUNT,
  SessionFileAttachmentRegistry,
  sessionFileAttachmentKey,
  sessionFileAttachmentThreadId,
  type LocalFileAttachment,
  type SessionFileAttachmentSnapshot,
} from "./utils/sessionFileAttachments";
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
  discardFileAttachments,
  MAX_ATTACHMENTS_PER_TURN,
  uploadFileAttachments,
  uploadImageAttachments,
  type UploadedAttachment,
  type UploadedFileAttachment,
} from "./utils/attachments";
import { downloadFileCapability } from "./utils/fileDownloads";
import {
  extractMessageQueueItem,
  extractMessageQueueSnapshot,
} from "./utils/messageQueue";

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
const MAX_THREAD_USAGE_SNAPSHOTS = 32;
const MAX_ACTIVE_TURN_LAUNCH_CONTEXTS = 32;
const MAX_RECENT_COMPLETED_TURNS = 64;
const MAX_ACTIVITY_EVENTS = 48;
const MAX_RATE_LIMIT_UPDATE_EVENTS = 64;
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

interface ThreadCwdAuthority {
  cwd: string;
  revision: number;
  authorityRevision: number;
}

interface ThreadListSnapshot {
  thread: CodexThread;
  authorityRevision: number;
}

interface ResyncSnapshot {
  thread: CodexThread;
  authorityRevision: number;
}

interface PendingImagePreviewGroup {
  blobs: readonly Blob[];
  byteSize: number;
}

interface PendingFileAttachmentGroup {
  byteSize: number;
  files: readonly LocalFileAttachment[];
}

type NextTurnSettings = Pick<ThreadSettings, "model" | "effort">;

interface ActiveTurnLaunchContext {
  turnId: string;
  executionMode: "manual" | "auto";
}

function turnIdentity(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

function rememberRecentCompletedTurn(turns: Set<string>, threadId: string, turnId: string): void {
  const identity = turnIdentity(threadId, turnId);
  turns.delete(identity);
  turns.add(identity);
  while (turns.size > MAX_RECENT_COMPLETED_TURNS) {
    const oldestIdentity = turns.values().next().value as string | undefined;
    if (oldestIdentity === undefined) break;
    turns.delete(oldestIdentity);
  }
}

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

function queuePendingFileAttachments(
  groups: Map<string, PendingFileAttachmentGroup>,
  key: string,
  files: readonly LocalFileAttachment[],
): void {
  groups.delete(key);
  groups.set(key, {
    files,
    byteSize: files.reduce((total, file) => total + file.size, 0),
  });
  let fileCount = [...groups.values()]
    .reduce((total, group) => total + group.files.length, 0);
  let byteSize = [...groups.values()]
    .reduce((total, group) => total + group.byteSize, 0);
  while (fileCount > MAX_LOCAL_FILE_COUNT || byteSize > MAX_LOCAL_FILE_BYTES) {
    const oldestKey = groups.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = groups.get(oldestKey)!;
    groups.delete(oldestKey);
    fileCount -= oldest.files.length;
    byteSize -= oldest.byteSize;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [token, setToken] = useState(loadStoredToken);
  const [bootstrap, setBootstrap] = useState<BootstrapInfo | null>(null);
  const [bootstrapError, setBootstrapError] = useState("");
  const [tokenOpen, setTokenOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [accountUsage, setAccountUsage] = useState<AccountUsageSnapshot | null>(null);
  const [rateLimits, setRateLimits] = useState<AccountRateLimitsSnapshot | null>(null);
  const [threadUsageById, setThreadUsageById] = useState(
    () => new Map<string, ThreadTokenUsage>(),
  );
  const [recentActivities, setRecentActivities] = useState<ThreadActivityEvent[]>([]);
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
  const [resyncError, setResyncError] = useState<string | null>(null);
  const [messageQueueItems, setMessageQueueItems] = useState<MessageQueueItem[]>([]);
  const [messageQueueLoading, setMessageQueueLoading] = useState(false);
  const [messageQueueError, setMessageQueueError] = useState<string | null>(null);
  const [messageQueueBusyItemId, setMessageQueueBusyItemId] = useState<string | null>(null);
  const [messageQueueInvalidationSignal, setMessageQueueInvalidationSignal] = useState(0);
  const [threadHydrationSignal, setThreadHydrationSignal] = useState(0);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [nextTurnSettings, setNextTurnSettings] = useState<NextTurnSettings>({ model: "", effort: "" });
  const [autoRunNextTurn, setAutoRunNextTurn] = useState(false);
  const [activeTurnLaunchContexts, setActiveTurnLaunchContexts] = useState(
    () => new Map<string, ActiveTurnLaunchContext>(),
  );
  const [configuredDefaults, setConfiguredDefaults] = useState<NextTurnSettings>({ model: "", effort: "" });
  const [threadDialog, setThreadDialog] = useState<ThreadDialogState | null>(null);
  const [draftThreadConfigured, setDraftThreadConfigured] = useState(false);
  const [imagePreviews, setImagePreviews] = useState<SessionImagePreviewSnapshot>({});
  const [fileAttachments, setFileAttachments] = useState<SessionFileAttachmentSnapshot>({});
  const toastIdRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const selectedThreadIdRef = useRef<string | null>(state.selectedThreadId);
  const approvalSelectionRef = useRef<string | null>(state.selectedThreadId);
  const previousActiveTurnIdRef = useRef<string | null>(state.activeTurnId);
  const recentCompletedTurnsRef = useRef(new Set<string>());
  const currentThreadRef = useRef<CodexThread | null>(state.currentThread);
  const historyLoadsRef = useRef(new Set<string>());
  const detailLoadsRef = useRef(new Set<string>());
  const resyncCoordinatorRef = useRef(new ResyncCoordinator());
  const handledReadySequenceRef = useRef(0);
  const usageLoadGenerationRef = useRef(0);
  const rateLimitRevisionRef = useRef(0);
  const rateLimitUpdatesRef = useRef<Array<{ revision: number; params: unknown }>>([]);
  const bootstrapCwdInitializedRef = useRef(false);
  const nextTurnSettingsInitializedRef = useRef(false);
  const settingsLoadGenerationRef = useRef(0);
  const threadListRefreshGenerationRef = useRef(0);
  const threadListMutationEpochRef = useRef(0);
  const messageQueueLoadGenerationRef = useRef(0);
  const threadCwdAuthorityRevisionRef = useRef(0);
  const threadCwdUpdatesRef = useRef(new Map<string, ThreadCwdAuthority>());
  const skillsLoadGenerationRef = useRef(0);
  const skillsLoadedRef = useRef(false);
  const handledSkillsInvalidationRef = useRef(0);
  const pendingCanonicalThreadIdsRef = useRef(new Set<string>());
  const pendingThreadForkIdsRef = useRef(new Set<string>());
  const imagePreviewsMountedRef = useRef(false);
  const imagePreviewRegistryRef = useRef<SessionImagePreviewRegistry | null>(null);
  const imagePreviewStoreRef = useRef<BrowserImagePreviewStore | null>(null);
  const imagePreviewHydratedRef = useRef(false);
  const pendingImagePreviewGroupsRef = useRef(new Map<string, PendingImagePreviewGroup>());
  const removedImagePreviewThreadIdsRef = useRef(new Set<string>());
  const fileAttachmentsMountedRef = useRef(false);
  const fileAttachmentRegistryRef = useRef<SessionFileAttachmentRegistry | null>(null);
  const fileAttachmentStoreRef = useRef<BrowserFileAttachmentStore | null>(null);
  const fileAttachmentHydratedRef = useRef(false);
  const pendingFileAttachmentGroupsRef = useRef(new Map<string, PendingFileAttachmentGroup>());
  const removedFileAttachmentThreadIdsRef = useRef(new Set<string>());
  if (imagePreviewRegistryRef.current === null) {
    imagePreviewRegistryRef.current = new SessionImagePreviewRegistry();
  }
  if (fileAttachmentRegistryRef.current === null) {
    fileAttachmentRegistryRef.current = new SessionFileAttachmentRegistry();
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
    if (approvalSelectionRef.current !== state.selectedThreadId) {
      setAutoRunNextTurn(false);
      approvalSelectionRef.current = state.selectedThreadId;
    }
  }, [state.selectedThreadId]);

  useEffect(() => {
    if (previousActiveTurnIdRef.current && !state.activeTurnId) {
      setAutoRunNextTurn(false);
    }
    previousActiveTurnIdRef.current = state.activeTurnId;
  }, [state.activeTurnId]);

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

  useEffect(() => {
    const registry = fileAttachmentRegistryRef.current!;
    const store = new BrowserFileAttachmentStore();
    const pendingGroups = pendingFileAttachmentGroupsRef.current;
    let active = true;

    registry.clear();
    setFileAttachments(registry.snapshot());
    fileAttachmentsMountedRef.current = true;
    fileAttachmentHydratedRef.current = false;
    pendingGroups.clear();
    fileAttachmentStoreRef.current = store;
    void (async () => {
      let entries: Awaited<ReturnType<BrowserFileAttachmentStore["loadAll"]>> | null = null;
      try {
        entries = await store.loadAll();
      } catch {
        // Browser storage is optional; current-page file downloads remain in memory.
      }
      if (!active) return;

      const pending = [...pendingGroups];
      if (entries) {
        registry.clear();
        for (const entry of entries) {
          const threadId = sessionFileAttachmentThreadId(entry.key);
          if (threadId && !removedFileAttachmentThreadIdsRef.current.has(threadId)) {
            registry.remember(entry.key, entry.files);
          }
        }
        for (const [key, group] of pending) {
          const threadId = sessionFileAttachmentThreadId(key);
          if (threadId && !removedFileAttachmentThreadIdsRef.current.has(threadId)) {
            registry.remember(key, group.files);
          }
        }
        setFileAttachments(registry.snapshot());
      }
      pendingGroups.clear();
      fileAttachmentHydratedRef.current = true;
      for (const [key, group] of pending) {
        const threadId = sessionFileAttachmentThreadId(key);
        if (!threadId || removedFileAttachmentThreadIdsRef.current.has(threadId)) continue;
        void store.remember(key, group.files).catch(() => {
          // A local file write never changes the accepted Codex turn.
        });
      }
    })();

    return () => {
      active = false;
      fileAttachmentsMountedRef.current = false;
      if (fileAttachmentStoreRef.current === store) {
        fileAttachmentStoreRef.current = null;
        fileAttachmentHydratedRef.current = false;
        pendingGroups.clear();
      }
      store.close();
      registry.clear();
    };
  }, []);

  const rememberFileAttachments = useCallback((
    threadId: string,
    turnId: string,
    files: readonly File[],
    attachments: readonly UploadedFileAttachment[],
  ): void => {
    const registry = fileAttachmentRegistryRef.current;
    if (!registry || !fileAttachmentsMountedRef.current || files.length === 0) return;
    try {
      const localFiles = files.map((file, index): LocalFileAttachment => ({
        blob: file.slice(0, file.size, attachments[index]?.mediaType ?? file.type),
        mediaType: attachments[index]?.mediaType || file.type || "application/octet-stream",
        name: attachments[index]?.name || file.name,
        size: file.size,
      }));
      const key = sessionFileAttachmentKey(threadId, turnId);
      setFileAttachments(registry.remember(key, localFiles));
      if (!fileAttachmentHydratedRef.current) {
        queuePendingFileAttachments(pendingFileAttachmentGroupsRef.current, key, localFiles);
        return;
      }
      void fileAttachmentStoreRef.current?.remember(key, localFiles).catch(() => {
        // A local file write never changes the accepted Codex turn.
      });
    } catch {
      // Blob failures leave the durable Codex message intact and disable local download only.
    }
  }, []);

  const showToast = useCallback((message: string, tone: ToastMessage["tone"] = "error") => {
    const id = ++toastIdRef.current;
    dispatch({ type: "toast", toast: { id, tone, message } });
    window.setTimeout(() => dispatch({ type: "removeToast", id }), 5_500);
  }, []);

  const rememberActiveTurnLaunchContext = useCallback((
    threadId: string,
    context: ActiveTurnLaunchContext,
  ): void => {
    setActiveTurnLaunchContexts((current) => {
      const existing = current.get(threadId);
      if (
        existing?.turnId === context.turnId &&
        existing.executionMode === context.executionMode
      ) {
        return current;
      }
      const next = new Map(current);
      next.delete(threadId);
      next.set(threadId, context);
      while (next.size > MAX_ACTIVE_TURN_LAUNCH_CONTEXTS) {
        const oldestThreadId = next.keys().next().value as string | undefined;
        if (oldestThreadId === undefined) break;
        next.delete(oldestThreadId);
      }
      return next;
    });
  }, []);

  const forgetActiveTurnLaunchContext = useCallback((
    threadId: string,
    turnId?: string,
  ): void => {
    setActiveTurnLaunchContexts((current) => {
      const existing = current.get(threadId);
      if (!existing || (turnId !== undefined && existing.turnId !== turnId)) return current;
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });
  }, []);

  const removeLocalAttachmentsForThread = useCallback((threadId: string): void => {
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
    removedFileAttachmentThreadIdsRef.current.add(threadId);
    for (const key of [...pendingFileAttachmentGroupsRef.current.keys()]) {
      if (sessionFileAttachmentThreadId(key) === threadId) {
        pendingFileAttachmentGroupsRef.current.delete(key);
      }
    }
    const fileRegistry = fileAttachmentRegistryRef.current;
    if (fileRegistry && fileAttachmentsMountedRef.current) {
      setFileAttachments(fileRegistry.removeThread(threadId));
    }
    void fileAttachmentStoreRef.current?.removeThread(threadId).catch(() => {
      // The Codex thread is already deleted; local file cleanup is best-effort.
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
    setResyncError(null);
    setThreadDialog(null);
  }, []);

  const captureThreadCwdAuthorityRevision = useCallback((): number => {
    threadCwdAuthorityRevisionRef.current += 1;
    return threadCwdAuthorityRevisionRef.current;
  }, []);

  const rememberAuthoritativeThreadCwd = useCallback((
    threadId: string,
    cwd: string,
    authorityRevision: number,
    options: { syncState?: boolean; invalidateThreadLists?: boolean } = {},
  ): ThreadCwdAuthority => {
    const previous = threadCwdUpdatesRef.current.get(threadId);
    if (previous && authorityRevision < previous.authorityRevision) return previous;

    const knownCwd = previous?.cwd || (
      currentThreadRef.current?.id === threadId
        ? currentThreadRef.current.cwd
        : undefined
    );
    const cwdChanged = knownCwd !== undefined && knownCwd !== cwd;
    const authority = {
      cwd,
      revision: (previous?.revision ?? 0) + (cwdChanged ? 1 : 0),
      authorityRevision,
    };
    threadCwdUpdatesRef.current.set(threadId, authority);
    if (
      options.invalidateThreadLists !== false &&
      (previous === undefined || cwdChanged)
    ) {
      threadListMutationEpochRef.current += 1;
    }
    if (currentThreadRef.current?.id === threadId && currentThreadRef.current.cwd !== cwd) {
      currentThreadRef.current = { ...currentThreadRef.current, cwd };
    }
    if (options.syncState !== false) {
      dispatch({ type: "threadSettings", threadId, settings: { cwd } });
    }
    return authority;
  }, []);

  const applyNotification = useCallback((message: NotificationMessage) => {
    const params = paramsRecord(message.params);
    const threadId = readString(params.threadId);
    const turnId = readString(params.turnId);
    const itemId = readString(params.itemId);
    const activity = activityEventFromNotification(message);
    if (activity) {
      setRecentActivities((current) => [...current, activity].slice(-MAX_ACTIVITY_EVENTS));
    }

    switch (message.method) {
      case "thread/tokenUsage/updated": {
        const usage = extractThreadTokenUsage(params);
        if (threadId && usage) {
          setThreadUsageById((current) => {
            const next = new Map(current);
            next.delete(threadId);
            next.set(threadId, usage);
            while (next.size > MAX_THREAD_USAGE_SNAPSHOTS) {
              const oldestThreadId = next.keys().next().value as string | undefined;
              if (oldestThreadId === undefined) break;
              next.delete(oldestThreadId);
            }
            return next;
          });
        }
        return;
      }
      case "account/rateLimits/updated": {
        const revision = ++rateLimitRevisionRef.current;
        rateLimitUpdatesRef.current = [
          ...rateLimitUpdatesRef.current,
          { revision, params },
        ].slice(-MAX_RATE_LIMIT_UPDATE_EVENTS);
        setRateLimits((current) => mergeAccountRateLimitUpdate(current, params));
        return;
      }
      case "thread/started": {
        let thread = normalizeThread(params.thread);
        if (thread) {
          if (thread.cwd) {
            const authority = rememberAuthoritativeThreadCwd(
              thread.id,
              thread.cwd,
              captureThreadCwdAuthorityRevision(),
              { syncState: false, invalidateThreadLists: false },
            );
            thread = { ...thread, cwd: authority.cwd };
          }
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
          const previous = threadCwdUpdatesRef.current.get(threadId);
          threadCwdUpdatesRef.current.set(threadId, {
            cwd: "",
            revision: (previous?.revision ?? 0) + (previous?.cwd ? 1 : 0),
            authorityRevision: captureThreadCwdAuthorityRevision(),
          });
          pendingCanonicalThreadIdsRef.current.delete(threadId);
          forgetActiveTurnLaunchContext(threadId);
          invalidateSelectedThread(threadId);
          removeLocalAttachmentsForThread(threadId);
          dispatch({ type: "deleteThread", threadId });
        }
        return;
      }
      case "thread/settings/updated": {
        const rawSettings = paramsRecord(params.threadSettings);
        const updatedCwd = readString(rawSettings.cwd);
        const sandbox = sandboxMode(rawSettings.sandboxPolicy ?? rawSettings.sandbox);
        if (threadId) {
          if (
            threadId === selectedThreadIdRef.current &&
            sandbox === "external"
          ) {
            setAutoRunNextTurn(false);
          }
          const authoritativeCwd = updatedCwd
            ? rememberAuthoritativeThreadCwd(
                threadId,
                updatedCwd,
                captureThreadCwdAuthorityRevision(),
                { syncState: false },
              ).cwd
            : undefined;
          dispatch({
            type: "threadSettings",
            threadId,
            settings: {
              ...(authoritativeCwd ? { cwd: authoritativeCwd } : {}),
              ...(readString(rawSettings.model) ? { model: readString(rawSettings.model) } : {}),
              effort: readString(rawSettings.effort) ?? "",
              ...(sandbox ? { sandbox } : {}),
            },
          });
        }
        return;
      }
      case "turn/started": {
        const turn = normalizeTurn(params.turn);
        if (turn) dispatch({ type: "upsertTurn", turn, threadId });
        return;
      }
      case "turn/completed": {
        const turn = normalizeTurn(params.turn);
        const completedTurnId = turn?.id ?? turnId;
        if (threadId && completedTurnId) {
          rememberRecentCompletedTurn(recentCompletedTurnsRef.current, threadId, completedTurnId);
          forgetActiveTurnLaunchContext(threadId, completedTurnId);
        }
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
        const plan = parsePlan(params, message);
        if (threadId && turnId && plan) {
          dispatch({
            type: "setTurnPlan",
            threadId,
            turnId,
            plan,
            askCodexPlanRevision: parsePlanRevision(params.askCodexPlanRevision),
          });
        }
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
  }, [
    captureThreadCwdAuthorityRevision,
    forgetActiveTurnLaunchContext,
    invalidateSelectedThread,
    rememberAuthoritativeThreadCwd,
    removeLocalAttachmentsForThread,
  ]);

  const onNotification = useCallback((message: NotificationMessage) => {
    if (message.method === "messageQueue/changed") {
      const threadId = readString(paramsRecord(message.params).threadId);
      if (threadId && threadId === selectedThreadIdRef.current) {
        setMessageQueueInvalidationSignal((current) => current + 1);
      }
      return;
    }
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
      setResyncError(null);
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
  const {
    connection,
    connectionDetail,
    retryAttempt,
    readySequence,
    rpc,
    respond,
    reconnect,
  } = useCodexSocket({
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
    if (connection !== "connected") {
      dispatch({ type: "clearActiveReasoningItems" });
      dispatch({ type: "clearRequests" });
    }
  }, [connection]);

  const refreshMessageQueue = useCallback(async (requestedThreadId?: string) => {
    const threadId = requestedThreadId ?? selectedThreadIdRef.current;
    const generation = ++messageQueueLoadGenerationRef.current;
    if (!threadId || connection !== "connected") {
      setMessageQueueItems([]);
      setMessageQueueLoading(false);
      setMessageQueueError(null);
      return;
    }
    setMessageQueueLoading(true);
    setMessageQueueError(null);
    try {
      const result = await rpc("messageQueue/list", { threadId });
      if (generation !== messageQueueLoadGenerationRef.current) return;
      const snapshot = extractMessageQueueSnapshot(result);
      if (!snapshot) throw new Error("Gateway returned an invalid message queue snapshot");
      if (selectedThreadIdRef.current !== threadId) return;
      setMessageQueueItems(snapshot.items);
    } catch (error) {
      if (generation !== messageQueueLoadGenerationRef.current) return;
      setMessageQueueError(errorMessage(error));
    } finally {
      if (generation === messageQueueLoadGenerationRef.current) {
        setMessageQueueLoading(false);
      }
    }
  }, [connection, rpc]);

  useEffect(() => {
    const threadId = state.currentThread?.id === state.selectedThreadId
      ? state.currentThread.id
      : undefined;
    if (connection !== "connected" || !threadId) {
      const generation = ++messageQueueLoadGenerationRef.current;
      const timeout = window.setTimeout(() => {
        if (generation !== messageQueueLoadGenerationRef.current) return;
        setMessageQueueItems([]);
        setMessageQueueLoading(false);
        setMessageQueueError(null);
        setMessageQueueBusyItemId(null);
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    void refreshMessageQueue(threadId);
    return undefined;
  }, [
    connection,
    messageQueueInvalidationSignal,
    readySequence,
    refreshMessageQueue,
    state.currentThread?.id,
    state.selectedThreadId,
  ]);

  const refreshUsage = useCallback(async () => {
    const generation = ++usageLoadGenerationRef.current;
    const rateLimitRevision = rateLimitRevisionRef.current;
    if (connection !== "connected") {
      setUsageLoading(false);
      setUsageError("Connect to Codex to load account usage and rate limits.");
      return;
    }

    setUsageLoading(true);
    setUsageError(null);
    try {
      const [rateLimitResult, accountUsageResult] = await Promise.allSettled([
        rpc("account/rateLimits/read", {}),
        rpc("account/usage/read", {}),
      ]);
      if (generation !== usageLoadGenerationRef.current) return;

      const nextRateLimits = rateLimitResult.status === "fulfilled"
        ? extractAccountRateLimits(rateLimitResult.value)
        : null;
      const nextAccountUsage = accountUsageResult.status === "fulfilled"
        ? extractAccountUsage(accountUsageResult.value)
        : null;
      if (nextRateLimits) {
        const currentRevision = rateLimitRevisionRef.current;
        const rollingUpdates = rateLimitUpdatesRef.current.filter((entry) => (
          entry.revision > rateLimitRevision
        ));
        if (currentRevision - rateLimitRevision === rollingUpdates.length) {
          setRateLimits(rollingUpdates.reduce<AccountRateLimitsSnapshot | null>(
            (snapshot, entry) => mergeAccountRateLimitUpdate(snapshot, entry.params),
            nextRateLimits,
          ));
        }
      }
      if (nextAccountUsage) setAccountUsage(nextAccountUsage);

      if (!nextRateLimits && !nextAccountUsage) {
        setUsageError("Account activity and rate limits are unavailable for this sign-in.");
      } else if (!nextRateLimits) {
        setUsageError("Rate limits are unavailable for this sign-in.");
      } else if (!nextAccountUsage) {
        setUsageError("Account activity is unavailable for this sign-in.");
      }
    } finally {
      if (generation === usageLoadGenerationRef.current) setUsageLoading(false);
    }
  }, [connection, rpc]);

  const openUsage = useCallback(() => {
    setUsageOpen(true);
    void refreshUsage();
  }, [refreshUsage]);

  const retryConnection = useCallback(() => {
    if (connection !== "error") {
      reconnect();
      return;
    }
    void rpc("model/list", { limit: 1 }).catch(() => reconnect());
  }, [connection, reconnect, rpc]);

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
      const listThreads = async (archived: boolean): Promise<ThreadListSnapshot[]> => {
        const snapshots: ThreadListSnapshot[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 50; page += 1) {
          const authorityRevision = captureThreadCwdAuthorityRevision();
          const result = await rpc("thread/list", {
            limit: 100,
            sortKey: "recency_at",
            sortDirection: "desc",
            sourceKinds: [],
            archived,
            ...(cursor !== undefined ? { cursor } : {}),
          });
          snapshots.push(...extractThreads(result).map((thread) => ({
            thread,
            authorityRevision,
          })));
          const nextCursor = isRecord(result) ? readString(result.nextCursor) : undefined;
          if (nextCursor === undefined || seenCursors.has(nextCursor)) break;
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        return snapshots;
      };
      const [threadSnapshots, archivedThreadSnapshots] = await Promise.all([
        listThreads(false),
        listThreads(true),
      ]);
      if (
        generation !== threadListRefreshGenerationRef.current ||
        mutationEpoch !== threadListMutationEpochRef.current
      ) {
        return false;
      }

      for (const snapshot of [...threadSnapshots, ...archivedThreadSnapshots]) {
        if (!snapshot.thread.cwd) continue;
        rememberAuthoritativeThreadCwd(
          snapshot.thread.id,
          snapshot.thread.cwd,
          snapshot.authorityRevision,
          { syncState: false, invalidateThreadLists: false },
        );
      }
      const projectAuthoritativeCwd = (snapshot: ThreadListSnapshot): CodexThread => {
        const authority = threadCwdUpdatesRef.current.get(snapshot.thread.id);
        return authority?.cwd
          ? { ...snapshot.thread, cwd: authority.cwd }
          : snapshot.thread;
      };
      const threads = threadSnapshots.map(projectAuthoritativeCwd);
      const archivedThreads = archivedThreadSnapshots.map(projectAuthoritativeCwd);
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
      const currentThreadId = currentThreadRef.current?.id;
      const selectedAuthority = currentThreadId
        ? threadCwdUpdatesRef.current.get(currentThreadId)
        : undefined;
      if (currentThreadId && selectedAuthority?.cwd) {
        dispatch({
          type: "threadSettings",
          threadId: currentThreadId,
          settings: { cwd: selectedAuthority.cwd },
        });
      }
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
  }, [
    captureThreadCwdAuthorityRevision,
    connection,
    rememberAuthoritativeThreadCwd,
    rpc,
    showToast,
  ]);

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
    const cwdAuthorityRevision = captureThreadCwdAuthorityRevision();
    nextTurnSettingsInitializedRef.current = true;
    selectedThreadIdRef.current = threadId;
    setDraftThreadConfigured(false);
    setThreadDialog(null);
    dispatch({ type: "selectThread", threadId });
    setSidebarOpen(false);
    setThreadLoadError(null);
    setResyncError(null);
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
      const resumeRecord = paramsRecord(resumed);
      const resumedCwd = thread.cwd ?? readString(resumeRecord.cwd);
      const authority = resumedCwd
        ? rememberAuthoritativeThreadCwd(threadId, resumedCwd, cwdAuthorityRevision)
        : threadCwdUpdatesRef.current.get(threadId);
      const selectedCwd = authority?.cwd || bootstrap?.defaultCwd || "";
      dispatch({
        type: "setCurrentThread",
        thread: { ...thread, cwd: selectedCwd, turns: turnsForDisplay(page, null) },
        history: { nextCursor: page.nextCursor },
      });
      const model = readString(resumeRecord.model) ?? thread.model ?? configuredDefaults.model;
      const resumedEffort = readString(resumeRecord.effort) ?? readString(resumeRecord.reasoningEffort);
      const effort = resumedEffort ?? (model === configuredDefaults.model
        ? configuredDefaults.effort
        : normalizeEffortForModel(models, model, ""));
      setNextTurnSettings({ model, effort });
      dispatch({
        type: "settings",
        settings: {
          cwd: selectedCwd,
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
  }, [
    bootstrap,
    captureThreadCwdAuthorityRevision,
    configuredDefaults,
    models,
    rememberAuthoritativeThreadCwd,
    rpc,
    showToast,
  ]);

  const loadResyncSnapshot = useCallback(async (threadId: string): Promise<ResyncSnapshot> => {
    const authorityRevision = captureThreadCwdAuthorityRevision();
    const readResult = await rpc("thread/read", { threadId, includeTurns: false });
    const thread = extractThread(readResult);
    if (!thread) throw new Error("Codex did not return the requested thread");
    const page = await requestTurnPage(rpc, {
      threadId,
      preferredLimit: TURN_PAGE_SIZE,
    });
    return {
      thread: { ...thread, turns: turnsForDisplay(page, null) },
      authorityRevision,
    };
  }, [captureThreadCwdAuthorityRevision, rpc]);

  const runResync = useCallback(async () => {
    const coordinator = resyncCoordinatorRef.current;
    if (!coordinator.startCycle()) return;

    setResyncing(true);
    void refreshThreads();
    let restart = false;
    let baseline = currentThreadRef.current;
    const canReconcile = Boolean(
      baseline && baseline.id === selectedThreadIdRef.current,
    );
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        const threadId = selectedThreadIdRef.current;
        const generation = selectionGenerationRef.current;
        if (!threadId) {
          for (const message of coordinator.abort()) applyNotification(message);
          return;
        }

        let snapshotResult: ResyncSnapshot;
        try {
          snapshotResult = await loadResyncSnapshot(threadId);
        } catch (error) {
          for (const message of coordinator.abort()) applyNotification(message);
          const detail = `Live state refresh failed: ${errorMessage(error)}`;
          if (canReconcile) setResyncError(detail);
          else setThreadLoadError("Connection restored, but the thread still needs to be loaded again.");
          showToast(detail);
          return;
        }

        if (
          generation !== selectionGenerationRef.current ||
          selectedThreadIdRef.current !== threadId
        ) {
          for (const message of coordinator.abort()) applyNotification(message);
          return;
        }

        const snapshotAuthority = snapshotResult.thread.cwd
          ? rememberAuthoritativeThreadCwd(
              threadId,
              snapshotResult.thread.cwd,
              snapshotResult.authorityRevision,
            )
          : threadCwdUpdatesRef.current.get(threadId);
        const snapshot = snapshotAuthority?.cwd
          ? { ...snapshotResult.thread, cwd: snapshotAuthority.cwd }
          : snapshotResult.thread;

        const result = coordinator.finishPass(pass === 0);
        const notifications = filterSnapshotCoveredNotifications(
          baseline,
          snapshot,
          result.notifications,
        );
        if (canReconcile) {
          dispatch({ type: "reconcileCurrentThread", thread: snapshot });
          setResyncError(null);
        } else {
          setThreadLoadError("Connection restored. Retry the thread to finish loading it.");
        }
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
  }, [
    applyNotification,
    loadResyncSnapshot,
    refreshThreads,
    rememberAuthoritativeThreadCwd,
    showToast,
  ]);

  const retryResync = useCallback(() => {
    if (!selectedThreadIdRef.current) {
      setResyncError(null);
      return;
    }
    resyncCoordinatorRef.current.request();
    dispatch({ type: "clearActiveReasoningItems" });
    setResyncError(null);
    setResyncing(true);
    setResyncSignal((current) => current + 1);
  }, []);

  useLayoutEffect(() => {
    if (
      connection !== "connected" ||
      readySequence === 0 ||
      readySequence <= handledReadySequenceRef.current
    ) {
      return;
    }
    const previousReadySequence = handledReadySequenceRef.current;
    handledReadySequenceRef.current = readySequence;
    if (previousReadySequence === 0 || !selectedThreadIdRef.current) return;

    retryResync();
  }, [connection, readySequence, retryResync]);

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
    setAutoRunNextTurn(false);
    const defaults = {
      ...composerSettings,
      model: configuredDefaults.model || composerSettings.model,
      effort: configuredDefaults.effort || composerSettings.effort,
    };
    const selectedCurrentThread = state.currentThread?.id === state.selectedThreadId
      ? state.currentThread
      : undefined;
    const selectedThreadSummary = state.threads.find((thread) => (
      thread.id === state.selectedThreadId
    )) ?? state.archivedThreads.find((thread) => (
      thread.id === state.selectedThreadId
    ));
    const initialCwd = selectedCurrentThread?.cwd
      || selectedThreadSummary?.cwd
      || bootstrap?.defaultCwd
      || "";
    setThreadDialog({
      mode: "new",
      settings: newThreadSettings(initialCwd, defaults),
    });
    setSidebarOpen(false);
  }, [
    bootstrap?.defaultCwd,
    composerSettings,
    configuredDefaults,
    state.currentThread,
    state.archivedThreads,
    state.selectedThreadId,
    state.threads,
  ]);

  const openThreadSettings = useCallback(() => {
    setThreadDialog({
      mode: state.currentThread || draftThreadConfigured ? "existing" : "new",
      settings: composerSettings,
    });
  }, [composerSettings, draftThreadConfigured, state.currentThread]);

  const confirmThreadSettings = useCallback((settings: ThreadSettings) => {
    if (threadDialog?.mode === "new") {
      selectionGenerationRef.current += 1;
      selectedThreadIdRef.current = null;
      setLoadingThread(false);
      setThreadLoadError(null);
      setResyncError(null);
      setDraftThreadConfigured(true);
      nextTurnSettingsInitializedRef.current = true;
      setNextTurnSettings({ model: settings.model, effort: settings.effort });
      dispatch({ type: "selectThread", threadId: null });
      dispatch({ type: "settings", settings });
      setSidebarOpen(false);
    }
    setThreadDialog(null);
  }, [threadDialog?.mode]);

  const sendMessage = useCallback(async (
    text: string,
    images: readonly File[],
    files: readonly File[],
  ) => {
    if (state.activeTurnId) {
      throw new Error("A turn is already active; the message was not sent as a new turn");
    }
    const selectionGeneration = selectionGenerationRef.current;
    const autoRunSelected = autoRunNextTurn;
    const executionMode = autoRunSelected ? "auto" : "manual";
    let thread = state.currentThread;
    const existingThread = Boolean(thread);
    let guardedThreadId = thread?.id;
    let cwdUpdateRevision = guardedThreadId
      ? threadCwdUpdatesRef.current.get(guardedThreadId)?.revision ?? 0
      : 0;
    const cwd = state.settings.cwd.trim();
    let uploadedImages: UploadedAttachment[] = [];
    let uploadedFiles: UploadedFileAttachment[] = [];
    let turnAccepted = false;
    let threadCreateAttempted = false;
    let turnStartAttempted = false;
    const assertSelectionUnchanged = (): void => {
      if (selectionGeneration !== selectionGenerationRef.current) {
        throw new Error("Thread changed while preparing the message; nothing was sent");
      }
      if (guardedThreadId) {
        const latestCwdUpdate = threadCwdUpdatesRef.current.get(guardedThreadId);
        if (
          (latestCwdUpdate?.revision ?? 0) !== cwdUpdateRevision ||
          (latestCwdUpdate && latestCwdUpdate.cwd !== cwd)
        ) {
          throw new Error("Working directory changed while preparing the message; nothing was sent");
        }
      }
    };
    try {
      if (!cwd) throw new Error("Choose an absolute working directory first");
      if (images.length + files.length > MAX_ATTACHMENTS_PER_TURN) {
        throw new Error(`A turn can include at most ${MAX_ATTACHMENTS_PER_TURN} attachments`);
      }
      uploadedImages = await uploadImageAttachments(images, token);
      uploadedFiles = await uploadFileAttachments(files, token);
      assertSelectionUnchanged();
      if (!thread) {
        const threadStartAuthorityRevision = captureThreadCwdAuthorityRevision();
        threadCreateAttempted = true;
        const result = await rpc("thread/start", {
          cwd,
          ...(nextTurnSettings.model.trim() ? { model: nextTurnSettings.model.trim() } : {}),
        });
        assertSelectionUnchanged();
        thread = extractThread(result);
        if (!thread) throw new Error("Codex did not return a new thread");
        const createdAuthority = thread.cwd
          ? rememberAuthoritativeThreadCwd(
              thread.id,
              thread.cwd,
              threadStartAuthorityRevision,
            )
          : threadCwdUpdatesRef.current.get(thread.id);
        const createdCwd = createdAuthority?.cwd || cwd;
        thread = { ...thread, cwd: createdCwd };
        setDraftThreadConfigured(false);
        threadListMutationEpochRef.current += 1;
        rememberPendingCanonicalThread(pendingCanonicalThreadIdsRef.current, thread.id);
        selectedThreadIdRef.current = thread.id;
        approvalSelectionRef.current = thread.id;
        currentThreadRef.current = thread;
        dispatch({ type: "setCurrentThread", thread });
        if (createdCwd !== cwd) dispatch({ type: "settings", settings: { cwd: createdCwd } });
        guardedThreadId = thread.id;
        cwdUpdateRevision = threadCwdUpdatesRef.current.get(thread.id)?.revision ?? 0;
        if (createdCwd !== cwd) {
          throw new Error("Working directory changed while preparing the message; nothing was sent");
        }
        assertSelectionUnchanged();
      }
      if (existingThread) {
        const resumeAuthorityRevision = captureThreadCwdAuthorityRevision();
        const resumed = await rpc(
          "thread/resume",
          existingThreadResumeParams(thread.id),
        );
        assertSelectionUnchanged();
        const updatedThread = extractThread(resumed);
        const resumedCandidateCwd = updatedThread?.cwd ?? readString(paramsRecord(resumed).cwd);
        const resumedAuthority = resumedCandidateCwd
          ? rememberAuthoritativeThreadCwd(
              thread.id,
              resumedCandidateCwd,
              resumeAuthorityRevision,
            )
          : threadCwdUpdatesRef.current.get(thread.id);
        const resumedCwd = resumedAuthority?.cwd || cwd;
        if (resumedCwd !== cwd) {
          throw new Error("Working directory changed while preparing the message; nothing was sent");
        }
        if (updatedThread) {
          thread = { ...updatedThread, cwd: resumedCwd, turns: thread.turns };
          dispatch({ type: "setCurrentThread", thread });
        }
      }
      assertSelectionUnchanged();
      turnStartAttempted = true;
      const result = await rpc("turn/start", {
        threadId: thread.id,
        input: [
          ...(text ? [{ type: "text", text, text_elements: [] }] : []),
          ...uploadedImages.map((attachment) => ({
            type: "localImage",
            attachmentId: attachment.id,
          })),
          ...uploadedFiles.map((attachment) => ({
            type: "file",
            attachmentId: attachment.id,
          })),
        ],
        cwd,
        executionMode,
        ...nextTurnOverrides(nextTurnSettings),
      });
      turnAccepted = true;
      const turn = extractTurn(result);
      const completedBeforeStartResult = turn
        ? recentCompletedTurnsRef.current.delete(turnIdentity(thread.id, turn.id))
        : false;
      if (turn?.status === "inProgress" && !completedBeforeStartResult) {
        rememberActiveTurnLaunchContext(thread.id, {
          turnId: turn.id,
          executionMode,
        });
      }
      if (autoRunSelected) {
        setAutoRunNextTurn(false);
      }
      if (turn) {
        rememberImagePreviews(thread.id, turn.id, images, uploadedImages);
        rememberFileAttachments(thread.id, turn.id, files, uploadedFiles);
      }
      if (turn && !completedBeforeStartResult && selectionGeneration === selectionGenerationRef.current) {
        dispatch({ type: "upsertTurn", turn, threadId: thread.id });
      }
      void refreshThreads();
    } catch (error) {
      if ((threadCreateAttempted || turnStartAttempted) && autoRunSelected) {
        setAutoRunNextTurn(false);
      }
      if (!turnAccepted) {
        if (uploadedImages.length > 0) void discardAttachments(uploadedImages, token);
        if (uploadedFiles.length > 0) void discardFileAttachments(uploadedFiles, token);
      }
      throw error;
    }
  }, [
    autoRunNextTurn,
    captureThreadCwdAuthorityRevision,
    nextTurnSettings,
    refreshThreads,
    rememberAuthoritativeThreadCwd,
    rememberActiveTurnLaunchContext,
    rememberFileAttachments,
    rememberImagePreviews,
    rpc,
    state.currentThread,
    state.activeTurnId,
    state.settings,
    token,
  ]);

  const enqueueMessage = useCallback(async (text: string) => {
    const thread = state.currentThread;
    if (!thread || thread.id !== state.selectedThreadId) {
      throw new Error("Choose an existing thread before queueing a message");
    }
    const lastTurnId = thread.turns?.at(-1)?.id ?? null;
    const result = await rpc("messageQueue/enqueue", {
      threadId: thread.id,
      text,
      expectedLastTurnId: lastTurnId,
    });
    const queued = extractMessageQueueItem(result);
    if (!queued || queued.threadId !== thread.id) {
      throw new Error("Gateway returned an invalid queued message");
    }
    if (selectedThreadIdRef.current === thread.id) {
      setMessageQueueItems((current) => [
        ...current.filter((item) => item.id !== queued.id),
        queued,
      ].sort((left, right) => left.createdAt - right.createdAt));
    }
  }, [rpc, state.currentThread, state.selectedThreadId]);

  const steerMessage = useCallback(async (text: string, expectedTurnId: string) => {
    const thread = state.currentThread;
    const activeTurn = thread?.turns?.find((turn) => (
      turn.id === state.activeTurnId && turn.status === "inProgress"
    ));
    if (
      connection !== "connected" ||
      loadingThread ||
      resyncing ||
      resyncError !== null ||
      threadLoadError !== null
    ) {
      throw new Error("The connection is not ready; guidance was not sent");
    }
    if (
      !thread ||
      thread.id !== state.selectedThreadId ||
      state.activeTurnId !== expectedTurnId ||
      activeTurn?.id !== expectedTurnId
    ) {
      throw new Error("The original turn is no longer active; guidance was not sent");
    }
    const guidance = text.trim();
    if (!guidance) throw new Error("Guidance must not be empty");
    await rpc("turn/steer", {
      threadId: thread.id,
      expectedTurnId,
      input: [{ type: "text", text: guidance, text_elements: [] }],
    });
  }, [
    connection,
    loadingThread,
    resyncError,
    resyncing,
    rpc,
    state.activeTurnId,
    state.currentThread,
    state.selectedThreadId,
    threadLoadError,
  ]);

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

  const sendQueuedMessage = useCallback(async (item: MessageQueueItem) => {
    const threadId = state.currentThread?.id;
    if (
      !threadId ||
      threadId !== state.selectedThreadId ||
      item.threadId !== threadId ||
      connection !== "connected" ||
      loadingThread ||
      resyncing ||
      resyncError !== null ||
      threadLoadError !== null ||
      state.activeTurnId
    ) {
      showToast("The thread is not ready to send a queued message");
      return;
    }
    setMessageQueueBusyItemId(item.id);
    try {
      const result = await rpc("messageQueue/send", {
        id: item.id,
        revision: item.revision,
        ...(item.status === "needsReview" ? { confirmReview: true } : {}),
      });
      const turn = extractTurn(result);
      if (!turn) throw new Error("Gateway did not confirm the queued turn");
      if (selectedThreadIdRef.current === threadId) {
        dispatch({ type: "upsertTurn", turn, threadId });
      }
      void refreshThreads();
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setMessageQueueBusyItemId((current) => current === item.id ? null : current);
      void refreshMessageQueue(threadId);
    }
  }, [
    connection,
    loadingThread,
    refreshMessageQueue,
    refreshThreads,
    resyncError,
    resyncing,
    rpc,
    showToast,
    state.activeTurnId,
    state.currentThread?.id,
    state.selectedThreadId,
    threadLoadError,
  ]);

  const cancelQueuedMessage = useCallback(async (item: MessageQueueItem) => {
    setMessageQueueBusyItemId(item.id);
    try {
      await rpc("messageQueue/cancel", { id: item.id, revision: item.revision });
    } catch (error) {
      showToast(errorMessage(error));
    } finally {
      setMessageQueueBusyItemId((current) => current === item.id ? null : current);
      void refreshMessageQueue(item.threadId);
    }
  }, [refreshMessageQueue, rpc, showToast]);

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

  const forkThread = useCallback(async (threadId: string) => {
    if (isThreadActive(threadId)) {
      showToast("Active threads cannot be forked");
      return;
    }
    if (pendingThreadForkIdsRef.current.has(threadId)) {
      showToast("A fork of this thread is already in progress");
      return;
    }
    pendingThreadForkIdsRef.current.add(threadId);
    const requestedGeneration = selectionGenerationRef.current;
    const cwdAuthorityRevision = captureThreadCwdAuthorityRevision();
    try {
      const result = await rpc("thread/fork", { threadId });
      const thread = extractThread(result);
      if (!thread || thread.id === threadId || thread.forkedFromId !== threadId) {
        throw new Error("Codex did not return a valid forked thread");
      }
      const response = paramsRecord(result);
      const returnedCwd = thread.cwd ?? readString(response.cwd);
      const authority = returnedCwd
        ? rememberAuthoritativeThreadCwd(thread.id, returnedCwd, cwdAuthorityRevision)
        : threadCwdUpdatesRef.current.get(thread.id);
      const cwd = authority?.cwd || bootstrap?.defaultCwd || "";
      const forkedThread = { ...thread, cwd };

      threadListMutationEpochRef.current += 1;
      rememberPendingCanonicalThread(pendingCanonicalThreadIdsRef.current, forkedThread.id);
      dispatch({ type: "upsertThread", thread: forkedThread });
      void refreshThreads();

      if (requestedGeneration !== selectionGenerationRef.current) {
        showToast("Thread forked", "success");
        return;
      }

      const generation = ++selectionGenerationRef.current;
      selectedThreadIdRef.current = forkedThread.id;
      nextTurnSettingsInitializedRef.current = true;
      setDraftThreadConfigured(false);
      setThreadDialog(null);
      setSidebarOpen(false);
      setThreadLoadError(null);
      setResyncError(null);
      setLoadingThread(true);
      dispatch({ type: "selectThread", threadId: forkedThread.id });

      try {
        const page = await requestTurnPage(rpc, {
          threadId: forkedThread.id,
          preferredLimit: TURN_PAGE_SIZE,
        });
        if (generation !== selectionGenerationRef.current) return;
        dispatch({
          type: "setCurrentThread",
          thread: { ...forkedThread, turns: turnsForDisplay(page, null) },
          history: { nextCursor: page.nextCursor },
        });
        const model = readString(response.model) ?? forkedThread.model ?? configuredDefaults.model;
        const effort = readString(response.reasoningEffort) ?? (model === configuredDefaults.model
          ? configuredDefaults.effort
          : normalizeEffortForModel(models, model, ""));
        setNextTurnSettings({ model, effort });
        dispatch({
          type: "settings",
          settings: {
            cwd,
            model,
            effort,
            sandbox: sandboxMode(response.sandbox) ?? "workspace-write",
          },
        });
        showToast("Thread forked", "success");
      } catch (error) {
        if (generation === selectionGenerationRef.current) {
          const message = `Thread forked, but its history could not be loaded: ${errorMessage(error)}`;
          setThreadLoadError(message);
          showToast(message);
        }
      } finally {
        if (generation === selectionGenerationRef.current) setLoadingThread(false);
      }
    } catch (error) {
      showToast(`Fork was not confirmed: ${errorMessage(error)}. Refresh threads before trying again.`);
    } finally {
      pendingThreadForkIdsRef.current.delete(threadId);
    }
  }, [
    bootstrap,
    captureThreadCwdAuthorityRevision,
    configuredDefaults,
    isThreadActive,
    models,
    refreshThreads,
    rememberAuthoritativeThreadCwd,
    rpc,
    showToast,
  ]);

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
      removeLocalAttachmentsForThread(threadId);
      dispatch({ type: "deleteThread", threadId });
      showToast("Thread permanently deleted", "success");
    } catch (error) {
      showToast(errorMessage(error));
    }
  }, [invalidateSelectedThread, isThreadActive, removeLocalAttachmentsForThread, rpc, showToast]);

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
    usageLoadGenerationRef.current += 1;
    rateLimitRevisionRef.current = 0;
    rateLimitUpdatesRef.current = [];
    saveStoredToken(nextToken);
    setToken(nextToken);
    setTokenOpen(false);
    setBootstrapError("");
    setAccountUsage(null);
    setRateLimits(null);
    setUsageError(null);
    setUsageLoading(false);
  }, []);

  const requiredToken = Boolean(bootstrap?.authRequired && !token) || bootstrapError.includes("ASK_CODEX_TOKEN");
  const title = useMemo(() => threadTitle(state.currentThread), [state.currentThread]);
  const activeTurn = state.activeTurnId && state.currentThread?.id === state.selectedThreadId
    ? state.currentThread.turns?.find((turn) => (
        turn.id === state.activeTurnId && turn.status === "inProgress"
      ))
    : undefined;
  const activeTurnLaunchContext = state.activeTurnId && state.currentThread?.id === state.selectedThreadId
    ? activeTurnLaunchContexts.get(state.currentThread.id)
    : undefined;
  const composerAutoRunEnabled = state.activeTurnId
    ? activeTurnLaunchContext?.turnId === state.activeTurnId &&
      activeTurnLaunchContext.executionMode === "auto"
    : autoRunNextTurn;
  const activePlan = activeTurn?.plan?.plan.length ? activeTurn.plan : undefined;
  const syncing = resyncing;
  const queueSendDisabled = connection !== "connected" || loadingThread || syncing ||
    resyncError !== null || threadLoadError !== null || Boolean(state.activeTurnId);

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
        recentActivities={recentActivities}
        pendingRequests={state.pendingRequests}
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
        onFork={(threadId) => void forkThread(threadId)}
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
          syncing={syncing}
          syncError={resyncError}
          retryAttempt={retryAttempt}
          onUsage={openUsage}
          onReconnect={retryConnection}
          onResync={retryResync}
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
          fileAttachments={fileAttachments}
          imagePreviews={imagePreviews}
          onDownloadFile={(capability) => downloadFileCapability(capability, token)}
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
        {state.currentThread?.id === state.selectedThreadId && (
          <MessageQueueDock
            items={messageQueueItems}
            loading={messageQueueLoading}
            error={messageQueueError}
            disabled={queueSendDisabled}
            busyItemId={messageQueueBusyItemId}
            onRefresh={() => void refreshMessageQueue(state.currentThread!.id)}
            onSend={(item) => void sendQueuedMessage(item)}
            onCancel={(item) => void cancelQueuedMessage(item)}
          />
        )}
        <Composer
          activeTurnId={activeTurn?.id ?? null}
          autoRunAvailable={Boolean(
            draftThreadConfigured || (
              state.currentThread?.id && state.currentThread.id === state.selectedThreadId
            ),
          )}
          autoRunNextTurn={composerAutoRunEnabled}
          disabled={connection !== "connected" || loadingThread || syncing || resyncError !== null || threadLoadError !== null}
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
          onEnqueue={state.currentThread?.id === state.selectedThreadId ? enqueueMessage : undefined}
          onAutoRunNextTurnChange={setAutoRunNextTurn}
          onSteer={steerMessage}
          onStop={stopTurn}
        />
      </section>
      {threadDialog && (
        <ThreadSettingsDialog
          key={`${threadDialog.mode}:${threadDialog.settings.cwd}`}
          open
          mode={threadDialog.mode}
          settings={threadDialog.settings}
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
      <UsageDialog
        open={usageOpen}
        loading={usageLoading}
        threadUsage={state.currentThread ? threadUsageById.get(state.currentThread.id) ?? null : null}
        accountUsage={accountUsage}
        rateLimits={rateLimits}
        error={usageError}
        onRefresh={() => void refreshUsage()}
        onClose={() => setUsageOpen(false)}
      />
      <Toasts toasts={state.toasts} onClose={(id) => dispatch({ type: "removeToast", id })} />
    </div>
  );
}
