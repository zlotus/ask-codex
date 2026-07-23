import { ChevronRight, Wrench } from "lucide-react";
import type { CodexItem } from "../types/protocol";
import { ItemRenderer } from "./ItemRenderer";
import { LazyDetails } from "./LazyDetails";
import { StatusPill } from "./StatusPill";
import {
  isFailedToolActivity,
  isRunningToolActivity,
  summarizeToolActivities,
} from "./activityUtils";

interface ActivityGroupProps {
  items: CodexItem[];
  onItemOpenChange: (itemId: string, open: boolean) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  openItemIds: ReadonlySet<string>;
}

export function ActivityGroup({
  items,
  onItemOpenChange,
  onOpenChange,
  open,
  openItemIds,
}: ActivityGroupProps) {
  const failed = items.filter(isFailedToolActivity).length;
  const running = items.filter(isRunningToolActivity).length;

  return (
    <LazyDetails
      className={`activity-group${failed > 0 ? " activity-group--failed" : ""}`}
      onOpenChange={onOpenChange}
      open={open}
      summaryClassName="activity-group-summary"
      summary={(
        <>
          <span className="activity-group-label">
            <Wrench size={15} aria-hidden="true" />
            <span>{summarizeToolActivities(items)}</span>
          </span>
          <span className="activity-group-state">
            {failed > 0 ? (
              <StatusPill status={`${failed} failed`} />
            ) : running > 0 ? (
              <StatusPill status={`${running} running`} />
            ) : null}
            <ChevronRight size={14} className="details-chevron" aria-hidden="true" />
          </span>
        </>
      )}
    >
      <div className="activity-group-list">
        {items.map((item) => (
          <ItemRenderer
            disclosureOpen={openItemIds.has(item.id)}
            key={item.id}
            item={item}
            onDisclosureOpenChange={(itemOpen) => onItemOpenChange(item.id, itemOpen)}
          />
        ))}
      </div>
    </LazyDetails>
  );
}
