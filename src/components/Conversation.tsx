import { ArrowDown, ArrowUp, Bot, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CodexThread, CodexTurn, FileDownloadHandler } from "../types/protocol";
import {
  sessionFileAttachmentKey,
  type SessionFileAttachmentSnapshot,
} from "../utils/sessionFileAttachments";
import { sessionImagePreviewKey, type SessionImagePreviewSnapshot } from "../utils/sessionImagePreviews";
import { TurnView } from "./TurnView";

interface ConversationProps {
  activeReasoningItemIdsByTurn?: Readonly<Record<string, readonly string[]>>;
  thread: CodexThread | null;
  loading: boolean;
  loadError: string | null;
  historyLoading: boolean;
  hasMore: boolean;
  historyError: string | null;
  fileAttachments?: SessionFileAttachmentSnapshot;
  imagePreviews?: SessionImagePreviewSnapshot;
  onDownloadFile?: FileDownloadHandler;
  onLoadEarlier: () => void;
  onLoadTurnDetail: (turnId: string) => void;
  onRetryThread: () => void;
}

const MAX_MOUNTED_TURNS = 24;
const TURN_WINDOW_STEP = 12;

interface TurnWindowState {
  threadId: string | null;
  anchorTurnId: string | null;
  start: number;
  followingLatest: boolean;
}

function activeTurnId(turns: readonly CodexTurn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].status === "inProgress") return turns[index].id;
  }
  return null;
}

function historicalTurns(turns: readonly CodexTurn[], pinnedTurnId: string | null): CodexTurn[] {
  return pinnedTurnId ? turns.filter((turn) => turn.id !== pinnedTurnId) : [...turns];
}

function boundedWindowStart(start: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, start));
}

export function Conversation({
  activeReasoningItemIdsByTurn = {},
  thread,
  loading,
  loadError,
  historyLoading,
  hasMore,
  historyError,
  fileAttachments = {},
  imagePreviews = {},
  onDownloadFile,
  onLoadEarlier,
  onLoadTurnDetail,
  onRetryThread,
}: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingWindowScrollRef = useRef(false);
  const [readerNearBottom, setReaderNearBottom] = useState(true);
  const turns = thread?.turns ?? [];
  const pinnedTurnId = activeTurnId(turns);
  const historyTurns = historicalTurns(turns, pinnedTurnId);
  const windowed = turns.length > MAX_MOUNTED_TURNS;
  const windowCapacity = windowed
    ? MAX_MOUNTED_TURNS - (pinnedTurnId ? 1 : 0)
    : MAX_MOUNTED_TURNS;
  const maximumWindowStart = Math.max(0, historyTurns.length - windowCapacity);
  const [turnWindow, setTurnWindow] = useState<TurnWindowState>(() => {
    const start = Math.max(0, historyTurns.length - windowCapacity);
    return {
      threadId: thread?.id ?? null,
      anchorTurnId: historyTurns[start]?.id ?? null,
      start,
      followingLatest: true,
    };
  });
  const lastContent = turns.at(-1)?.items.at(-1);
  const lastTurnDiff = turns.at(-1)?.diff;
  const lastTurnId = turns.at(-1)?.id;
  const lastTurnStatus = turns.at(-1)?.status;

  let windowStart = 0;
  let followingLatest = turnWindow.followingLatest;
  if (turnWindow.threadId !== (thread?.id ?? null)) {
    windowStart = maximumWindowStart;
    followingLatest = true;
  } else if (windowed && turnWindow.followingLatest && readerNearBottom) {
    windowStart = maximumWindowStart;
    followingLatest = true;
  } else if (windowed) {
    const anchorIndex = turnWindow.anchorTurnId === null
      ? -1
      : historyTurns.findIndex((turn) => turn.id === turnWindow.anchorTurnId);
    windowStart = boundedWindowStart(
      anchorIndex >= 0 ? anchorIndex : turnWindow.start,
      maximumWindowStart,
    );
    followingLatest = turnWindow.followingLatest &&
      readerNearBottom &&
      windowStart === maximumWindowStart;
  } else {
    followingLatest = turnWindow.followingLatest && readerNearBottom;
  }

  const windowAnchorTurnId = historyTurns[windowStart]?.id ?? null;
  const windowTurns = windowed
    ? historyTurns.slice(windowStart, windowStart + windowCapacity)
    : turns;
  const mountedTurnIds = new Set(windowTurns.map((turn) => turn.id));
  if (windowed && pinnedTurnId) mountedTurnIds.add(pinnedTurnId);
  const mountedTurns = windowed
    ? turns.filter((turn) => mountedTurnIds.has(turn.id))
    : turns;
  const hasEarlierLoadedTurns = windowed && windowStart > 0;
  const hasNewerLoadedTurns = windowed && windowStart + windowCapacity < historyTurns.length;

  useEffect(() => {
    pendingWindowScrollRef.current = false;
    const node = scrollRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "auto" });
  }, [thread?.id]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && followingLatest) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [followingLatest, lastContent, lastTurnDiff, lastTurnId, lastTurnStatus]);

  useEffect(() => {
    if (!pendingWindowScrollRef.current) return;
    pendingWindowScrollRef.current = false;
    scrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [windowAnchorTurnId]);

  const showWindowAt = (start: number) => {
    const boundedStart = boundedWindowStart(start, maximumWindowStart);
    pendingWindowScrollRef.current = true;
    setReaderNearBottom(false);
    setTurnWindow({
      threadId: thread?.id ?? null,
      anchorTurnId: historyTurns[boundedStart]?.id ?? null,
      start: boundedStart,
      followingLatest: false,
    });
  };

  const loadEarlier = () => {
    if (thread) {
      setReaderNearBottom(false);
      setTurnWindow({
        threadId: thread.id,
        anchorTurnId: null,
        start: 0,
        followingLatest: false,
      });
    }
    onLoadEarlier();
  };

  return (
    <div
      className="conversation-scroll"
      ref={scrollRef}
      onScroll={(event) => {
        const node = event.currentTarget;
        const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
        setReaderNearBottom(nearBottom);
        const shouldFollowLatest = nearBottom && windowStart === maximumWindowStart;
        setTurnWindow((current) => (
          current.threadId === (thread?.id ?? null) &&
          current.anchorTurnId === windowAnchorTurnId &&
          current.start === windowStart &&
          current.followingLatest === shouldFollowLatest
            ? current
            : {
                threadId: thread?.id ?? null,
                anchorTurnId: windowAnchorTurnId,
                start: windowStart,
                followingLatest: shouldFollowLatest,
              }
        ));
      }}
    >
      <main className="conversation" aria-label="Conversation">
        {loading ? (
          <div className="conversation-state"><LoaderCircle size={22} className="spin" aria-hidden="true" /><span>Loading thread</span></div>
        ) : loadError ? (
          <div className="conversation-state" role="alert">
            <span>Could not load thread: {loadError}</span>
            <button className="button" type="button" onClick={onRetryThread}>Retry thread</button>
          </div>
        ) : (
          <>
            {hasEarlierLoadedTurns && (
              <nav className="conversation-window-nav conversation-window-nav--earlier" aria-label="Loaded turn navigation">
                <button
                  className="button"
                  type="button"
                  aria-label="Show earlier loaded turns"
                  onClick={() => showWindowAt(windowStart - TURN_WINDOW_STEP)}
                >
                  <ArrowUp size={14} aria-hidden="true" />
                  Earlier loaded turns
                </button>
              </nav>
            )}
            {(hasMore || historyLoading || historyError) && (
              <div className="conversation-history">
                {historyError && <span role="alert">Could not load earlier turns: {historyError}</span>}
                <button className="button" type="button" disabled={historyLoading} onClick={loadEarlier}>
                  {historyLoading && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
                  {historyLoading ? "Loading earlier turns" : historyError ? "Retry earlier turns" : "Load earlier turns"}
                </button>
              </div>
            )}
            {mountedTurns.length > 0 ? (
              mountedTurns.map((turn) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  activeReasoningItemIds={activeReasoningItemIdsByTurn[turn.id]}
                  fileAttachments={thread ? fileAttachments[sessionFileAttachmentKey(thread.id, turn.id)] : undefined}
                  imagePreviewUrls={thread ? imagePreviews[sessionImagePreviewKey(thread.id, turn.id)] : undefined}
                  onDownloadFile={onDownloadFile}
                  onLoadFullDetail={onLoadTurnDetail}
                />
              ))
            ) : (
              <div className="conversation-empty">
                <div className="empty-mark"><Bot size={23} aria-hidden="true" /></div>
                <h1>{thread ? "Continue this thread" : "What should Codex work on?"}</h1>
              </div>
            )}
            {hasNewerLoadedTurns && (
              <nav className="conversation-window-nav conversation-window-nav--newer" aria-label="Loaded turn navigation">
                <button
                  className="button"
                  type="button"
                  aria-label="Show newer loaded turns"
                  onClick={() => showWindowAt(windowStart + TURN_WINDOW_STEP)}
                >
                  <ArrowDown size={14} aria-hidden="true" />
                  Newer loaded turns
                </button>
              </nav>
            )}
          </>
        )}
      </main>
    </div>
  );
}
