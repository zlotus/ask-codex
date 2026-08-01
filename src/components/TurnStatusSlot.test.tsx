import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TurnStatusSlot } from "./TurnStatusSlot";

describe("TurnStatusSlot", () => {
  it("keeps the same status slot while reasoning activity changes", () => {
    const turn = { id: "turn-running", status: "inProgress" as const, items: [] };
    const { container, rerender } = render(<TurnStatusSlot reasoningActive turn={turn} />);
    const statusSlot = screen.getByRole("status", { name: "Turn status" });

    expect(statusSlot).toHaveTextContent("Reasoning active");
    expect(container.querySelector(".turn-reasoning-status svg")).toHaveClass("spin");

    rerender(<TurnStatusSlot reasoningActive={false} turn={turn} />);

    expect(screen.getByRole("status", { name: "Turn status" })).toBe(statusSlot);
    expect(statusSlot).toHaveTextContent("Reasoning idle");
    expect(container.querySelector(".turn-reasoning-status svg")).not.toHaveClass("spin");
  });

  it("renders completed turn metadata and status", () => {
    render(<TurnStatusSlot
      reasoningActive={false}
      turn={{
        id: "turn-completed",
        status: "completed",
        items: [],
        startedAt: 1_800_000_000,
        completedAt: 1_800_000_002.5,
        durationMs: 2_500,
      }}
    />);

    const details = screen.getByRole("group", { name: "Turn details" });
    expect(details).toHaveTextContent("Started");
    expect(details).toHaveTextContent("Duration 2.5s");
    expect(details.querySelector("time")).toHaveAttribute(
      "datetime",
      new Date(1_800_000_000_000).toISOString(),
    );
    expect(screen.getByText("completed")).toBeInTheDocument();
  });

  it.each([
    [450, "Duration 450ms"],
    [60_000, "Duration 1m"],
    [3_661_000, "Duration 1h 1m 1s"],
  ])("formats a %ims turn duration as %s", (durationMs, expected) => {
    render(<TurnStatusSlot
      reasoningActive={false}
      turn={{ id: `turn-${durationMs}`, items: [], durationMs }}
    />);

    expect(screen.getByRole("group", { name: "Turn details" })).toHaveTextContent(expected);
  });

  it("omits invalid timing without removing the active status slot", () => {
    render(<TurnStatusSlot
      reasoningActive={false}
      turn={{
        id: "turn-invalid-timing",
        status: "inProgress",
        items: [],
        startedAt: Number.POSITIVE_INFINITY,
        durationMs: -1,
      }}
    />);

    expect(screen.getByRole("status", { name: "Turn status" })).toHaveTextContent("Reasoning idle");
    expect(screen.queryByRole("group", { name: "Turn details" })).not.toBeInTheDocument();
  });

  it("omits an idle turn with neither metadata nor status", () => {
    const { container } = render(
      <TurnStatusSlot reasoningActive={false} turn={{ id: "turn-unknown", items: [] }} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
