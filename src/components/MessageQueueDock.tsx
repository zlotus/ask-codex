import {
  ChevronRight,
  Inbox,
  LoaderCircle,
  RefreshCw,
  Send,
  TriangleAlert,
  X,
} from "lucide-react";
import { useId, useState } from "react";
import type { MessageQueueItem } from "../types/protocol";

interface MessageQueueDockProps {
  items: MessageQueueItem[];
  loading: boolean;
  error: string | null;
  disabled: boolean;
  busyItemId: string | null;
  onRefresh: () => void;
  onSend: (item: MessageQueueItem) => void;
  onCancel: (item: MessageQueueItem) => void;
}

function statusLabel(item: MessageQueueItem): string {
  if (item.status === "needsReview") {
    switch (item.reviewReason) {
      case "contextChanged": return "Context changed";
      case "dispatchRejected": return "Send rejected";
      case "threadBusy": return "Thread busy";
      default: return "Review required";
    }
  }
  if (item.status === "indeterminate") return "Outcome unknown";
  if (item.status === "claimed") return "Claimed";
  if (item.status === "dispatching") return "Sending";
  return "Queued";
}

export function MessageQueueDock({
  items,
  loading,
  error,
  disabled,
  busyItemId,
  onRefresh,
  onSend,
  onCancel,
}: MessageQueueDockProps) {
  const [open, setOpen] = useState(true);
  const contentId = useId();
  return (
    <section className="message-queue-dock" aria-label="Message queue">
      <div className="message-queue-dock__header">
        <button
          type="button"
          className="message-queue-dock__summary"
          aria-controls={contentId}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} message queue, ${items.length} items`}
          onClick={() => setOpen((current) => !current)}
        >
          <Inbox size={16} aria-hidden="true" />
          <strong>Queue</strong>
          <span className="message-queue-dock__count" aria-hidden="true">{items.length}</span>
          <ChevronRight
            className={open ? "message-queue-dock__chevron message-queue-dock__chevron--open" : "message-queue-dock__chevron"}
            size={15}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          className="message-queue-dock__icon"
          title="Refresh message queue"
          aria-label="Refresh message queue"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className={loading ? "spin" : undefined} size={15} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div id={contentId} className="message-queue-dock__body">
          {error && <div className="message-queue-dock__error" role="alert">{error}</div>}
          {!error && items.length === 0 && (
            <div className="message-queue-dock__empty">No queued messages</div>
          )}
          {items.length > 0 && (
            <div className="message-queue-dock__list" role="list" aria-label="Queued messages">
              {items.map((item) => {
                const itemBusy = busyItemId === item.id || item.status === "claimed" || item.status === "dispatching";
                const canSend = item.status === "queued" || item.status === "needsReview";
                const canCancel = canSend || item.status === "indeterminate";
                return (
                  <div className="message-queue-item" role="listitem" key={item.id}>
                    <span className="message-queue-item__copy">
                      <span className="message-queue-item__text" title={item.text}>{item.text}</span>
                      <span className={`message-queue-item__status message-queue-item__status--${item.status}`}>
                        {(item.status === "needsReview" || item.status === "indeterminate") && (
                          <TriangleAlert size={12} aria-hidden="true" />
                        )}
                        {statusLabel(item)}
                      </span>
                    </span>
                    {canSend && (
                      <button
                        type="button"
                        className="message-queue-dock__icon"
                        title={item.status === "needsReview" ? "Send reviewed message" : "Send queued message"}
                        aria-label={item.status === "needsReview" ? "Send reviewed message" : "Send queued message"}
                        disabled={disabled || itemBusy}
                        onClick={() => onSend(item)}
                      >
                        {itemBusy
                          ? <LoaderCircle className="spin" size={15} aria-hidden="true" />
                          : <Send size={15} aria-hidden="true" />}
                      </button>
                    )}
                    {canCancel && (
                      <button
                        type="button"
                        className="message-queue-dock__icon"
                        title={item.status === "indeterminate" ? "Dismiss after checking thread history" : "Cancel queued message"}
                        aria-label={item.status === "indeterminate" ? "Dismiss after checking thread history" : "Cancel queued message"}
                        disabled={itemBusy}
                        onClick={() => onCancel(item)}
                      >
                        <X size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
