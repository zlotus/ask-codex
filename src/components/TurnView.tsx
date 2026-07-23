import { AlertTriangle, ChevronRight, GitCompareArrows, LoaderCircle } from "lucide-react";
import type { CodexTurn } from "../types/protocol";
import { errorMessage } from "../utils/protocol";
import { DiffViewer } from "./DiffViewer";
import { ItemRenderer } from "./ItemRenderer";
import { LazyDetails } from "./LazyDetails";
import { PlanView } from "./PlanView";
import { StatusPill } from "./StatusPill";

interface TurnViewProps {
  turn: CodexTurn;
  onLoadFullDetail?: (turnId: string) => void;
}

export function TurnView({ turn, onLoadFullDetail }: TurnViewProps) {
  const historyDetail = turn.historyDetail;
  const omissions = turn.recoveryOmissions ?? [];
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
          <span>Large turn loaded as a summary</span>
          {historyDetail && onLoadFullDetail && (
            <button
              className="button"
              type="button"
              disabled={historyDetail.status === "loading"}
              onClick={() => onLoadFullDetail(turn.id)}
            >
              {historyDetail.status === "loading" && (
                <LoaderCircle size={14} className="spin" aria-hidden="true" />
              )}
              {historyDetail.status === "loading"
                ? "Loading full detail"
                : historyDetail.status === "error" ? "Retry full detail" : "Load full detail"}
            </button>
          )}
          {historyDetail?.error && <span role="alert">Could not load full detail: {historyDetail.error}</span>}
        </div>
      )}
      {turn.plan && <PlanView plan={turn.plan} />}
      {turn.items.map((item) => <ItemRenderer key={item.id} item={item} />)}
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
              <span>Turn diff</span>
              <ChevronRight size={14} className="details-chevron" aria-hidden="true" />
            </>
          )}
        >
          <DiffViewer diff={turn.diff} />
        </LazyDetails>
      )}
      {turn.status && turn.status !== "inProgress" && (
        <div className="turn-footer"><StatusPill status={turn.status} /></div>
      )}
    </section>
  );
}
