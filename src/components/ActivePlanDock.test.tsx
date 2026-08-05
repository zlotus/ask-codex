import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TurnPlan } from "../types/protocol";
import { ActivePlanDock } from "./ActivePlanDock";

const initialPlan: TurnPlan = {
  explanation: "Keep the active plan close to the composer.",
  plan: [
    { step: "Inspect the existing flow", status: "completed" },
    { step: "Implement the dock", status: "in_progress" },
    { step: "Verify the responsive layout", status: "pending" },
  ],
};

describe("ActivePlanDock", () => {
  it("stays collapsed by default and preserves disclosure state across plan updates", () => {
    const { rerender } = render(<ActivePlanDock plan={initialPlan} />);
    const toggle = screen.getByRole("button", {
      name: /Expand current plan\. Step 2 of 3: Implement the dock/,
    });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("2/3")).toBeVisible();
    expect(screen.getByText(initialPlan.explanation!)).not.toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(initialPlan.explanation!)).toBeVisible();
    expect(screen.getByRole("listitem", { name: "Completed: Inspect the existing flow" })).toBeVisible();
    expect(screen.getByRole("listitem", { name: "In progress: Implement the dock" })).toBeVisible();

    rerender(<ActivePlanDock plan={{
      ...initialPlan,
      plan: [
        { step: "Inspect the existing flow", status: "completed" },
        { step: "Implement the dock", status: "completed" },
        { step: "Verify the responsive layout", status: "inProgress" },
      ],
    }} />);

    expect(screen.getByRole("button", {
      name: /Collapse current plan\. Step 3 of 3: Verify the responsive layout/,
    })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("3/3")).toBeVisible();
  });

  it("falls back to the next pending step and reports a completed active plan", () => {
    const { rerender } = render(<ActivePlanDock plan={{
      plan: [
        { step: "Already done", status: "completed" },
        { step: "Start next", status: "pending" },
      ],
    }} />);

    expect(screen.getByRole("button", {
      name: /Step 2 of 2: Start next/,
    })).toBeInTheDocument();

    rerender(<ActivePlanDock plan={{
      plan: [
        { step: "Already done", status: "completed" },
        { step: "Start next", status: "completed" },
      ],
    }} />);

    expect(screen.getByRole("button", {
      name: /Plan complete, 2 of 2/,
    })).toBeInTheDocument();
    expect(screen.getByText("Plan complete")).toBeVisible();
  });

  it("hides empty plans and labels an unavailable update as a stale snapshot", () => {
    const { rerender } = render(<ActivePlanDock plan={{ plan: [] }} />);
    expect(screen.queryByRole("region", { name: "Current plan" })).not.toBeInTheDocument();

    rerender(<ActivePlanDock plan={initialPlan} updateUnavailable />);
    expect(screen.getByText("Update unavailable")).toBeVisible();
    const toggle = screen.getByRole("button", { name: /Expand current plan/ });
    expect(toggle).toHaveAccessibleName(/Latest plan update unavailable/);
    fireEvent.click(toggle);
    expect(screen.getByRole("status")).toHaveTextContent(
      "latest plan update could not be recovered",
    );
  });
});
