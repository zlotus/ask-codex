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
  activeTurnId: string | null;
  pendingRequests: PendingRequest[];
  settings: ThreadSettings;
  toasts: ToastMessage[];
}

export type AppAction =
  | { type: "connection"; state: ConnectionState; detail?: string }
  | { type: "setThreads"; threads: CodexThread[] }
  | { type: "selectThread"; threadId: string | null }
  | { type: "setCurrentThread"; thread: CodexThread }
  | { type: "upsertThread"; thread: CodexThread }
  | { type: "upsertTurn"; turn: CodexTurn; threadId?: string }
  | { type: "setTurnStatus"; turnId: string; status: string; error?: unknown }
  | { type: "upsertItem"; turnId: string; item: CodexItem }
  | { type: "appendItemDelta"; turnId: string; itemId: string; itemType?: string; field: string; delta: string }
  | { type: "appendIndexedItemDelta"; turnId: string; itemId: string; itemType?: string; field: "summary" | "content"; index: number; delta: string }
  | { type: "setTurnDiff"; turnId: string; diff: string }
  | { type: "setTurnPlan"; turnId: string; plan: TurnPlan }
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

function upsertThread(threads: CodexThread[], thread: CodexThread): CodexThread[] {
  const index = threads.findIndex((entry) => entry.id === thread.id);
  if (index < 0) return sortThreads([thread, ...threads]);
  const next = [...threads];
  next[index] = { ...next[index], ...thread };
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

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "connection":
      return {
        ...state,
        connection: action.state,
        connectionDetail: action.detail ?? action.state,
      };
    case "setThreads":
      return { ...state, threads: sortThreads(action.threads) };
    case "selectThread":
      return {
        ...state,
        selectedThreadId: action.threadId,
        currentThread: action.threadId === state.currentThread?.id ? state.currentThread : null,
        activeTurnId: null,
      };
    case "setCurrentThread": {
      const active = [...(action.thread.turns ?? [])]
        .reverse()
        .find((turn) => turn.status === "inProgress")?.id ?? null;
      return {
        ...state,
        selectedThreadId: action.thread.id,
        currentThread: action.thread,
        activeTurnId: active,
        threads: upsertThread(state.threads, action.thread),
      };
    }
    case "upsertThread":
      return {
        ...state,
        threads: upsertThread(state.threads, action.thread),
        currentThread:
          state.currentThread?.id === action.thread.id
            ? { ...state.currentThread, ...action.thread }
            : state.currentThread,
      };
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
        items[index] = { ...items[index], ...action.item };
        return { ...turn, items };
      });
      return { ...state, currentThread };
    }
    case "appendItemDelta": {
      const currentThread = updateTurn(state.currentThread, action.turnId, (turn) => {
        const found = turn.items.some((item) => item.id === action.itemId);
        if (!found) {
          return {
            ...turn,
            items: [...turn.items, {
              id: action.itemId,
              type: action.itemType ?? "unknown",
              status: "inProgress",
              [action.field]: action.delta,
            }],
          };
        }
        return {
          ...turn,
          items: turn.items.map((item) => item.id === action.itemId
            ? { ...item, [action.field]: `${typeof item[action.field] === "string" ? item[action.field] : ""}${action.delta}` }
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
          parts[action.index] = action.delta;
          return {
            ...turn,
            items: [...turn.items, {
              id: action.itemId,
              type: action.itemType ?? "unknown",
              status: "inProgress",
              [action.field]: parts,
            }],
          };
        }
        return {
          ...turn,
          items: turn.items.map((item) => {
            if (item.id !== action.itemId) return item;
            const current = Array.isArray(item[action.field]) ? [...item[action.field] as unknown[]] : [];
            current[action.index] = `${typeof current[action.index] === "string" ? current[action.index] : ""}${action.delta}`;
            return { ...item, [action.field]: current };
          }),
        };
      });
      return { ...state, currentThread };
    }
    case "setTurnDiff":
      return {
        ...state,
        currentThread: updateTurn(state.currentThread, action.turnId, (turn) => ({ ...turn, diff: action.diff })),
      };
    case "setTurnPlan":
      return {
        ...state,
        currentThread: updateTurn(state.currentThread, action.turnId, (turn) => ({ ...turn, plan: action.plan })),
      };
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
