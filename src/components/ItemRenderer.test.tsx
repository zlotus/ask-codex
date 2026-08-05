import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ItemRenderer } from "./ItemRenderer";
import { TurnView } from "./TurnView";

const FILE_CAPABILITY_ID = "a".repeat(32);

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

  it("does not expose agent file capabilities in user message Markdown", () => {
    const onDownloadFile = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<ItemRenderer
      item={{
        id: "user-file-link",
        type: "userMessage",
        content: [{ type: "text", text: "[report](/tmp/report.txt)", text_elements: [] }],
        askCodexFileDownloads: [{ href: "/tmp/report.txt", capabilityId: FILE_CAPABILITY_ID }],
      }}
      onDownloadFile={onDownloadFile}
    />);

    expect(screen.getByText("report")).toHaveClass("markdown-local-file-reference");
    expect(screen.queryByRole("link", { name: "report" })).not.toBeInTheDocument();
    expect(container.querySelector("[href='/tmp/report.txt']")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download report.txt" })).not.toBeInTheDocument();
    expect(onDownloadFile).not.toHaveBeenCalled();
  });

  it("shows safe placeholders for user images without exposing host paths", () => {
    render(<ItemRenderer item={{
      id: "user-images",
      type: "userMessage",
      content: [
        { type: "localImage", path: "/private/ask-codex-secret/image.png" },
        { type: "text", text: "Compare these", text_elements: [] },
        { type: "image", url: "https://private.example/image.jpg", detail: "high" },
      ],
    }} />);

    expect(screen.getByText("Compare these")).toBeInTheDocument();
    expect(screen.getByLabelText("2 image attachments")).toBeInTheDocument();
    const firstImage = screen.getByText("Image 1");
    const text = screen.getByText("Compare these");
    const secondImage = screen.getByText("Image 2");
    expect(firstImage.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text.compareDocumentPosition(secondImage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.body).not.toHaveTextContent("/private/ask-codex-secret");
    expect(document.body).not.toHaveTextContent("private.example");
  });

  it("renders browser-session local images as clickable previews", () => {
    render(<ItemRenderer
      imagePreviewUrls={["blob:local-first", "blob:local-second"]}
      item={{
        id: "user-preview-images",
        type: "userMessage",
        content: [
          { type: "localImage", path: "/private/first.png" },
          { type: "text", text: "Compare all three", text_elements: [] },
          { type: "image", url: "https://private.example/remote.jpg" },
          { type: "localImage", path: "/private/second.png" },
        ],
      }}
    />);

    const previews = screen.getAllByRole("link", { name: /Open uploaded image/ });
    expect(previews).toHaveLength(2);
    expect(previews[0]).toHaveAttribute("href", "blob:local-first");
    expect(previews[0]).toHaveAttribute("target", "_blank");
    expect(previews[1]).toHaveAttribute("href", "blob:local-second");
    expect(screen.getByLabelText("Image 2 of 3")).toHaveTextContent("Image 2");
    expect(document.body).not.toHaveTextContent("/private/first.png");
    expect(document.body).not.toHaveTextContent("private.example");
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
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("Short summary")).toBeInTheDocument();
    expect(screen.getByText("Detailed reasoning")).toBeInTheDocument();
  });

  it("hides completed reasoning that has no visible content", () => {
    const { container } = render(<ItemRenderer item={{
      id: "reasoning-empty",
      type: "reasoning",
      summary: [],
      content: [],
    }} />);

    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
    expect(container.querySelector("details")).not.toBeInTheDocument();
  });

  it("groups adjacent reasoning without crossing activity boundaries", () => {
    const { container } = render(<TurnView turn={{
      id: "turn-reasoning-groups",
      items: [
        { id: "reasoning-1", type: "reasoning", summary: ["First summary"], content: [] },
        { id: "reasoning-2", type: "reasoning", summary: ["Second summary"], content: [] },
        { id: "command-1", type: "commandExecution", command: "pwd", status: "completed" },
        { id: "reasoning-3", type: "reasoning", summary: ["Third summary"], content: [] },
      ],
    }} />);

    expect(screen.getByText("Reasoning (2)")).toBeInTheDocument();
    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(container.querySelectorAll(".reasoning-block")).toHaveLength(2);
    expect(screen.queryByText("First summary")).not.toBeInTheDocument();
    openDetails("Reasoning (2)");
    expect(screen.getByText("First summary")).toBeInTheDocument();
    expect(screen.getByText("Second summary")).toBeInTheDocument();
    expect(screen.queryByText("Third summary")).not.toBeInTheDocument();
  });

  it("keeps empty reasoning out of the activity stream while its fixed status slot changes in place", () => {
    const turn = {
      id: "turn-live-reasoning",
      status: "inProgress",
      items: [
        { id: "reasoning-1", type: "reasoning", summary: [], content: [] },
        { id: "reasoning-2", type: "reasoning", summary: [], content: [] },
      ],
    };
    const { container, rerender } = render(
      <TurnView activeReasoningItemIds={["reasoning-2"]} turn={turn} />,
    );

    const statusSlot = screen.getByRole("status", { name: "Turn status" });
    const statusSlotClassName = statusSlot.className;
    const statusLine = container.querySelector(".turn-reasoning-status");
    const statusChildren = statusLine ? [...statusLine.children] : [];
    expect(statusSlot).toHaveClass("turn-status-slot--in-progress");
    expect(statusSlot).toHaveTextContent("Reasoning active");
    expect(statusLine).not.toBeNull();
    expect(statusChildren).toHaveLength(2);
    expect(container.querySelector(".turn-reasoning-status svg")).toHaveClass("spin");
    expect(container.querySelector(".reasoning-block")).not.toBeInTheDocument();
    expect(container.querySelector(".activity-stack")).not.toBeInTheDocument();

    rerender(<TurnView activeReasoningItemIds={[]} turn={turn} />);

    const idleStatusSlot = screen.getByRole("status", { name: "Turn status" });
    const idleStatusLine = container.querySelector(".turn-reasoning-status");
    expect(idleStatusSlot).toBe(statusSlot);
    expect(idleStatusLine).toBe(statusLine);
    expect(idleStatusSlot.className).toBe(statusSlotClassName);
    expect(idleStatusSlot).toHaveClass("turn-status-slot--in-progress");
    expect(idleStatusSlot).toHaveTextContent("Reasoning idle");
    expect(idleStatusLine ? [...idleStatusLine.children] : []).toEqual(statusChildren);
    expect(container.querySelector(".turn-reasoning-status svg")).not.toHaveClass("spin");
    expect(container.querySelector(".reasoning-block")).not.toBeInTheDocument();
    expect(container.querySelector(".activity-stack")).not.toBeInTheDocument();
  });

  it("stacks consecutive reasoning and tool activities but breaks around semantic messages", () => {
    const { container } = render(<TurnView turn={{
      id: "turn-activity-stacks",
      status: "inProgress",
      items: [
        { id: "reasoning-1", type: "reasoning", summary: ["First reasoning"], content: [] },
        { id: "command-1", type: "commandExecution", command: "pwd", status: "completed" },
        { id: "image-1", type: "imageView", path: "/private/first.png" },
        { id: "agent-1", type: "agentMessage", text: "Semantic boundary" },
        { id: "reasoning-2", type: "reasoning", summary: ["Second reasoning"], content: [] },
        { id: "search-1", type: "webSearch", query: "documented API", status: "completed" },
      ],
    }} />);

    const stacks = [...container.querySelectorAll(".activity-stack")];
    const message = container.querySelector(".message--agent");
    expect(stacks).toHaveLength(2);
    expect(stacks[0].querySelectorAll(":scope > .reasoning-block")).toHaveLength(1);
    expect(stacks[0].querySelectorAll(":scope > .activity-group")).toHaveLength(1);
    expect(stacks[1].querySelectorAll(":scope > .reasoning-block")).toHaveLength(1);
    expect(stacks[1].querySelectorAll(":scope > .tool-activity")).toHaveLength(1);
    expect(message).not.toBeNull();
    expect(stacks[0].compareDocumentPosition(message as Node) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect((message as Node).compareDocumentPosition(stacks[1]) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(message?.closest(".activity-stack")).toBeNull();
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
    expect(screen.queryByRole("group", { name: "Turn details" })).not.toBeInTheDocument();
  });

  it("renders native turn start time and duration in the footer", () => {
    render(<TurnView turn={{
      id: "turn-timed",
      status: "completed",
      items: [],
      startedAt: 1_800_000_000,
      completedAt: 1_800_000_002.5,
      durationMs: 2_500,
    }} />);

    const details = screen.getByRole("group", { name: "Turn details" });
    expect(details).toHaveTextContent("Started");
    expect(details).toHaveTextContent("Duration 2.5s");
    expect(details.querySelector("time")).toHaveAttribute(
      "datetime",
      new Date(1_800_000_000_000).toISOString(),
    );
  });

  it.each([
    [450, "Duration 450ms"],
    [60_000, "Duration 1m"],
    [3_661_000, "Duration 1h 1m 1s"],
  ])("formats a %ims turn duration as %s", (durationMs, expected) => {
    render(<TurnView turn={{ id: `turn-${durationMs}`, items: [], durationMs }} />);

    expect(screen.getByRole("group", { name: "Turn details" })).toHaveTextContent(expected);
  });

  it("hides null or invalid turn timing", () => {
    const { rerender } = render(<TurnView turn={{
      id: "turn-untimed",
      status: "inProgress",
      items: [],
      startedAt: null,
      completedAt: null,
      durationMs: null,
    }} />);

    expect(screen.queryByRole("group", { name: "Turn details" })).not.toBeInTheDocument();

    rerender(<TurnView turn={{
      id: "turn-invalid-timing",
      status: "inProgress",
      items: [],
      startedAt: Number.POSITIVE_INFINITY,
      durationMs: -1,
    }} />);
    expect(screen.queryByRole("group", { name: "Turn details" })).not.toBeInTheDocument();
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

  it("groups formal machine activities and renders their safe details lazily", () => {
    const { container } = render(<TurnView turn={{
      id: "turn-formal-activities",
      items: [
        {
          id: "dynamic-1",
          type: "dynamicToolCall",
          namespace: "tools",
          tool: "search",
          status: "completed",
          arguments: { query: "documented API" },
          contentItems: [
            { type: "inputText", text: "Found the API reference" },
            { type: "inputImage", imageUrl: "file:///private/dynamic-result.png" },
          ],
          success: true,
        },
        {
          id: "collab-1",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "thread-private-sender",
          receiverThreadIds: ["thread-private-receiver"],
          prompt: "Inspect the renderer",
          model: "gpt-test",
          reasoningEffort: "medium",
          agentsStates: { "thread-private-receiver": { status: "completed", message: null } },
        },
        {
          id: "subagent-1",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "thread-private-agent",
          agentPath: "/private/agents/renderer",
        },
        { id: "image-view-1", type: "imageView", path: "/private/screenshots/result.png" },
      ],
    }} />);

    expect(screen.getByText("1 dynamic tool, 1 agent call, 1 agent update, 1 image view")).toBeInTheDocument();
    expect(screen.queryByText("Found the API reference")).not.toBeInTheDocument();
    openDetails("1 dynamic tool, 1 agent call, 1 agent update, 1 image view");
    expect(container.querySelectorAll(".activity-group-list > .tool-activity")).toHaveLength(4);
    expect(screen.getByText("tools / search")).toBeInTheDocument();
    expect(screen.getByText("Spawn agent")).toBeInTheDocument();
    expect(screen.getByText("Agent started")).toBeInTheDocument();
    expect(screen.getByText("Viewed image")).toBeInTheDocument();
    expect(screen.queryByText("Found the API reference")).not.toBeInTheDocument();

    openDetails("tools / search");
    expect(screen.getByText("Found the API reference")).toBeInTheDocument();
    expect(screen.getByText("1 image output")).toBeInTheDocument();
    openDetails("Spawn agent");
    expect(screen.getByText("Inspect the renderer")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent states")).toHaveTextContent("1 completed");
    expect(document.body).not.toHaveTextContent("/private/");
    expect(document.body).not.toHaveTextContent("thread-private");
    expect(document.body).not.toHaveTextContent("file://");
  });

  it("renders the remaining formal activity events without exposing generated paths", () => {
    render(<TurnView turn={{
      id: "turn-formal-events",
      items: [
        { id: "sleep-1", type: "sleep", durationMs: 1_500 },
        {
          id: "image-generation-1",
          type: "imageGeneration",
          status: "completed",
          revisedPrompt: "A compact command palette",
          result: "file:///private/generated/result.png",
          savedPath: "/private/generated/result.png",
        },
        { id: "review-1", type: "enteredReviewMode", review: "Review the current changes" },
        { id: "compact-1", type: "contextCompaction" },
        {
          id: "hook-1",
          type: "hookPrompt",
          fragments: [{ text: "Check project policy", hookRunId: "private-hook-run" }],
        },
      ],
    }} />);

    openDetails("1 image generation, 1 wait, 1 review event, 1 compaction, 1 hook prompt");
    expect(screen.getByText("Waited")).toBeInTheDocument();
    expect(screen.getByText("1.5s")).toBeInTheDocument();
    expect(screen.getByText("Image generation")).toBeInTheDocument();
    expect(screen.getByText("Review started")).toBeInTheDocument();
    expect(screen.getByText("Context compacted")).toBeInTheDocument();
    expect(screen.getByText("Hook prompt")).toBeInTheDocument();
    expect(screen.queryByText("A compact command palette")).not.toBeInTheDocument();

    openDetails("Image generation");
    expect(screen.getByText("A compact command palette")).toBeInTheDocument();
    expect(screen.getByText("Image result available")).toBeInTheDocument();
    openDetails("Hook prompt");
    expect(screen.getByText("Check project policy")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("/private/generated");
    expect(document.body).not.toHaveTextContent("file://");
    expect(document.body).not.toHaveTextContent("private-hook-run");
  });

  it("marks unsuccessful dynamic tools as failed and keeps truly unknown items as fallback details", () => {
    const { container, rerender } = render(<TurnView turn={{
      id: "turn-dynamic-failed",
      items: [
        { id: "dynamic-1", type: "dynamicToolCall", tool: "lookup", status: "completed", success: false },
        { id: "image-view-1", type: "imageView", path: "/private/result.png" },
      ],
    }} />);

    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(container.querySelector(".activity-group")).toHaveClass("activity-group--failed");

    rerender(<ItemRenderer item={{ id: "future-1", type: "futureMachineItem", value: "future payload" }} />);
    expect(screen.getByText("futureMachineItem")).toBeInTheDocument();
    openDetails("futureMachineItem");
    expect(screen.getByText(/future payload/)).toBeInTheDocument();
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
      startedAt: 1_800_000_000,
      durationMs: 1_000,
      diff: "@@ -1 +1 @@\n-old\n+new",
    }} />);

    const diff = container.querySelector(".turn-diff");
    const footer = container.querySelector(".turn-footer");
    expect(diff).not.toBeNull();
    expect(footer).not.toBeNull();
    expect((diff as Node).compareDocumentPosition(footer as Node) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(container.querySelector(".diff-viewer")).not.toBeInTheDocument();
    openDetails("Changes in this turn");
    expect(container.querySelector(".diff-viewer")).toBeInTheDocument();
  });

  it("keeps the aggregate turn diff after messages that arrive later", () => {
    const firstMessage = { id: "agent-1", type: "agentMessage", text: "First update" } as const;
    const { container, rerender } = render(<TurnView turn={{
      id: "turn-diff-order",
      status: "inProgress",
      items: [firstMessage],
      diff: "@@ -1 +1 @@",
    }} />);

    const assertDiffFollowsMessages = () => {
      const diff = container.querySelector(".turn-diff");
      const messages = [...container.querySelectorAll(".message--agent")];
      expect(diff).not.toBeNull();
      expect(messages).not.toHaveLength(0);
      for (const message of messages) {
        expect(message.compareDocumentPosition(diff as Node) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      }
    };
    assertDiffFollowsMessages();

    rerender(<TurnView turn={{
      id: "turn-diff-order",
      status: "inProgress",
      items: [
        firstMessage,
        { id: "agent-2", type: "agentMessage", text: "Later update" },
      ],
      diff: "@@ -1 +1 @@",
    }} />);

    expect(screen.getByText("Later update")).toBeInTheDocument();
    assertDiffFollowsMessages();
  });

  it("makes unrecoverable turn projections explicit", () => {
    render(<TurnView turn={{
      id: "turn-1",
      items: [],
      recoveryOmissions: ["turn/diff/updated", "turn/plan/updated"],
    }} />);

    expect(screen.getByText(/latest turn diff exceeded the gateway limit/)).toBeInTheDocument();
    expect(screen.getByText(/latest turn plan could not be recovered/)).toBeInTheDocument();
  });
});
