import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ItemRenderer } from "./ItemRenderer";
import { TurnView } from "./TurnView";

function openDetails(label: string, index = 0) {
  const details = screen.getAllByText(label)[index]?.closest("details");
  if (!details) throw new Error(`Could not find details for ${label}`);
  details.open = true;
  fireEvent(details, new Event("toggle", { bubbles: true }));
}

describe("ItemRenderer", () => {
  it("renders agent Markdown as formatted content", () => {
    render(<ItemRenderer item={{ id: "agent-1", type: "agentMessage", text: "The **fix** is ready." }} />);

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("fix").tagName).toBe("STRONG");
  });

  it("defers completed command output and strips terminal control sequences", () => {
    const { container } = render(<ItemRenderer item={{
      id: "command-1",
      type: "commandExecution",
      command: "npm test",
      status: "completed",
      aggregatedOutput: "\u001b[32mTests passed\u001b[0m",
      exitCode: 0,
    }} />);

    expect(screen.getAllByText("npm test")).toHaveLength(1);
    expect(container.querySelector(".code-block")).not.toBeInTheDocument();
    openDetails("Command");
    expect(screen.getAllByText("npm test")).toHaveLength(2);
    expect(screen.getByText("Tests passed")).toBeInTheDocument();
    expect(screen.getByText("exit 0")).toBeInTheDocument();
  });

  it("makes bounded streaming output explicit", () => {
    render(<ItemRenderer item={{
      id: "command-1",
      type: "commandExecution",
      command: "npm test",
      aggregatedOutput: "partial output",
      streamOmittedCharacters: { aggregatedOutput: 2_048 },
    }} />);

    openDetails("Command");
    expect(screen.getByText("2,048 characters omitted while streaming")).toBeInTheDocument();
  });

  it("renders a separate expandable diff for each file change", () => {
    const { container } = render(<ItemRenderer item={{
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
    const diffs = screen.getAllByText("Diff");
    expect(diffs).toHaveLength(2);
    expect(container.querySelector(".diff-raw-fallback")).not.toBeInTheDocument();
    openDetails("Diff", 1);
    expect(screen.getByText("+export {};" )).toBeInTheDocument();
  });

  it("renders canonical reasoning summary and content separately", () => {
    const { container } = render(<ItemRenderer item={{
      id: "reasoning-1",
      type: "reasoning",
      summary: ["Short summary"],
      content: ["Detailed reasoning"],
    }} />);

    expect(container.querySelector(".markdown")).not.toBeInTheDocument();
    openDetails("Reasoning");
    expect(screen.getByText("Short summary")).toBeInTheDocument();
    expect(screen.getByText("Detailed reasoning")).toBeInTheDocument();
  });

  it("makes omitted overflow reasoning parts explicit", () => {
    render(<ItemRenderer item={{
      id: "reasoning-overflow",
      type: "reasoning",
      summary: ["Visible summary"],
      streamOmittedCharacters: { "summary[overflow]": 128 },
    }} />);

    openDetails("Reasoning");
    expect(screen.getByText("128 characters omitted while streaming")).toBeInTheDocument();
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

  it("defers a turn diff until its disclosure opens", () => {
    const { container } = render(<TurnView turn={{
      id: "turn-1",
      status: "completed",
      items: [],
      diff: "@@ -1 +1 @@\n-old\n+new",
    }} />);

    expect(container.querySelector(".diff-viewer")).not.toBeInTheDocument();
    openDetails("Turn diff");
    expect(container.querySelector(".diff-viewer")).toBeInTheDocument();
  });

  it("makes an unrecoverable oversized turn projection explicit", () => {
    render(<TurnView turn={{
      id: "turn-1",
      items: [],
      recoveryOmissions: ["turn/diff/updated"],
    }} />);

    expect(screen.getByText(/latest turn diff exceeded the gateway limit/)).toBeInTheDocument();
  });
});
