import type {
  CodexItem,
  CodexThread,
  CodexTurn,
  ConnectionState,
  PendingRequest,
  ThreadSettings,
  ToastMessage,
  TurnPlan,
} from "../types/protocol";
import { threadRecencyTimestamp, timestampMilliseconds } from "../utils/protocol";

export interface AppState {
  connection: ConnectionState;
  connectionDetail: string;
  threads: CodexThread[];
  archivedThreads: CodexThread[];
  selectedThreadId: string | null;
  currentThread: CodexThread | null;
  turnHistory: TurnHistoryState;
  activeTurnId: string | null;
  activeReasoningItemIdsByTurn: Record<string, string[]>;
  pendingRequests: PendingRequest[];
  commandApprovalReasons: Record<string, string[]>;
  settings: ThreadSettings;
  toasts: ToastMessage[];
}

export interface TurnHistoryState {
  threadId: string | null;
  nextCursor: string | null;
  loadingCursor: string | null;
  status: "idle" | "loading" | "error";
  error: string | null;
}

export type AppAction =
  | { type: "connection"; state: ConnectionState; detail?: string }
  | { type: "setThreads"; threads: CodexThread[]; protectedThreadIds?: string[] }
  | { type: "setArchivedThreads"; threads: CodexThread[] }
  | { type: "archiveThread"; threadId: string }
  | { type: "unarchiveThread"; threadId: string; thread?: CodexThread }
  | { type: "deleteThread"; threadId: string }
  | { type: "selectThread"; threadId: string | null }
  | { type: "setCurrentThread"; thread: CodexThread; history?: { nextCursor: string | null } }
  | { type: "reconcileCurrentThread"; thread: CodexThread }
  | { type: "loadOlderTurnsStarted"; threadId: string; cursor: string }
  | { type: "prependOlderTurns"; threadId: string; cursor: string; turns: CodexTurn[]; nextCursor: string | null }
  | { type: "loadOlderTurnsFailed"; threadId: string; cursor: string; error: string }
  | { type: "loadTurnDetailStarted"; threadId: string; turnId: string; cursor: string | null; itemCursor?: string }
  | { type: "loadTurnItemPageSucceeded"; threadId: string; turnId: string; cursor: string | null; itemCursor?: string; items: CodexItem[]; nextItemCursor: string | null }
  | { type: "loadTurnDetailSucceeded"; threadId: string; turnId: string; cursor: string | null; itemCursor?: string; turn: CodexTurn }
  | { type: "loadTurnDetailFailed"; threadId: string; turnId: string; cursor: string | null; itemCursor?: string; error: string; unavailable?: boolean }
  | { type: "upsertThread"; thread: CodexThread }
  | { type: "upsertTurn"; turn: CodexTurn; threadId?: string }
  | { type: "setTurnStatus"; turnId: string; status: string; error?: unknown }
  | { type: "upsertItem"; turnId: string; item: CodexItem; lifecycle: "started" | "completed" }
  | { type: "appendItemDelta"; turnId: string; itemId: string; itemType?: string; field: string; delta: string }
  | { type: "appendIndexedItemDelta"; turnId: string; itemId: string; itemType?: string; field: "summary" | "content"; index: number; delta: string }
  | { type: "recordIndexedItemOmission"; turnId: string; itemId: string; itemType?: string; field: "summary" | "content"; omitted: number }
  | { type: "clearActiveReasoningItems" }
  | { type: "setTurnDiff"; turnId: string; diff: string }
  | { type: "setTurnPlan"; turnId: string; plan: TurnPlan }
  | { type: "recordTurnRecoveryOmission"; threadId?: string; turnId: string; method: string }
  | { type: "addRequest"; request: PendingRequest }
  | { type: "recordCommandApprovalReason"; threadId: string; turnId?: string; itemId: string; reason: string }
  | { type: "removeRequest"; id: string | number }
  | { type: "clearRequests" }
  | { type: "settings"; settings: Partial<ThreadSettings> }
  | { type: "threadSettings"; threadId: string; settings: Partial<ThreadSettings> }
  | { type: "toast"; toast: ToastMessage }
  | { type: "removeToast"; id: number };

export const initialState: AppState = {
  connection: "connecting",
  connectionDetail: "Connecting",
  threads: [],
  archivedThreads: [],
  selectedThreadId: null,
  currentThread: null,
  turnHistory: {
    threadId: null,
    nextCursor: null,
    loadingCursor: null,
    status: "idle",
    error: null,
  },
  activeTurnId: null,
  activeReasoningItemIdsByTurn: {},
  pendingRequests: [],
  commandApprovalReasons: {},
  settings: {
    cwd: "",
    model: "",
    effort: "",
    sandbox: "workspace-write",
  },
  toasts: [],
};

const DEFAULT_STREAM_FIELD_LIMIT = 400_000;
const COMMAND_STREAM_FIELD_LIMIT = 300_000;
const INDEXED_STREAM_PART_LIMIT = 100_000;
// Completed app-server command items omit approval rationale, so keep a bounded session projection.
const COMMAND_APPROVAL_REASON_LIMIT = 2_000;
const COMMAND_APPROVAL_REASONS_PER_ITEM = 4;
const COMMAND_APPROVAL_ITEM_LIMIT = 256;

function commandApprovalKey(threadId: string, turnId: string | undefined, itemId: string): string {
  return JSON.stringify([threadId, turnId ?? null, itemId]);
}

function boundedApprovalReasons(existing: readonly string[], reason: string): string[] {
  const bounded = reason.trim().slice(0, COMMAND_APPROVAL_REASON_LIMIT);
  if (!bounded || existing.includes(bounded)) return [...existing];
  return [...existing, bounded].slice(-COMMAND_APPROVAL_REASONS_PER_ITEM);
}

function withApprovalReasons(item: CodexItem, reasons: readonly string[] | undefined): CodexItem {
  if (reasons && reasons.length > 0) return { ...item, approvalReasons: [...reasons] };
  if (item.approvalReasons === undefined) return item;
  const next = { ...item };
  delete next.approvalReasons;
  return next;
}

interface ApprovalReasonProjection {
  thread: CodexThread;
  reasonsByItem: Record<string, string[]>;
}

function projectApprovalReasons(
  thread: CodexThread,
  reasonsByItem: Readonly<Record<string, string[]>>,
): ApprovalReasonProjection {
  if (!thread.turns) return { thread, reasonsByItem: { ...reasonsByItem } };

  let projectedReasons = { ...reasonsByItem };
  const commandTurns = new Map<string, string[]>();
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type !== "commandExecution") continue;
      const turnIds = commandTurns.get(item.id) ?? [];
      turnIds.push(turn.id);
      commandTurns.set(item.id, turnIds);
    }
  }

  for (const [itemId, turnIds] of commandTurns) {
    const legacyKey = commandApprovalKey(thread.id, undefined, itemId);
    const legacyReasons = projectedReasons[legacyKey];
    if (!legacyReasons?.length) continue;
    if (turnIds.length !== 1) {
      delete projectedReasons[legacyKey];
      continue;
    }

    const modernKey = commandApprovalKey(thread.id, turnIds[0], itemId);
    let reasons = projectedReasons[modernKey] ?? [];
    for (const reason of legacyReasons) {
      reasons = boundedApprovalReasons(reasons, reason);
    }
    delete projectedReasons[legacyKey];
    projectedReasons = rememberApprovalReasons(projectedReasons, modernKey, reasons);
  }

  const projectedThread = {
    ...thread,
    turns: thread.turns.map((turn) => ({
      ...turn,
      items: turn.items.map((item) => {
        if (item.type !== "commandExecution") return withApprovalReasons(item, undefined);
        return withApprovalReasons(
          item,
          projectedReasons[commandApprovalKey(thread.id, turn.id, item.id)],
        );
      }),
    })),
  };
  return { thread: projectedThread, reasonsByItem: projectedReasons };
}

function rememberApprovalReasons(
  current: Readonly<Record<string, string[]>>,
  key: string,
  reasons: string[],
): Record<string, string[]> {
  const next = { ...current };
  delete next[key];
  next[key] = reasons;
  const keys = Object.keys(next);
  for (let index = 0; index < keys.length - COMMAND_APPROVAL_ITEM_LIMIT; index += 1) {
    delete next[keys[index]];
  }
  return next;
}

interface BoundedText {
  value: string;
  omitted: number;
}

function boundedStreamText(
  current: string,
  delta: string,
  maximum: number,
  previouslyOmitted: number,
  preserveTail: boolean,
): BoundedText {
  const combined = `${current}${delta}`;
  if (combined.length <= maximum) return { value: combined, omitted: previouslyOmitted };

  const newlyOmitted = combined.length - maximum;
  const omitted = Math.min(Number.MAX_SAFE_INTEGER, previouslyOmitted + newlyOmitted);
  if (!preserveTail) return { value: combined.slice(0, maximum), omitted };

  const headLength = Math.floor(maximum * 0.7);
  return {
    value: `${combined.slice(0, headLength)}${combined.slice(-(maximum - headLength))}`,
    omitted,
  };
}

function itemOmissions(item: CodexItem): Record<string, number> {
  return item.streamOmittedCharacters && typeof item.streamOmittedCharacters === "object"
    ? { ...item.streamOmittedCharacters }
    : {};
}

function withOmission(
  item: CodexItem,
  key: string,
  omitted: number,
): CodexItem {
  if (omitted <= 0) return item;
  return {
    ...item,
    streamOmittedCharacters: { ...itemOmissions(item), [key]: omitted },
  };
}

function incrementOmission(item: CodexItem, key: string, count: number): CodexItem {
  if (!Number.isSafeInteger(count) || count <= 0) return item;
  const current = itemOmissions(item)[key];
  const previous = Number.isSafeInteger(current) && current >= 0 ? current : 0;
  return withOmission(
    item,
    key,
    Math.min(Number.MAX_SAFE_INTEGER, previous + count),
  );
}

function appendBoundedItemField(item: CodexItem, field: string, delta: string): CodexItem {
  const omissions = itemOmissions(item);
  const isCommandOutput = field === "aggregatedOutput" || field === "output";
  const next = boundedStreamText(
    typeof item[field] === "string" ? item[field] : "",
    delta,
    isCommandOutput ? COMMAND_STREAM_FIELD_LIMIT : DEFAULT_STREAM_FIELD_LIMIT,
    omissions[field] ?? 0,
    isCommandOutput,
  );
  return withOmission({ ...item, [field]: next.value }, field, next.omitted);
}

function mergeCompletedItem(existing: CodexItem, incoming: CodexItem): CodexItem {
  const merged: CodexItem = { ...existing, ...incoming };
  const omissions = itemOmissions(existing);
  for (const key of Object.keys(omissions)) {
    const field = key.replace(/\[[^\]]+\]$/, "");
    if (incoming[field] !== undefined) delete omissions[key];
  }
  if (Object.keys(omissions).length > 0) {
    merged.streamOmittedCharacters = omissions;
  } else {
    delete merged.streamOmittedCharacters;
  }
  return merged;
}

function mergeStartedItem(existing: CodexItem, incoming: CodexItem): CodexItem {
  return {
    ...incoming,
    ...existing,
    id: incoming.id,
    type: incoming.type,
  };
}

function sortThreads(threads: CodexThread[]): CodexThread[] {
  const timestamp = (thread: CodexThread): number => {
    return timestampMilliseconds(threadRecencyTimestamp(thread)) ?? 0;
  };
  return [...threads].sort((a, b) => timestamp(b) - timestamp(a));
}

function threadSummary(thread: CodexThread): CodexThread {
  const summary = { ...thread };
  delete summary.turns;
  return summary;
}

// Hydrated thread snapshots can be older than thread/list's repaired metadata.
function latestThreadRecency(
  existing: CodexThread,
  incoming: CodexThread,
): number | string | undefined {
  const existingValue = threadRecencyTimestamp(existing);
  const incomingValue = threadRecencyTimestamp(incoming);
  const existingTimestamp = timestampMilliseconds(existingValue);
  const incomingTimestamp = timestampMilliseconds(incomingValue);
  if (incomingTimestamp === null) return existingTimestamp === null ? undefined : existingValue;
  if (existingTimestamp === null || incomingTimestamp >= existingTimestamp) return incomingValue;
  return existingValue;
}

function upsertThread(threads: CodexThread[], thread: CodexThread): CodexThread[] {
  const index = threads.findIndex((entry) => entry.id === thread.id);
  const summary = threadSummary(thread);
  if (index < 0) return sortThreads([summary, ...threads]);
  const next = [...threads];
  const existing = threadSummary(next[index]);
  next[index] = mergeThreadSummary(existing, summary);
  return sortThreads(next);
}

function mergeThreadSummary(existing: CodexThread, incoming: CodexThread): CodexThread {
  const recencyAt = latestThreadRecency(existing, incoming);
  return {
    ...existing,
    ...incoming,
    ...(recencyAt !== undefined ? { recencyAt } : {}),
  };
}

function clearSelectedThread(state: AppState, threadId: string): AppState {
  if (state.selectedThreadId !== threadId && state.currentThread?.id !== threadId) return state;
  return {
    ...state,
    selectedThreadId: null,
    currentThread: null,
    activeTurnId: null,
    activeReasoningItemIdsByTurn: {},
    turnHistory: idleTurnHistory(null),
  };
}

function requestThreadId(request: PendingRequest): string | undefined {
  const value = request.params.threadId ?? request.params.conversationId;
  return typeof value === "string" ? value : undefined;
}

function withoutThreadApprovalReasons(
  reasons: Readonly<Record<string, string[]>>,
  threadId: string,
): Record<string, string[]> {
  return Object.fromEntries(Object.entries(reasons).filter(([key]) => {
    try {
      const parsed: unknown = JSON.parse(key);
      return !Array.isArray(parsed) || parsed[0] !== threadId;
    } catch {
      return true;
    }
  }));
}

function updateTurn(
  thread: CodexThread | null,
  turnId: string,
  update: (turn: CodexTurn) => CodexTurn,
): CodexThread | null {
  if (!thread) return thread;
  const turns = thread.turns ?? [];
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) return thread;
  const nextTurns = [...turns];
  nextTurns[index] = update(nextTurns[index]);
  return { ...thread, turns: nextTurns };
}

function updateActiveReasoningItem(
  current: Readonly<Record<string, string[]>>,
  turnId: string,
  itemId: string,
  active: boolean,
): Record<string, string[]> {
  const existing = current[turnId] ?? [];
  const includes = existing.includes(itemId);
  if (includes === active) return current as Record<string, string[]>;
  const next = { ...current };
  if (active) next[turnId] = [...existing, itemId];
  else {
    const remaining = existing.filter((id) => id !== itemId);
    if (remaining.length > 0) next[turnId] = remaining;
    else delete next[turnId];
  }
  return next;
}

function withoutActiveReasoningTurn(
  current: Readonly<Record<string, string[]>>,
  turnId: string,
): Record<string, string[]> {
  if (current[turnId] === undefined) return current as Record<string, string[]>;
  const next = { ...current };
  delete next[turnId];
  return next;
}

function idleTurnHistory(threadId: string | null, nextCursor: string | null = null): TurnHistoryState {
  return {
    threadId,
    nextCursor,
    loadingCursor: null,
    status: "idle",
    error: null,
  };
}

function uniqueTurnsInOrder(turns: CodexTurn[]): CodexTurn[] {
  const seen = new Set<string>();
  return turns.filter((turn) => {
    if (seen.has(turn.id)) return false;
    seen.add(turn.id);
    return true;
  });
}

function itemsViewRank(value: unknown): number {
  if (value === "full") return 3;
  if (value === "summary") return 2;
  if (value === "notLoaded") return 1;
  return 0;
}

function moreCompleteItemsView(existing: unknown, snapshot: unknown): unknown {
  const existingRank = itemsViewRank(existing);
  const snapshotRank = itemsViewRank(snapshot);
  if (snapshotRank > existingRank) return snapshot;
  if (existingRank > snapshotRank) return existing;
  return existing ?? snapshot;
}

function reconcileSnapshotTurn(existing: CodexTurn, snapshot: CodexTurn): CodexTurn {
  if (snapshot.itemsView === "full") {
    const reconciled = { ...existing, ...snapshot };
    delete reconciled.historyDetail;
    return reconciled;
  }

  const reconciled: CodexTurn = {
    ...existing,
    ...snapshot,
    items: existing.items,
  };
  const itemsView = moreCompleteItemsView(existing.itemsView, snapshot.itemsView);
  if (itemsView === undefined) delete reconciled.itemsView;
  else reconciled.itemsView = itemsView;
  if (existing.historyDetail !== undefined) {
    reconciled.historyDetail = existing.historyDetail;
  }
  if (itemsView === "full") {
    delete reconciled.historyDetail;
  }
  return reconciled;
}

function reconcileTurns(existing: CodexTurn[], snapshot: CodexTurn[]): CodexTurn[] {
  const uniqueSnapshot = uniqueTurnsInOrder(snapshot);
  const snapshotById = new Map(uniqueSnapshot.map((turn) => [turn.id, turn]));
  const reconciled = existing.map((turn) => {
    const replacement = snapshotById.get(turn.id);
    snapshotById.delete(turn.id);
    return replacement ? reconcileSnapshotTurn(turn, replacement) : turn;
  });
  for (const turn of uniqueSnapshot) {
    if (snapshotById.has(turn.id)) {
      reconciled.push(turn);
      snapshotById.delete(turn.id);
    }
  }
  return reconciled;
}

function prependUniqueTurns(existing: CodexTurn[], older: CodexTurn[]): CodexTurn[] {
  const seen = new Set(existing.map((turn) => turn.id));
  const uniqueOlder: CodexTurn[] = [];
  for (const turn of older) {
    if (seen.has(turn.id)) continue;
    seen.add(turn.id);
    uniqueOlder.push(turn);
  }
  return [...uniqueOlder, ...existing];
}

function uniqueItemsInOrder(items: CodexItem[]): CodexItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function appendUniqueItems(existing: CodexItem[], later: CodexItem[]): CodexItem[] {
  const seen = new Set(existing.map((item) => item.id));
  return [
    ...existing,
    ...later.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }),
  ];
}

function resetTurnDetailLoading(thread: CodexThread | null): CodexThread | null {
  if (!thread?.turns?.some((turn) => turn.historyDetail?.status === "loading")) return thread;
  return {
    ...thread,
    turns: thread.turns.map((turn) => turn.historyDetail?.status === "loading"
      ? {
          ...turn,
          historyDetail: {
            ...turn.historyDetail,
            status: "idle",
            error: null,
          },
        }
      : turn),
  };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "connection":
      return {
        ...state,
        connection: action.state,
        connectionDetail: action.detail ?? action.state,
        activeReasoningItemIdsByTurn: action.state === "connected"
          ? state.activeReasoningItemIdsByTurn
          : {},
      };
    case "setThreads": {
      let threads = sortThreads(action.threads.map(threadSummary));
      for (const threadId of new Set(action.protectedThreadIds ?? [])) {
        if (threads.some((thread) => thread.id === threadId)) continue;
        const listed = state.threads.find((thread) => thread.id === threadId);
        const current = state.currentThread?.id === threadId
          ? threadSummary(state.currentThread)
          : undefined;
        const preserved = listed && current
          ? mergeThreadSummary(current, listed)
          : listed ?? current;
        if (preserved) threads = upsertThread(threads, preserved);
      }
      const listedCurrent = state.currentThread
        ? threads.find((thread) => thread.id === state.currentThread?.id)
        : undefined;
      const currentThread = state.currentThread && listedCurrent
        ? {
            ...state.currentThread,
            ...mergeThreadSummary(threadSummary(state.currentThread), listedCurrent),
          }
        : state.currentThread;
      return { ...state, threads, currentThread };
    }
    case "setArchivedThreads":
      return { ...state, archivedThreads: sortThreads(action.threads.map(threadSummary)) };
    case "archiveThread": {
      const archived = state.threads.find((thread) => thread.id === action.threadId);
      const moved = {
        ...state,
        threads: state.threads.filter((thread) => thread.id !== action.threadId),
        archivedThreads: archived
          ? upsertThread(state.archivedThreads, archived)
          : state.archivedThreads,
      };
      return clearSelectedThread(moved, action.threadId);
    }
    case "unarchiveThread": {
      const restored = action.thread ?? state.archivedThreads.find((thread) => (
        thread.id === action.threadId
      ));
      return {
        ...state,
        threads: restored ? upsertThread(state.threads, restored) : state.threads,
        archivedThreads: state.archivedThreads.filter((thread) => thread.id !== action.threadId),
      };
    }
    case "deleteThread": {
      const removed = clearSelectedThread({
        ...state,
        threads: state.threads.filter((thread) => thread.id !== action.threadId),
        archivedThreads: state.archivedThreads.filter((thread) => thread.id !== action.threadId),
        pendingRequests: state.pendingRequests.filter((request) => (
          requestThreadId(request) !== action.threadId
        )),
        commandApprovalReasons: withoutThreadApprovalReasons(
          state.commandApprovalReasons,
          action.threadId,
        ),
      }, action.threadId);
      return removed;
    }
    case "selectThread":
      return {
        ...state,
        selectedThreadId: action.threadId,
        currentThread: action.threadId === state.currentThread?.id
          ? resetTurnDetailLoading(state.currentThread)
          : null,
        activeTurnId: null,
        activeReasoningItemIdsByTurn: {},
        turnHistory: action.threadId === state.turnHistory.threadId
          ? idleTurnHistory(action.threadId, state.turnHistory.nextCursor)
          : idleTurnHistory(action.threadId),
      };
    case "setCurrentThread": {
      const normalizedThread = action.thread.turns === undefined
        ? action.thread
        : { ...action.thread, turns: uniqueTurnsInOrder(action.thread.turns) };
      const projection = projectApprovalReasons(normalizedThread, state.commandApprovalReasons);
      const thread = projection.thread;
      const active = [...(thread.turns ?? [])]
        .reverse()
        .find((turn) => turn.status === "inProgress")?.id ?? null;
      return {
        ...state,
        commandApprovalReasons: projection.reasonsByItem,
        selectedThreadId: thread.id,
        currentThread: thread,
        turnHistory: action.history
          ? idleTurnHistory(thread.id, action.history.nextCursor)
          : state.currentThread?.id === thread.id
            ? state.turnHistory
            : idleTurnHistory(thread.id),
        activeTurnId: active,
        activeReasoningItemIdsByTurn: {},
        threads: upsertThread(state.threads, thread),
        archivedThreads: state.archivedThreads.filter((entry) => entry.id !== thread.id),
      };
    }
    case "reconcileCurrentThread": {
      if (
        state.selectedThreadId !== action.thread.id ||
        state.currentThread?.id !== action.thread.id
      ) {
        return state;
      }
      const turns = reconcileTurns(
        state.currentThread.turns ?? [],
        action.thread.turns ?? [],
      );
      const projection = projectApprovalReasons(
        { ...state.currentThread, ...action.thread, turns },
        state.commandApprovalReasons,
      );
      const thread = projection.thread;
      const activeTurnId = [...turns]
        .reverse()
        .find((turn) => turn.status === "inProgress")?.id ?? null;
      return {
        ...state,
        commandApprovalReasons: projection.reasonsByItem,
        currentThread: thread,
        activeTurnId,
        activeReasoningItemIdsByTurn: {},
        threads: upsertThread(state.threads, thread),
      };
    }
    case "loadOlderTurnsStarted":
      if (
        state.currentThread?.id !== action.threadId ||
        state.turnHistory.threadId !== action.threadId ||
        state.turnHistory.nextCursor !== action.cursor ||
        state.turnHistory.status === "loading"
      ) {
        return state;
      }
      return {
        ...state,
        turnHistory: {
          ...state.turnHistory,
          loadingCursor: action.cursor,
          status: "loading",
          error: null,
        },
      };
    case "prependOlderTurns": {
      if (
        state.currentThread?.id !== action.threadId ||
        state.turnHistory.threadId !== action.threadId ||
        state.turnHistory.loadingCursor !== action.cursor
      ) {
        return state;
      }
      const projection = projectApprovalReasons({
        ...state.currentThread,
        turns: prependUniqueTurns(state.currentThread.turns ?? [], action.turns),
      }, state.commandApprovalReasons);
      return {
        ...state,
        commandApprovalReasons: projection.reasonsByItem,
        currentThread: projection.thread,
        turnHistory: idleTurnHistory(action.threadId, action.nextCursor),
      };
    }
    case "loadOlderTurnsFailed":
      if (
        state.currentThread?.id !== action.threadId ||
        state.turnHistory.threadId !== action.threadId ||
        state.turnHistory.loadingCursor !== action.cursor
      ) {
        return state;
      }
      return {
        ...state,
        turnHistory: {
          ...state.turnHistory,
          loadingCursor: null,
          status: "error",
          error: action.error,
        },
      };
    case "loadTurnDetailStarted":
      if (state.currentThread?.id !== action.threadId) return state;
      return {
        ...state,
        currentThread: updateTurn(state.currentThread, action.turnId, (turn) => {
          if (
            !turn.historyDetail ||
            turn.historyDetail.cursor !== action.cursor ||
            turn.historyDetail.nextItemCursor !== action.itemCursor ||
            turn.status === "inProgress" ||
            turn.historyDetail.status === "loading" ||
            turn.historyDetail.status === "unavailable"
          ) {
            return turn;
          }
          return {
            ...turn,
            historyDetail: {
              ...turn.historyDetail,
              status: "loading",
              error: null,
            },
          };
        }),
      };
    case "loadTurnItemPageSucceeded":
      if (state.currentThread?.id !== action.threadId) return state;
      {
        const currentThread = updateTurn(state.currentThread, action.turnId, (turn) => {
          if (
            !turn.historyDetail ||
            turn.historyDetail.cursor !== action.cursor ||
            turn.historyDetail.nextItemCursor !== action.itemCursor ||
            turn.historyDetail.status !== "loading"
          ) {
            return turn;
          }
          const items = action.itemCursor === undefined
            ? uniqueItemsInOrder(action.items)
            : appendUniqueItems(turn.items, action.items);
          if (action.nextItemCursor === null) {
            const complete = { ...turn, items, itemsView: "full" };
            delete complete.historyDetail;
            return complete;
          }
          return {
            ...turn,
            items,
            historyDetail: {
              ...turn.historyDetail,
              nextItemCursor: action.nextItemCursor,
              status: "idle",
              error: null,
            },
          };
        });
        if (!currentThread) return { ...state, currentThread };
        const projection = projectApprovalReasons(currentThread, state.commandApprovalReasons);
        return {
          ...state,
          commandApprovalReasons: projection.reasonsByItem,
          currentThread: projection.thread,
        };
      }
    case "loadTurnDetailSucceeded":
      if (state.currentThread?.id !== action.threadId || action.turn.id !== action.turnId) return state;
      {
        const currentThread = updateTurn(state.currentThread, action.turnId, (turn) => {
          if (
            !turn.historyDetail ||
            turn.historyDetail.cursor !== action.cursor ||
            turn.historyDetail.nextItemCursor !== action.itemCursor ||
            turn.historyDetail.status !== "loading"
          ) {
            return turn;
          }
          const replacement = { ...turn, ...action.turn, items: action.turn.items };
          delete replacement.historyDetail;
          return replacement;
        });
        if (!currentThread) return { ...state, currentThread };
        const projection = projectApprovalReasons(currentThread, state.commandApprovalReasons);
        return {
          ...state,
          commandApprovalReasons: projection.reasonsByItem,
          currentThread: projection.thread,
        };
      }
    case "loadTurnDetailFailed":
      if (state.currentThread?.id !== action.threadId) return state;
      return {
        ...state,
        currentThread: updateTurn(state.currentThread, action.turnId, (turn) => {
          if (
            !turn.historyDetail ||
            turn.historyDetail.cursor !== action.cursor ||
            turn.historyDetail.nextItemCursor !== action.itemCursor ||
            turn.historyDetail.status !== "loading"
          ) {
            return turn;
          }
          return {
            ...turn,
            historyDetail: {
              ...turn.historyDetail,
              status: action.unavailable ? "unavailable" : "error",
              error: action.error,
            },
          };
        }),
      };
    case "upsertThread": {
      const summary = threadSummary(action.thread);
      const currentSummary = state.currentThread?.id === summary.id
        ? threadSummary(state.currentThread)
        : undefined;
      const enrichedSummary = currentSummary
        ? mergeThreadSummary(currentSummary, summary)
        : summary;
      return {
        ...state,
        threads: upsertThread(state.threads, enrichedSummary),
        currentThread:
          state.currentThread?.id === enrichedSummary.id
            ? { ...state.currentThread, ...enrichedSummary }
            : state.currentThread,
      };
    }
    case "upsertTurn": {
      if (action.threadId && action.threadId !== state.selectedThreadId) return state;
      if (!state.currentThread) return state;
      const incomingTurn = action.turn;
      const turns = state.currentThread.turns ?? [];
      const index = turns.findIndex((turn) => turn.id === incomingTurn.id);
      const nextTurns = [...turns];
      if (index < 0) nextTurns.push(incomingTurn);
      else nextTurns[index] = reconcileSnapshotTurn(nextTurns[index], incomingTurn);
      const projection = projectApprovalReasons(
        { ...state.currentThread, turns: nextTurns },
        state.commandApprovalReasons,
      );
      return {
        ...state,
        commandApprovalReasons: projection.reasonsByItem,
        currentThread: projection.thread,
        activeTurnId: incomingTurn.status === "inProgress"
          ? incomingTurn.id
          : state.activeTurnId === incomingTurn.id ? null : state.activeTurnId,
        activeReasoningItemIdsByTurn: incomingTurn.status === "inProgress"
          ? state.activeReasoningItemIdsByTurn
          : withoutActiveReasoningTurn(state.activeReasoningItemIdsByTurn, incomingTurn.id),
      };
    }
    case "setTurnStatus": {
      const currentThread = updateTurn(state.currentThread, action.turnId, (turn) => ({
        ...turn,
        status: action.status,
        ...(action.error !== undefined ? { error: action.error } : {}),
      }));
      return {
        ...state,
        currentThread,
        activeTurnId: action.status === "inProgress"
          ? action.turnId
          : state.activeTurnId === action.turnId ? null : state.activeTurnId,
        activeReasoningItemIdsByTurn: action.status === "inProgress"
          ? state.activeReasoningItemIdsByTurn
          : withoutActiveReasoningTurn(state.activeReasoningItemIdsByTurn, action.turnId),
      };
    }
    case "upsertItem": {
      if (!state.currentThread?.turns?.some((turn) => turn.id === action.turnId)) return state;
      const incomingItem = action.item;
      const currentThread = updateTurn(state.currentThread, action.turnId, (turn) => {
        const index = turn.items.findIndex((item) => item.id === incomingItem.id);
        if (index < 0) return { ...turn, items: [...turn.items, incomingItem] };
        const items = [...turn.items];
        items[index] = action.lifecycle === "started"
          ? mergeStartedItem(items[index], incomingItem)
          : mergeCompletedItem(items[index], incomingItem);
        return { ...turn, items };
      });
      if (!currentThread) return { ...state, currentThread };
      const projection = projectApprovalReasons(currentThread, state.commandApprovalReasons);
      return {
        ...state,
        commandApprovalReasons: projection.reasonsByItem,
        currentThread: projection.thread,
        activeReasoningItemIdsByTurn: incomingItem.type === "reasoning"
          ? updateActiveReasoningItem(
              state.activeReasoningItemIdsByTurn,
              action.turnId,
              incomingItem.id,
              action.lifecycle === "started",
            )
          : state.activeReasoningItemIdsByTurn,
      };
    }
    case "appendItemDelta": {
      const currentThread = updateTurn(state.currentThread, action.turnId, (turn) => {
        const found = turn.items.some((item) => item.id === action.itemId);
        if (!found) {
          const item = appendBoundedItemField({
            id: action.itemId,
            type: action.itemType ?? "unknown",
            status: "inProgress",
          }, action.field, action.delta);
          return {
            ...turn,
            items: [...turn.items, item],
          };
        }
        return {
          ...turn,
          items: turn.items.map((item) => item.id === action.itemId
            ? appendBoundedItemField(item, action.field, action.delta)
            : item),
        };
      });
      return { ...state, currentThread };
    }
    case "appendIndexedItemDelta": {
      const turnExists = state.currentThread?.turns?.some((turn) => turn.id === action.turnId) === true;
      const currentThread = updateTurn(state.currentThread, action.turnId, (turn) => {
        const found = turn.items.some((item) => item.id === action.itemId);
        if (!found) {
          const parts: string[] = [];
          const next = boundedStreamText("", action.delta, INDEXED_STREAM_PART_LIMIT, 0, false);
          parts[action.index] = next.value;
          const item = withOmission({
            id: action.itemId,
            type: action.itemType ?? "unknown",
            status: "inProgress",
            [action.field]: parts,
          }, `${action.field}[${action.index}]`, next.omitted);
          return {
            ...turn,
            items: [...turn.items, item],
          };
        }
        return {
          ...turn,
          items: turn.items.map((item) => {
            if (item.id !== action.itemId) return item;
            const current = Array.isArray(item[action.field]) ? [...item[action.field] as unknown[]] : [];
            const omissionKey = `${action.field}[${action.index}]`;
            const currentPart = current[action.index];
            const next = boundedStreamText(
              typeof currentPart === "string" ? currentPart : "",
              action.delta,
              INDEXED_STREAM_PART_LIMIT,
              itemOmissions(item)[omissionKey] ?? 0,
              false,
            );
            current[action.index] = next.value;
            return withOmission({ ...item, [action.field]: current }, omissionKey, next.omitted);
          }),
        };
      });
      return {
        ...state,
        currentThread,
        activeReasoningItemIdsByTurn: turnExists
          ? updateActiveReasoningItem(
              state.activeReasoningItemIdsByTurn,
              action.turnId,
              action.itemId,
              true,
            )
          : state.activeReasoningItemIdsByTurn,
      };
    }
    case "recordIndexedItemOmission": {
      const turnExists = state.currentThread?.turns?.some((turn) => turn.id === action.turnId) === true;
      const currentThread = updateTurn(state.currentThread, action.turnId, (turn) => {
        const omissionKey = `${action.field}[overflow]`;
        const index = turn.items.findIndex((item) => item.id === action.itemId);
        if (index < 0) {
          return {
            ...turn,
            items: [...turn.items, incrementOmission({
              id: action.itemId,
              type: action.itemType ?? "unknown",
              status: "inProgress",
            }, omissionKey, action.omitted)],
          };
        }
        const items = [...turn.items];
        items[index] = incrementOmission(items[index], omissionKey, action.omitted);
        return { ...turn, items };
      });
      return {
        ...state,
        currentThread,
        activeReasoningItemIdsByTurn: turnExists
          ? updateActiveReasoningItem(
              state.activeReasoningItemIdsByTurn,
              action.turnId,
              action.itemId,
              true,
            )
          : state.activeReasoningItemIdsByTurn,
      };
    }
    case "clearActiveReasoningItems":
      return Object.keys(state.activeReasoningItemIdsByTurn).length === 0
        ? state
        : { ...state, activeReasoningItemIdsByTurn: {} };
    case "setTurnDiff":
      return {
        ...state,
        currentThread: updateTurn(state.currentThread, action.turnId, (turn) => ({
          ...turn,
          diff: action.diff,
          recoveryOmissions: turn.recoveryOmissions?.filter((method) => method !== "turn/diff/updated"),
        })),
      };
    case "setTurnPlan":
      return {
        ...state,
        currentThread: updateTurn(state.currentThread, action.turnId, (turn) => ({
          ...turn,
          plan: action.plan,
          recoveryOmissions: turn.recoveryOmissions?.filter((method) => method !== "turn/plan/updated"),
        })),
      };
    case "recordTurnRecoveryOmission": {
      if (action.threadId && action.threadId !== state.currentThread?.id) return state;
      return {
        ...state,
        currentThread: updateTurn(state.currentThread, action.turnId, (turn) => ({
          ...turn,
          recoveryOmissions: [...new Set([...(turn.recoveryOmissions ?? []), action.method])],
        })),
      };
    }
    case "addRequest":
      return {
        ...state,
        pendingRequests: [
          ...state.pendingRequests.filter((request) => request.id !== action.request.id),
          action.request,
        ],
      };
    case "recordCommandApprovalReason": {
      const key = commandApprovalKey(action.threadId, action.turnId, action.itemId);
      const reasons = boundedApprovalReasons(state.commandApprovalReasons[key] ?? [], action.reason);
      if (reasons.length === 0) return state;
      const commandApprovalReasons = rememberApprovalReasons(
        state.commandApprovalReasons,
        key,
        reasons,
      );
      if (state.currentThread?.id !== action.threadId) {
        return { ...state, commandApprovalReasons };
      }
      const projection = projectApprovalReasons(state.currentThread, commandApprovalReasons);
      return {
        ...state,
        commandApprovalReasons: projection.reasonsByItem,
        currentThread: projection.thread,
      };
    }
    case "removeRequest":
      return { ...state, pendingRequests: state.pendingRequests.filter((request) => request.id !== action.id) };
    case "clearRequests":
      return { ...state, pendingRequests: [] };
    case "settings":
      return { ...state, settings: { ...state.settings, ...action.settings } };
    case "threadSettings":
      return action.threadId === state.selectedThreadId
        ? { ...state, settings: { ...state.settings, ...action.settings } }
        : state;
    case "toast":
      return { ...state, toasts: [...state.toasts, action.toast].slice(-4) };
    case "removeToast":
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };
    default:
      return state;
  }
}
