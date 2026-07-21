import { AlertTriangle, ChevronRight, GitCompareArrows } from "lucide-react";
import type { CodexTurn } from "../types/protocol";
import { errorMessage } from "../utils/protocol";
import { ItemRenderer } from "./ItemRenderer";
import { PlanView } from "./PlanView";
import { StatusPill } from "./StatusPill";

interface TurnViewProps {
  turn: CodexTurn;
}

export function TurnView({ turn }: TurnViewProps) {
  return (
    <section className="turn" data-turn-id={turn.id}>
      {turn.plan && <PlanView plan={turn.plan} />}
      {turn.items.map((item) => <ItemRenderer key={item.id} item={item} />)}
      {turn.error != null && (
        <div className="turn-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{errorMessage(turn.error)}</span>
        </div>
      )}
      {turn.diff && (
        <details className="turn-diff">
          <summary>
            <GitCompareArrows size={15} aria-hidden="true" />
            <span>Turn diff</span>
            <ChevronRight size={14} className="details-chevron" aria-hidden="true" />
          </summary>
          <pre className="diff-output">{turn.diff}</pre>
        </details>
      )}
      {turn.status && turn.status !== "inProgress" && (
        <div className="turn-footer"><StatusPill status={turn.status} /></div>
      )}
    </section>
  );
}
