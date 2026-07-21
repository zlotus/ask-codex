import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ItemRenderer } from "./ItemRenderer";
import { TurnView } from "./TurnView";

describe("ItemRenderer", () => {
  it("renders agent Markdown as formatted content", () => {
    render(<ItemRenderer item={{ id: "agent-1", type: "agentMessage", text: "The **fix** is ready." }} />);

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("fix").tagName).toBe("STRONG");
  });

  it("renders command state and strips terminal control sequences", () => {
    render(<ItemRenderer item={{
      id: "command-1",
      type: "commandExecution",
      command: "npm test",
      status: "completed",
      aggregatedOutput: "\u001b[32mTests passed\u001b[0m",
      exitCode: 0,
    }} />);

    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("Tests passed")).toBeInTheDocument();
    expect(screen.getByText("exit 0")).toBeInTheDocument();
  });

  it("renders a separate expandable diff for each file change", () => {
    render(<ItemRenderer item={{
      id: "files-1",
      type: "fileChange",
      status: "completed",
      changes: [
        { path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "-old\n+new" },
        { path: "src/b.ts", kind: { type: "add" }, diff: "+export {};" },
      ],
    }} />);

    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
    expect(screen.getAllByText("Diff")).toHaveLength(2);
    expect(screen.getByText("+export {};" )).toBeInTheDocument();
  });

  it("renders canonical reasoning summary and content separately", () => {
    render(<ItemRenderer item={{
      id: "reasoning-1",
      type: "reasoning",
      summary: ["Short summary"],
      content: ["Detailed reasoning"],
    }} />);

    expect(screen.getByText("Short summary")).toBeInTheDocument();
    expect(screen.getByText("Detailed reasoning")).toBeInTheDocument();
  });

  it("renders streamed plan text", () => {
    render(<ItemRenderer item={{ id: "plan-1", type: "plan", text: "1. Inspect\n2. Fix" }} />);

    expect(screen.getByText("Inspect")).toBeInTheDocument();
    expect(screen.getByText("Fix")).toBeInTheDocument();
  });

  it("does not render a successful turn's null error as an alert", () => {
    render(<TurnView turn={{ id: "turn-1", status: "completed", items: [], error: null }} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
  });
});
