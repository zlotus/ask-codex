import { Check, ChevronRight, Circle, ListChecks, LoaderCircle } from "lucide-react";
import { useId, useState } from "react";
import type { TurnPlan } from "../types/protocol";
import { PlanStepList } from "./PlanView";

interface ActivePlanDockProps {
  plan: TurnPlan;
  updateUnavailable?: boolean;
}

export function ActivePlanDock({ plan, updateUnavailable = false }: ActivePlanDockProps) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const steps = plan.plan;
  if (steps.length === 0) return null;

  const runningIndex = steps.findIndex((step) => (
    step.status === "in_progress" || step.status === "inProgress"
  ));
  const pendingIndex = steps.findIndex((step) => step.status !== "completed");
  const currentIndex = runningIndex >= 0 ? runningIndex : pendingIndex;
  const complete = currentIndex < 0;
  const displayIndex = complete ? steps.length : currentIndex + 1;
  const currentStep = complete ? "Plan complete" : steps[currentIndex].step;
  const CurrentIcon = complete ? Check : runningIndex >= 0 ? LoaderCircle : Circle;
  const accessibleState = complete
    ? `Plan complete, ${steps.length} of ${steps.length}`
    : `Step ${displayIndex} of ${steps.length}: ${currentStep}`;

  return (
    <section className="active-plan-dock" aria-label="Current plan">
      <button
        type="button"
        className="active-plan-dock__summary"
        aria-controls={contentId}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} current plan. ${accessibleState}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="active-plan-dock__title">
          <ListChecks size={16} aria-hidden="true" />
          <strong>Plan</strong>
        </span>
        <span className="active-plan-dock__progress" aria-hidden="true">
          {displayIndex}/{steps.length}
        </span>
        <span className="active-plan-dock__current" aria-hidden="true" title={currentStep}>
          <CurrentIcon
            size={14}
            className={!complete && runningIndex >= 0 ? "spin" : undefined}
          />
          <span>{currentStep}</span>
        </span>
        {updateUnavailable && (
          <span className="active-plan-dock__warning" aria-hidden="true">Update unavailable</span>
        )}
        <ChevronRight
          size={15}
          className={`active-plan-dock__chevron${open ? " active-plan-dock__chevron--open" : ""}`}
          aria-hidden="true"
        />
      </button>
      <div className="active-plan-dock__body" id={contentId} hidden={!open}>
        {updateUnavailable && (
          <p className="active-plan-dock__notice" role="status">
            The latest plan update exceeded the gateway limit. This is the last available snapshot.
          </p>
        )}
        {plan.explanation && <p className="muted-copy">{plan.explanation}</p>}
        <PlanStepList className="plan-list active-plan-dock__list" steps={steps} />
      </div>
    </section>
  );
}
