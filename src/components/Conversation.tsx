import { Bot, LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CodexThread } from "../types/protocol";
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
  imagePreviews?: SessionImagePreviewSnapshot;
  onLoadEarlier: () => void;
  onLoadTurnDetail: (turnId: string) => void;
  onRetryThread: () => void;
}

export function Conversation({
  activeReasoningItemIdsByTurn = {},
  thread,
  loading,
  loadError,
  historyLoading,
  hasMore,
  historyError,
  imagePreviews = {},
  onLoadEarlier,
  onLoadTurnDetail,
  onRetryThread,
}: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const turns = thread?.turns ?? [];
  const lastContent = turns.at(-1)?.items.at(-1);
  const lastTurnDiff = turns.at(-1)?.diff;
  const lastTurnStatus = turns.at(-1)?.status;

  useEffect(() => {
    wasNearBottomRef.current = true;
    const node = scrollRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "auto" });
  }, [thread?.id]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && wasNearBottomRef.current) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [lastContent, lastTurnDiff, lastTurnStatus]);

  return (
    <div
      className="conversation-scroll"
      ref={scrollRef}
      onScroll={(event) => {
        const node = event.currentTarget;
        wasNearBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
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
            {(hasMore || historyLoading || historyError) && (
              <div className="conversation-history">
                {historyError && <span role="alert">Could not load earlier turns: {historyError}</span>}
                <button className="button" type="button" disabled={historyLoading} onClick={onLoadEarlier}>
                  {historyLoading && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
                  {historyLoading ? "Loading earlier turns" : historyError ? "Retry earlier turns" : "Load earlier turns"}
                </button>
              </div>
            )}
            {turns.length > 0 ? (
              turns.map((turn) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  activeReasoningItemIds={activeReasoningItemIdsByTurn[turn.id]}
                  imagePreviewUrls={thread ? imagePreviews[sessionImagePreviewKey(thread.id, turn.id)] : undefined}
                  onLoadFullDetail={onLoadTurnDetail}
                />
              ))
            ) : (
              <div className="conversation-empty">
                <div className="empty-mark"><Bot size={23} aria-hidden="true" /></div>
                <h1>{thread ? "Continue this thread" : "What should Codex work on?"}</h1>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
