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

  it("keeps a running command collapsed", () => {
    const { container } = render(<ItemRenderer item={{
      id: "command-running",
      type: "commandExecution",
      command: "curl https://example.com/large",
      status: "inProgress",
      aggregatedOutput: "large response",
    }} />);

    expect(container.querySelector(".command-block")).not.toHaveAttribute("open");
    expect(screen.queryByText("large response")).not.toBeInTheDocument();
    expect(screen.getByText("in Progress")).toBeInTheDocument();
  });

  it("keeps approval reasons with the command after approval", () => {
    const command = {
      id: "command-reason",
      type: "commandExecution",
      command: "npm install",
      status: "inProgress",
    };
    const { container, rerender } = render(<ItemRenderer item={command} />);

    openDetails("Command");
    rerender(<ItemRenderer item={{
      ...command,
      status: "completed",
      approvalReasons: ["Download the declared dependency", "Download the declared dependency", "  "],
    }} />);

    expect(container.querySelector(".command-block")).toHaveAttribute("open");
    expect(container.querySelector(".tool-reason-preview")).toHaveTextContent("Download the declared dependency");
    expect(screen.getByText("Reason")).toBeInTheDocument();
    expect(container.querySelectorAll(".tool-reasons li")).toHaveLength(1);
  });

  it("uses a bounded head-tail display for long command output", () => {
    render(<ItemRenderer item={{
      id: "command-long",
      type: "commandExecution",
      command: "curl https://example.com/large",
      status: "completed",
      aggregatedOutput: `head-${"x".repeat(24_500)}-tail`,
    }} />);

    openDetails("Command");
    expect(screen.getByText(/characters omitted from display/)).toBeInTheDocument();
    expect(screen.getByText(/output omitted/)).toBeInTheDocument();
    expect(screen.getByText(/tail/)).toBeInTheDocument();
  });

  it("shows only a strictly bounded tail preview for failed command output", () => {
    const { container } = render(<ItemRenderer item={{
      id: "command-failed-preview",
      type: "commandExecution",
      command: "npm test",
      status: "failed",
      exitCode: 1,
      aggregatedOutput: [
        "first line",
        "second line",
        "third line",
        "fourth line",
        `\u001b[31m${"x".repeat(500)}TAIL\u001b[0m`,
      ].join("\n"),
    }} />);

    const preview = screen.getByLabelText("Error output preview");
    expect(preview.textContent?.length).toBeLessThanOrEqual(360);
    expect(preview.textContent?.split("\n").length).toBeLessThanOrEqual(3);
    expect(preview).not.toHaveTextContent("first line");
    expect(preview).not.toHaveTextContent("second line");
    expect(preview).toHaveTextContent(/TAIL$/);
    expect(container.querySelector(".code-block")).not.toBeInTheDocument();

    openDetails("Command");
    expect(container.querySelector(".command-details .code-block--terminal")).toBeInTheDocument();
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

    expect(screen.getByText("2 files")).toBeInTheDocument();
    expect(screen.queryByText("src/a.ts")).not.toBeInTheDocument();
    openDetails("File changes");
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

  it("groups consecutive tool activities and keeps their details lazy", () => {
    const { container } = render(<TurnView turn={{
      id: "turn-tools",
      items: [
        { id: "command-1", type: "commandExecution", command: "npm test", status: "completed", aggregatedOutput: "passed" },
        { id: "command-2", type: "commandExecution", command: "npm run build", status: "completed" },
        { id: "files-1", type: "fileChange", status: "completed", changes: [{ path: "src/a.ts", kind: "update" }] },
        { id: "search-1", type: "webSearch", status: "completed", query: "Codex app server" },
      ],
    }} />);

    expect(screen.getByText("2 commands, 1 file change, 1 search")).toBeInTheDocument();
    expect(screen.queryByText("npm test")).not.toBeInTheDocument();
    openDetails("2 commands, 1 file change, 1 search");
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.queryByText("passed")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".activity-group-list > .tool-activity")).toHaveLength(4);
  });

  it("breaks activity groups around assistant and plan items", () => {
    render(<TurnView turn={{
      id: "turn-boundaries",
      items: [
        { id: "command-1", type: "commandExecution", command: "pwd" },
        { id: "search-1", type: "webSearch", query: "first search" },
        { id: "agent-1", type: "agentMessage", text: "Interim answer" },
        { id: "files-1", type: "fileChange", changes: [] },
        { id: "mcp-1", type: "mcpToolCall", server: "docs", tool: "search" },
        { id: "plan-1", type: "plan", text: "1. Continue" },
        { id: "command-2", type: "commandExecution", command: "git status" },
      ],
    }} />);

    expect(screen.getByText("1 command, 1 search")).toBeInTheDocument();
    expect(screen.getByText("1 file change, 1 MCP call")).toBeInTheDocument();
    expect(screen.getByText("Interim answer")).toBeInTheDocument();
    expect(screen.getByText("Continue")).toBeInTheDocument();
    expect(screen.getByText("git status")).toBeInTheDocument();
  });

  it("flags a failed group without mounting the full error output", () => {
    const { container } = render(<TurnView turn={{
      id: "turn-failed",
      items: [
        { id: "command-1", type: "commandExecution", command: "npm test", status: "completed", exitCode: 1, aggregatedOutput: "full failure output" },
        { id: "search-1", type: "webSearch", status: "completed", query: "test failure" },
      ],
    }} />);

    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(container.querySelector(".activity-group")).toHaveClass("activity-group--failed");
    expect(screen.queryByText("full failure output")).not.toBeInTheDocument();
    openDetails("1 command, 1 search");
    expect(screen.getByText("failed (exit 1)")).toBeInTheDocument();
    expect(screen.getByLabelText("Error output preview")).toHaveTextContent("full failure output");
    expect(container.querySelector(".command-details")).not.toBeInTheDocument();
  });

  it("preserves manually opened group and command state across streaming updates", () => {
    const initial = {
      id: "turn-streaming",
      items: [
        { id: "command-1", type: "commandExecution", command: "npm test", status: "inProgress", aggregatedOutput: "partial" },
        { id: "search-1", type: "webSearch", status: "inProgress", query: "test docs" },
      ],
    };
    const { container, rerender } = render(<TurnView turn={initial} />);

    expect(container.querySelector(".activity-group > summary .status-pill")).toHaveClass("status-pill--running");
    openDetails("1 command, 1 search");
    openDetails("Command");
    expect(screen.getByText("partial")).toBeInTheDocument();

    rerender(<TurnView turn={{
      ...initial,
      items: [
        { ...initial.items[0], status: "completed", aggregatedOutput: "partial\ncomplete" },
        { ...initial.items[1], status: "completed" },
        { id: "mcp-1", type: "mcpToolCall", status: "completed", server: "docs", tool: "search" },
      ],
    }} />);

    expect(container.querySelector(".activity-group")).toHaveAttribute("open");
    expect(container.querySelector(".command-block")).toHaveAttribute("open");
    expect(container.querySelector(".command-details .code-block--terminal code")).toHaveTextContent("partial complete");
    expect(screen.getByText("1 command, 1 MCP call, 1 search")).toBeInTheDocument();
  });

  it("preserves a command disclosure when a streamed singleton becomes a group", () => {
    const initial = {
      id: "turn-singleton",
      items: [{
        id: "command-1",
        type: "commandExecution",
        command: "npm test",
        status: "inProgress",
        aggregatedOutput: "partial output",
      }],
    };
    const { container, rerender } = render(<TurnView turn={initial} />);

    openDetails("Command");
    expect(screen.getByText("partial output")).toBeInTheDocument();

    rerender(<TurnView turn={{
      ...initial,
      items: [
        initial.items[0],
        { id: "search-1", type: "webSearch", query: "test docs" },
      ],
    }} />);

    expect(container.querySelector(".activity-group")).toHaveAttribute("open");
    expect(container.querySelector(".command-block")).toHaveAttribute("open");
    expect(screen.getByText("partial output")).toBeInTheDocument();
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
