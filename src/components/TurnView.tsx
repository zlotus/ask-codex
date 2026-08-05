import { AlertTriangle, ChevronRight, GitCompareArrows, LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { CodexItem, CodexTurn, FileDownloadHandler } from "../types/protocol";
import { errorMessage, userMessageImages } from "../utils/protocol";
import { ActivityGroup } from "./ActivityGroup";
import { DiffViewer } from "./DiffViewer";
import { ItemRenderer, ReasoningGroup } from "./ItemRenderer";
import { LazyDetails } from "./LazyDetails";
import { PlanView } from "./PlanView";
import { TurnStatusSlot } from "./TurnStatusSlot";
import { hasVisibleReasoning, isToolActivityItem } from "./activityUtils";

interface TurnViewProps {
  activeReasoningItemIds?: readonly string[];
  imagePreviewUrls?: readonly string[];
  turn: CodexTurn;
  onDownloadFile?: FileDownloadHandler;
  onLoadFullDetail?: (turnId: string) => void;
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
  onDownloadFile?: FileDownloadHandler,
) {
  const rendered: ReactNode[] = [];
  let activityRun: ReactNode[] = [];
  let activityRunId: string | null = null;
  let index = 0;
  let previewOffset = 0;

  const appendActivity = (id: string, node: ReactNode) => {
    if (activityRunId === null) activityRunId = id;
    activityRun.push(node);
  };
  const flushActivityRun = () => {
    if (activityRun.length === 0 || activityRunId === null) return;
    rendered.push((
      <div className="activity-stack" key={`activity-stack-${activityRunId}`}>
        {activityRun}
      </div>
    ));
    activityRun = [];
    activityRunId = null;
  };

  while (index < items.length) {
    const item = items[index];
    if (item.type === "reasoning") {
      const reasoningItems = [item];
      let nextIndex = index + 1;
      while (nextIndex < items.length && items[nextIndex].type === "reasoning") {
        reasoningItems.push(items[nextIndex]);
        nextIndex += 1;
      }
      if (hasVisibleReasoning(reasoningItems)) {
        appendActivity(reasoningItems[0].id, (
          <ReasoningGroup items={reasoningItems} key={`reasoning-${reasoningItems[0].id}`} />
        ));
      }
      index = nextIndex;
      continue;
    }
    if (!isToolActivityItem(item)) {
      flushActivityRun();
      const localImageCount = item.type === "userMessage"
        ? userMessageImages(item).filter((image) => image.type === "localImage").length
        : 0;
      const itemPreviewUrls = imagePreviewUrls.slice(previewOffset, previewOffset + localImageCount);
      previewOffset += localImageCount;
      rendered.push((
        <ItemRenderer
          key={item.id}
          item={item}
          imagePreviewUrls={itemPreviewUrls}
          onDownloadFile={onDownloadFile}
        />
      ));
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
      appendActivity(groupId, (
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
      appendActivity(item.id, (
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

  flushActivityRun();
  return rendered;
}

export function TurnView({
  activeReasoningItemIds = [],
  imagePreviewUrls = [],
  turn,
  onDownloadFile,
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
          The latest turn plan could not be recovered and is not available in this view.
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
      {renderItems(turn.items, disclosure, imagePreviewUrls, onDownloadFile)}
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
      <TurnStatusSlot reasoningActive={activeReasoningItemIds.length > 0} turn={turn} />
    </section>
  );
}
