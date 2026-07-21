import { Check, Circle, LoaderCircle, ListChecks } from "lucide-react";
import type { TurnPlan } from "../types/protocol";

interface PlanViewProps {
  plan: TurnPlan;
}

export function PlanView({ plan }: PlanViewProps) {
  return (
    <section className="plan-block" aria-label="Plan">
      <div className="item-heading">
        <ListChecks size={16} aria-hidden="true" />
        <strong>Plan</strong>
      </div>
      {plan.explanation && <p className="muted-copy">{plan.explanation}</p>}
      <ol className="plan-list">
        {plan.plan.map((entry, index) => {
          const running = entry.status === "in_progress" || entry.status === "inProgress";
          const Icon = entry.status === "completed"
            ? Check
            : running ? LoaderCircle : Circle;
          return (
            <li key={`${entry.step}-${index}`} className={`plan-step plan-step--${entry.status}`}>
              <Icon size={15} className={running ? "spin" : undefined} aria-hidden="true" />
              <span>{entry.step}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
