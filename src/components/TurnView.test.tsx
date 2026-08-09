import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TurnPlan } from "../types/protocol";
import { TurnView } from "./TurnView";

const unfinishedPlan: TurnPlan = {
  explanation: "The final update was not emitted.",
  plan: [
    { step: "Inspect the flow", status: "completed" },
    { step: "Run verification", status: "inProgress" },
    { step: "Review the result", status: "pending" },
  ],
};

describe("TurnView plan lifecycle", () => {
  it("freezes an unfinished plan after its turn reaches a terminal status", () => {
    const { container } = render(
      <TurnView
        turn={{ id: "turn-completed", status: "completed", items: [], plan: unfinishedPlan }}
      />,
    );
    const plan = screen.getByRole("region", { name: "Plan" });

    expect(within(plan).getByRole("status")).toHaveTextContent(
      "Turn ended without a final plan update",
    );
    expect(within(plan).getByRole("listitem", {
      name: "In progress when turn ended: Run verification",
    })).toBeInTheDocument();
    expect(within(plan).getByRole("listitem", {
      name: "Pending when turn ended: Review the result",
    })).toBeInTheDocument();
    expect(container.querySelector(".plan-block .spin")).not.toBeInTheDocument();
  });

  it("keeps the running step animated while the turn is active", () => {
    const { container } = render(
      <TurnView
        turn={{ id: "turn-active", status: "inProgress", items: [], plan: unfinishedPlan }}
      />,
    );
    const plan = screen.getByRole("region", { name: "Plan" });

    expect(within(plan).queryByRole("status")).not.toBeInTheDocument();
    expect(within(plan).getByRole("listitem", {
      name: "In progress: Run verification",
    })).toBeInTheDocument();
    expect(container.querySelector(".plan-block .spin")).toBeInTheDocument();
  });

  it("does not animate a recovered plan unless the turn is explicitly active", () => {
    const { container } = render(
      <TurnView turn={{ id: "turn-unknown", items: [], plan: unfinishedPlan }} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Turn ended without a final plan update",
    );
    expect(container.querySelector(".plan-block .spin")).not.toBeInTheDocument();
  });
});
