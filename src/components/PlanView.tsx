import { Check, Circle, LoaderCircle, ListChecks } from "lucide-react";
import type { PlanStep, TurnPlan } from "../types/protocol";

interface PlanViewProps {
  plan: TurnPlan;
}

interface PlanStepListProps {
  className?: string;
  steps: readonly PlanStep[];
}

function planStepIsRunning(step: PlanStep): boolean {
  return step.status === "in_progress" || step.status === "inProgress";
}

export function PlanStepList({ className = "plan-list", steps }: PlanStepListProps) {
  return (
    <ol className={className}>
      {steps.map((entry, index) => {
        const running = planStepIsRunning(entry);
        const completed = entry.status === "completed";
        const Icon = completed ? Check : running ? LoaderCircle : Circle;
        const statusLabel = completed ? "Completed" : running ? "In progress" : "Pending";
        return (
          <li
            key={`${entry.step}-${index}`}
            className={`plan-step plan-step--${entry.status}`}
            aria-label={`${statusLabel}: ${entry.step}`}
          >
            <Icon size={15} className={running ? "spin" : undefined} aria-hidden="true" />
            <span>{entry.step}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function PlanView({ plan }: PlanViewProps) {
  return (
    <section className="plan-block" aria-label="Plan">
      <div className="item-heading">
        <ListChecks size={16} aria-hidden="true" />
        <strong>Plan</strong>
      </div>
      {plan.explanation && <p className="muted-copy">{plan.explanation}</p>}
      <PlanStepList steps={plan.plan} />
    </section>
  );
}
