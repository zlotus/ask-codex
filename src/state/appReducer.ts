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

export interface AppState {
  connection: ConnectionState;
  connectionDetail: string;
  threads: CodexThread[];
  selectedThreadId: string | null;
  currentThread: CodexThread | null;
  turnHistory: TurnHistoryState;
  activeTurnId: string | null;
  pendingRequests: PendingRequest[];
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
  | { type: "setThreads"; threads: CodexThread[] }
  | { type: "selectThread"; threadId: string | null }
  | { type: "setCurrentThread"; thread: CodexThread; history?: { nextCursor: string | null } }
  | { type: "reconcileCurrentThread"; thread: CodexThread }
  | { type: "loadOlderTurnsStarted"; threadId: string; cursor: string }
  | { type: "prependOlderTurns"; threadId: string; cursor: string; turns: CodexTurn[]; nextCursor: string | null }
  | { type: "loadOlderTurnsFailed"; threadId: string; cursor: string; error: string }
  | { type: "loadTurnDetailStarted"; threadId: string; turnId: string; cursor: string | null }
  | { type: "loadTurnDetailSucceeded"; threadId: string; turnId: string; cursor: string | null; turn: CodexTurn }
  | { type: "loadTurnDetailFailed"; threadId: string; turnId: string; cursor: string | null; error: string }
  | { type: "upsertThread"; thread: CodexThread }
  | { type: "upsertTurn"; turn: CodexTurn; threadId?: string }
  | { type: "setTurnStatus"; turnId: string; status: string; error?: unknown }
  | { type: "upsertItem"; turnId: string; item: CodexItem; lifecycle: "started" | "completed" }
  | { type: "appendItemDelta"; turnId: string; itemId: string; itemType?: string; field: string; delta: string }
  | { type: "appendIndexedItemDelta"; turnId: string; itemId: string; itemType?: string; field: "summary" | "content"; index: number; delta: string }
  | { type: "recordIndexedItemOmission"; turnId: string; itemId: string; itemType?: string; field: "summary" | "content"; omitted: number }
  | { type: "setTurnDiff"; turnId: string; diff: string }
  | { type: "setTurnPlan"; turnId: string; plan: TurnPlan }
  | { type: "recordTurnRecoveryOmission"; threadId?: string; turnId: string; method: string }
  | { type: "addRequest"; request: PendingRequest }
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
  pendingRequests: [],
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
    const value = thread.updatedAt ?? thread.createdAt;
    const numeric = typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined;
    const normalized = numeric !== undefined
      ? Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1000 : numeric
      : value;
    const date = typeof normalized === "number" || typeof normalized === "string" ? new Date(normalized) : null;
    return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
  };
  return [...threads].sort((a, b) => timestamp(b) - timestamp(a));
}

function threadSummary(thread: CodexThread): CodexThread {
  const summary = { ...thread };
  delete summary.turns;
  return summary;
}

function upsertThread(threads: CodexThread[], thread: CodexThread): CodexThread[] {
  const index = threads.findIndex((entry) => entry.id === thread.id);
  const summary = threadSummary(thread);
  if (index < 0) return sortThreads([summary, ...threads]);
  const next = [...threads];
  next[index] = { ...threadSummary(next[index]), ...summary };
  return sortThreads(next);
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

function reconcileSnapshotTurn(existing: CodexTurn, snapshot: CodexTurn): CodexTurn {
  if (snapshot.itemsView !== "summary" && snapshot.itemsView !== undefined) {
    const reconciled = { ...existing, ...snapshot };
    delete reconciled.historyDetail;
    return reconciled;
  }

  const reconciled: CodexTurn = {
    ...existing,
    ...snapshot,
    items: existing.items,
  };
  if (existing.itemsView !== undefined) {
    reconciled.itemsView = existing.itemsView;
  }
  if (existing.historyDetail !== undefined) {
    reconciled.historyDetail = existing.historyDetail;
  } else if (existing.itemsView === "full") {
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
      };
    case "setThreads":
      return { ...state, threads: sortThreads(action.threads.map(threadSummary)) };
    case "selectThread":
      return {
        ...state,
        selectedThreadId: action.threadId,
        currentThread: action.threadId === state.currentThread?.id
          ? resetTurnDetailLoading(state.currentThread)
          : null,
        activeTurnId: null,
        turnHistory: action.threadId === state.turnHistory.threadId
          ? idleTurnHistory(action.threadId, state.turnHistory.nextCursor)
          : idleTurnHistory(action.threadId),
      };
    case "setCurrentThread": {
      const thread = action.thread.turns === undefined
        ? action.thread
        : { ...action.thread, turns: uniqueTurnsInOrder(action.thread.turns) };
      const active = [...(thread.turns ?? [])]
        .reverse()
        .find((turn) => turn.status === "inProgress")?.id ?? null;
      return {
        ...state,
        selectedThreadId: thread.id,
        currentThread: thread,
        turnHistory: action.history
          ? idleTurnHistory(thread.id, action.history.nextCursor)
          : state.currentThread?.id === thread.id
            ? state.turnHistory
            : idleTurnHistory(thread.id),
        activeTurnId: active,
        threads: upsertThread(state.threads, thread),
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
      const thread = { ...state.currentThread, ...action.thread, turns };
      const activeTurnId = [...turns]
        .reverse()
        .find((turn) => turn.status === "inProgress")?.id ?? null;
      return {
        ...state,
        currentThread: thread,
        activeTurnId,
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
      return {
        ...state,
        currentThread: {
          ...state.currentThread,
          turns: prependUniqueTurns(state.currentThread.turns ?? [], action.turns),
        },
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
          if (!turn.historyDetail || turn.historyDetail.cursor !== action.cursor) return turn;
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
    case "loadTurnDetailSucceeded":
      if (state.currentThread?.id !== action.threadId || action.turn.id !== action.turnId) return state;
      return {
        ...state,
        currentThread: updateTurn(state.currentThread, action.turnId, (turn) => {
          if (
            !turn.historyDetail ||
            turn.historyDetail.cursor !== action.cursor ||
            turn.historyDetail.status !== "loading"
          ) {
            return turn;
          }
          const replacement = { ...turn, ...action.turn, items: action.turn.items };
          delete replacement.historyDetail;
          return replacement;
        }),
      };
    case "loadTurnDetailFailed":
      if (state.currentThread?.id !== action.threadId) return state;
      return {
        ...state,
        currentThread: updateTurn(state.currentThread, action.turnId, (turn) => {
          if (
            !turn.historyDetail ||
            turn.historyDetail.cursor !== action.cursor ||
            turn.historyDetail.status !== "loading"
          ) {
            return turn;
          }
          return {
            ...turn,
            historyDetail: {
              ...turn.historyDetail,
              status: "error",
              error: action.error,
            },
          };
        }),
      };
    case "upsertThread": {
      const summary = threadSummary(action.thread);
      return {
        ...state,
        threads: upsertThread(state.threads, summary),
        currentThread:
          state.currentThread?.id === summary.id
            ? { ...state.currentThread, ...summary }
            : state.currentThread,
      };
    }
    case "upsertTurn": {
      if (action.threadId && action.threadId !== state.selectedThreadId) return state;
      if (!state.currentThread) return state;
      const turns = state.currentThread.turns ?? [];
      const index = turns.findIndex((turn) => turn.id === action.turn.id);
      const nextTurns = [...turns];
      if (index < 0) nextTurns.push(action.turn);
      else nextTurns[index] = {
        ...nextTurns[index],
        ...action.turn,
        items: action.turn.items.length > 0 ? action.turn.items : nextTurns[index].items,
      };
      return {
        ...state,
        currentThread: { ...state.currentThread, turns: nextTurns },
        activeTurnId: action.turn.status === "inProgress"
          ? action.turn.id
          : state.activeTurnId === action.turn.id ? null : state.activeTurnId,
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
      };
    }
    case "upsertItem": {
      const currentThread = updateTurn(state.currentThread, action.turnId, (turn) => {
        const index = turn.items.findIndex((item) => item.id === action.item.id);
        if (index < 0) return { ...turn, items: [...turn.items, action.item] };
        const items = [...turn.items];
        items[index] = action.lifecycle === "started"
          ? mergeStartedItem(items[index], action.item)
          : mergeCompletedItem(items[index], action.item);
        return { ...turn, items };
      });
      return { ...state, currentThread };
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
      return { ...state, currentThread };
    }
    case "recordIndexedItemOmission": {
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
      return { ...state, currentThread };
    }
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
