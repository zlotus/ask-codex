import { Check, Circle, LoaderCircle, ListChecks } from "lucide-react";
import type { PlanStep, TurnPlan } from "../types/protocol";

interface PlanViewProps {
  plan: TurnPlan;
  terminal?: boolean;
}

interface PlanStepListProps {
  className?: string;
  steps: readonly PlanStep[];
  terminal?: boolean;
}

function planStepIsRunning(step: PlanStep): boolean {
  return step.status === "in_progress" || step.status === "inProgress";
}

export function PlanStepList({
  className = "plan-list",
  steps,
  terminal = false,
}: PlanStepListProps) {
  return (
    <ol className={className}>
      {steps.map((entry, index) => {
        const running = planStepIsRunning(entry);
        const completed = entry.status === "completed";
        const Icon = completed ? Check : running ? LoaderCircle : Circle;
        const statusLabel = completed
          ? "Completed"
          : running
            ? terminal ? "In progress when turn ended" : "In progress"
            : terminal ? "Pending when turn ended" : "Pending";
        return (
          <li
            key={`${entry.step}-${index}`}
            className={`plan-step plan-step--${entry.status}`}
            aria-label={`${statusLabel}: ${entry.step}`}
          >
            <Icon
              size={15}
              className={running && !terminal ? "spin" : undefined}
              aria-hidden="true"
            />
            <span>{entry.step}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function PlanView({ plan, terminal = false }: PlanViewProps) {
  const unfinished = plan.plan.some((step) => step.status !== "completed");
  return (
    <section className="plan-block" aria-label="Plan">
      <div className="item-heading">
        <ListChecks size={16} aria-hidden="true" />
        <strong>Plan</strong>
      </div>
      {plan.explanation && <p className="muted-copy">{plan.explanation}</p>}
      {terminal && unfinished && (
        <p className="plan-terminal-notice" role="status">
          Turn ended without a final plan update. This is the last reported plan state.
        </p>
      )}
      <PlanStepList
        className={terminal ? "plan-list plan-list--terminal" : undefined}
        steps={plan.plan}
        terminal={terminal}
      />
    </section>
  );
}
