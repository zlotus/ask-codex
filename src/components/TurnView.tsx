import { AlertTriangle, ChevronRight, GitCompareArrows, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { CodexItem, CodexTurn } from "../types/protocol";
import { errorMessage, formatTimestamp, timestampMilliseconds, userMessageImages } from "../utils/protocol";
import { ActivityGroup } from "./ActivityGroup";
import { DiffViewer } from "./DiffViewer";
import { ItemRenderer, ReasoningGroup } from "./ItemRenderer";
import { LazyDetails } from "./LazyDetails";
import { PlanView } from "./PlanView";
import { StatusPill } from "./StatusPill";
import { isToolActivityItem } from "./activityUtils";

interface TurnViewProps {
  activeReasoningItemIds?: readonly string[];
  imagePreviewUrls?: readonly string[];
  turn: CodexTurn;
  onLoadFullDetail?: (turnId: string) => void;
}

const secondsFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function formatDuration(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${secondsFormatter.format(value / 1_000)}s`;
  const totalSeconds = Math.round(value / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(minutes > 0 ? [`${minutes}m`] : []),
    ...(seconds > 0 || (hours === 0 && minutes === 0) ? [`${seconds}s`] : []),
  ].join(" ");
}

interface ActivityDisclosureState {
  groupOpenIds: ReadonlySet<string>;
  itemOpenIds: ReadonlySet<string>;
  onGroupOpenChange: (groupId: string, open: boolean) => void;
  onItemOpenChange: (itemId: string, open: boolean) => void;
  onStandaloneOpenChange: (itemId: string, open: boolean) => void;
}

function renderItems(
  items: CodexItem[],
  disclosure: ActivityDisclosureState,
  imagePreviewUrls: readonly string[],
  activeReasoningItemIds: ReadonlySet<string>,
) {
  const rendered = [];
  let index = 0;
  let previewOffset = 0;

  while (index < items.length) {
    const item = items[index];
    if (item.type === "reasoning") {
      const reasoningItems = [item];
      let nextIndex = index + 1;
      while (nextIndex < items.length && items[nextIndex].type === "reasoning") {
        reasoningItems.push(items[nextIndex]);
        nextIndex += 1;
      }
      rendered.push((
        <ReasoningGroup
          active={reasoningItems.some((entry) => activeReasoningItemIds.has(entry.id))}
          items={reasoningItems}
          key={`reasoning-${reasoningItems[0].id}`}
        />
      ));
      index = nextIndex;
      continue;
    }
    if (!isToolActivityItem(item)) {
      const localImageCount = item.type === "userMessage"
        ? userMessageImages(item).filter((image) => image.type === "localImage").length
        : 0;
      const itemPreviewUrls = imagePreviewUrls.slice(previewOffset, previewOffset + localImageCount);
      previewOffset += localImageCount;
      rendered.push(<ItemRenderer key={item.id} item={item} imagePreviewUrls={itemPreviewUrls} />);
      index += 1;
      continue;
    }

    const activities = [item];
    let nextIndex = index + 1;
    while (nextIndex < items.length && isToolActivityItem(items[nextIndex])) {
      activities.push(items[nextIndex]);
      nextIndex += 1;
    }

    if (activities.length >= 2) {
      // The first item id remains stable as streamed items are appended to this group.
      const groupId = activities[0].id;
      rendered.push((
        <ActivityGroup
          items={activities}
          key={`activity-${groupId}`}
          onItemOpenChange={disclosure.onItemOpenChange}
          onOpenChange={(open) => disclosure.onGroupOpenChange(groupId, open)}
          open={disclosure.groupOpenIds.has(groupId)}
          openItemIds={disclosure.itemOpenIds}
        />
      ));
    } else {
      rendered.push((
        <ItemRenderer
          disclosureOpen={disclosure.itemOpenIds.has(item.id)}
          key={item.id}
          item={item}
          onDisclosureOpenChange={(open) => disclosure.onStandaloneOpenChange(item.id, open)}
        />
      ));
    }
    index = nextIndex;
  }

  return rendered;
}

export function TurnView({
  activeReasoningItemIds = [],
  imagePreviewUrls = [],
  turn,
  onLoadFullDetail,
}: TurnViewProps) {
  const [groupOpenIds, setGroupOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [itemOpenIds, setItemOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const historyDetail = turn.historyDetail;
  const hasItemPages = historyDetail?.nextItemCursor !== undefined;
  const detailButtonLabel = turn.status === "inProgress"
    ? "Waiting for completion"
    : historyDetail?.status === "unavailable"
      ? "Detail unavailable"
      : historyDetail?.status === "loading"
        ? hasItemPages ? "Loading more detail" : "Loading full detail"
        : historyDetail?.status === "error"
          ? hasItemPages ? "Retry more detail" : "Retry full detail"
          : hasItemPages ? "Load more detail" : "Load full detail";
  const omissions = turn.recoveryOmissions ?? [];
  const activeReasoningIds = new Set(activeReasoningItemIds);
  const startedAtMs = timestampMilliseconds(turn.startedAt);
  const startedAt = startedAtMs === null ? "" : formatTimestamp(startedAtMs);
  const duration = formatDuration(turn.durationMs);
  const completedStatus = turn.status && turn.status !== "inProgress" ? turn.status : undefined;
  const hasMetadata = Boolean(startedAt || duration);

  const updateOpenIds = (
    setter: typeof setItemOpenIds,
    id: string,
    open: boolean,
  ) => setter((current) => {
    if (current.has(id) === open) return current;
    const next = new Set(current);
    if (open) next.add(id);
    else next.delete(id);
    return next;
  });

  const disclosure: ActivityDisclosureState = {
    groupOpenIds,
    itemOpenIds,
    onGroupOpenChange: (id, open) => updateOpenIds(setGroupOpenIds, id, open),
    onItemOpenChange: (id, open) => updateOpenIds(setItemOpenIds, id, open),
    onStandaloneOpenChange: (id, open) => {
      updateOpenIds(setItemOpenIds, id, open);
      // If a following activity arrives, preserve the user's intent by opening the new group too.
      updateOpenIds(setGroupOpenIds, id, open);
    },
  };
  return (
    <section className="turn" data-turn-id={turn.id}>
      {omissions.includes("turn/diff/updated") && (
        <div className="turn-history-notice" role="status">
          The latest turn diff exceeded the gateway limit and is not available in this view.
        </div>
      )}
      {omissions.includes("turn/plan/updated") && (
        <div className="turn-history-notice" role="status">
          The latest turn plan exceeded the gateway limit and is not available in this view.
        </div>
      )}
      {turn.itemsView === "summary" && (
        <div className="turn-history-notice">
          <span>{hasItemPages ? "Large turn detail loaded in parts" : "Large turn loaded as a summary"}</span>
          {historyDetail && onLoadFullDetail && (
            <button
              className="button"
              type="button"
              disabled={
                turn.status === "inProgress" ||
                historyDetail.status === "loading" ||
                historyDetail.status === "unavailable"
              }
              onClick={() => onLoadFullDetail(turn.id)}
            >
              {historyDetail.status === "loading" && (
                <LoaderCircle size={14} className="spin" aria-hidden="true" />
              )}
              {detailButtonLabel}
            </button>
          )}
          {historyDetail?.error && <span role="alert">Could not load full detail: {historyDetail.error}</span>}
        </div>
      )}
      {turn.plan && <PlanView plan={turn.plan} />}
      {renderItems(turn.items, disclosure, imagePreviewUrls, activeReasoningIds)}
      {turn.error != null && (
        <div className="turn-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{errorMessage(turn.error)}</span>
        </div>
      )}
      {turn.diff && (
        <LazyDetails
          className="turn-diff"
          summary={(
            <>
              <GitCompareArrows size={15} aria-hidden="true" />
              <span>Changes in this turn</span>
              <ChevronRight size={14} className="details-chevron" aria-hidden="true" />
            </>
          )}
        >
          <DiffViewer diff={turn.diff} />
        </LazyDetails>
      )}
      {(hasMetadata || completedStatus) && (
        <div className="turn-footer">
          {hasMetadata && (
            <div className="turn-meta" role="group" aria-label="Turn details">
              {startedAt && startedAtMs !== null && (
                <time className="turn-meta__item" dateTime={new Date(startedAtMs).toISOString()}>
                  Started {startedAt}
                </time>
              )}
              {duration && <span className="turn-meta__item">Duration {duration}</span>}
            </div>
          )}
          {completedStatus && <StatusPill status={completedStatus} />}
        </div>
      )}
    </section>
  );
}
