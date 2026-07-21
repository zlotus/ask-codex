import { Bot, LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CodexThread } from "../types/protocol";
import { TurnView } from "./TurnView";

interface ConversationProps {
  thread: CodexThread | null;
  loading: boolean;
}

export function Conversation({ thread, loading }: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const turns = thread?.turns ?? [];
  const itemCount = turns.reduce((count, turn) => count + turn.items.length, 0);
  const lastContent = turns.at(-1)?.items.at(-1);
  const lastTurnStatus = turns.at(-1)?.status;

  useEffect(() => {
    const node = scrollRef.current;
    if (node && wasNearBottomRef.current) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [itemCount, lastContent, lastTurnStatus]);

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
        ) : turns.length > 0 ? (
          turns.map((turn) => <TurnView key={turn.id} turn={turn} />)
        ) : (
          <div className="conversation-empty">
            <div className="empty-mark"><Bot size={23} aria-hidden="true" /></div>
            <h1>{thread ? "Continue this thread" : "What should Codex work on?"}</h1>
          </div>
        )}
      </main>
    </div>
  );
}
