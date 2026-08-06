import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexTurn } from "../types/protocol";
import { Conversation } from "./Conversation";

const FILE_CAPABILITY_ID = "a".repeat(32);

const conversationProps = {
  loading: false,
  loadError: null,
  historyLoading: false,
  hasMore: false,
  historyError: null,
  onLoadEarlier: vi.fn(),
  onLoadTurnDetail: vi.fn(),
  onRetryThread: vi.fn(),
};

function turnRange(first: number, last: number): CodexTurn[] {
  return Array.from({ length: last - first + 1 }, (_, offset) => {
    const number = first + offset;
    return {
      id: `turn-${number}`,
      status: "completed",
      items: [{ id: `message-${number}`, type: "agentMessage", text: `Turn message ${number}` }],
    };
  });
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Conversation history recovery", () => {
  it("passes an agent file capability to the download handler", async () => {
    const onDownloadFile = vi.fn().mockResolvedValue(undefined);
    render(
      <Conversation
        thread={{
          id: "thread-1",
          turns: [{
            id: "turn-1",
            status: "completed",
            items: [{
              id: "agent-file",
              type: "agentMessage",
              text: "[report](/tmp/report.txt)",
              askCodexFileDownloads: [{ href: "/tmp/report.txt", capabilityId: FILE_CAPABILITY_ID }],
            }],
          }],
        }}
        loading={false}
        loadError={null}
        historyLoading={false}
        hasMore={false}
        historyError={null}
        onDownloadFile={onDownloadFile}
        onLoadEarlier={vi.fn()}
        onLoadTurnDetail={vi.fn()}
        onRetryThread={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download report.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm download report.txt" }));

    expect(onDownloadFile).toHaveBeenCalledWith({
      href: "/tmp/report.txt",
      capabilityId: FILE_CAPABILITY_ID,
    });
  });

  it("keeps a newly updated turn diff in view when the reader is near the bottom", () => {
    const item = { id: "agent", type: "agentMessage", text: "Finished" };
    const baseProps = {
      loading: false,
      loadError: null,
      historyLoading: false,
      hasMore: false,
      historyError: null,
      onLoadEarlier: vi.fn(),
      onLoadTurnDetail: vi.fn(),
      onRetryThread: vi.fn(),
    };
    const { rerender } = render(
      <Conversation
        {...baseProps}
        thread={{ id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", items: [item] }] }}
      />,
    );
    const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollTo.mockClear();

    rerender(
      <Conversation
        {...baseProps}
        thread={{
          id: "thread-1",
          turns: [{ id: "turn-1", status: "inProgress", items: [item], diff: "@@ -1 +1 @@" }],
        }}
      />,
    );

    expect(scrollTo).toHaveBeenCalledWith({ top: expect.any(Number), behavior: "smooth" });
  });

  it("shows a persistent retry action when the initial thread load fails", () => {
    const onRetryThread = vi.fn();
    render(
      <Conversation
        thread={null}
        loading={false}
        loadError="Connection closed"
        historyLoading={false}
        hasMore={false}
        historyError={null}
        onLoadEarlier={vi.fn()}
        onLoadTurnDetail={vi.fn()}
        onRetryThread={onRetryThread}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Connection closed");
    fireEvent.click(screen.getByRole("button", { name: "Retry thread" }));
    expect(onRetryThread).toHaveBeenCalledOnce();
    expect(screen.queryByText("What should Codex work on?")).not.toBeInTheDocument();
  });

  it("lets a summary-only turn retry loading full detail", () => {
    const onLoadTurnDetail = vi.fn();
    render(
      <Conversation
        thread={{
          id: "thread-1",
          turns: [{
            id: "turn-large",
            items: [],
            itemsView: "summary",
            historyDetail: { cursor: "page-large", status: "error", error: "Too large" },
          }],
        }}
        loading={false}
        loadError={null}
        historyLoading={false}
        hasMore={false}
        historyError={null}
        onLoadEarlier={vi.fn()}
        onLoadTurnDetail={onLoadTurnDetail}
        onRetryThread={vi.fn()}
      />,
    );

    expect(screen.getByText("Large turn loaded as a summary")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Too large");
    fireEvent.click(screen.getByRole("button", { name: "Retry full detail" }));
    expect(onLoadTurnDetail).toHaveBeenCalledWith("turn-large");
  });

  it("lets a partially hydrated turn load its next item page", () => {
    const onLoadTurnDetail = vi.fn();
    render(
      <Conversation
        thread={{
          id: "thread-1",
          turns: [{
            id: "turn-large",
            items: [{ id: "message", type: "agentMessage", text: "First page" }],
            itemsView: "summary",
            historyDetail: {
              cursor: null,
              nextItemCursor: "item-page-2",
              status: "error",
              error: "Connection closed",
            },
          }],
        }}
        loading={false}
        loadError={null}
        historyLoading={false}
        hasMore={false}
        historyError={null}
        onLoadEarlier={vi.fn()}
        onLoadTurnDetail={onLoadTurnDetail}
        onRetryThread={vi.fn()}
      />,
    );

    expect(screen.getByText("Large turn detail loaded in parts")).toBeInTheDocument();
    expect(screen.getByText("First page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry more detail" }));
    expect(onLoadTurnDetail).toHaveBeenCalledWith("turn-large");
  });

  it("waits for a running summary turn to complete before loading history pages", () => {
    const onLoadTurnDetail = vi.fn();
    render(
      <Conversation
        thread={{
          id: "thread-1",
          turns: [{
            id: "turn-running",
            status: "inProgress",
            items: [],
            itemsView: "summary",
            historyDetail: { cursor: null, status: "idle", error: null },
          }],
        }}
        loading={false}
        loadError={null}
        historyLoading={false}
        hasMore={false}
        historyError={null}
        onLoadEarlier={vi.fn()}
        onLoadTurnDetail={onLoadTurnDetail}
        onRetryThread={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: "Waiting for completion" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onLoadTurnDetail).not.toHaveBeenCalled();
  });

  it("does not offer another retry after a permanent detail failure", () => {
    render(
      <Conversation
        thread={{
          id: "thread-1",
          turns: [{
            id: "turn-large",
            status: "completed",
            items: [],
            itemsView: "summary",
            historyDetail: {
              cursor: null,
              status: "unavailable",
              error: "One item exceeds Ask Codex transport limits",
            },
          }],
        }}
        loading={false}
        loadError={null}
        historyLoading={false}
        hasMore={false}
        historyError={null}
        onLoadEarlier={vi.fn()}
        onLoadTurnDetail={vi.fn()}
        onRetryThread={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Detail unavailable" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("transport limits");
  });
});

describe("Conversation turn mounting budget", () => {
  it("mounts only the latest 24 turns and navigates between loaded windows", () => {
    const { container } = render(
      <Conversation
        {...conversationProps}
        thread={{ id: "thread-window", turns: turnRange(1, 40) }}
      />,
    );

    expect(container.querySelectorAll("[data-turn-id]")).toHaveLength(24);
    expect(container.querySelector('[data-turn-id="turn-16"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-17"]')).toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-40"]')).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show earlier loaded turns" }));

    expect(container.querySelectorAll("[data-turn-id]")).toHaveLength(24);
    expect(container.querySelector('[data-turn-id="turn-4"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-5"]')).toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-28"]')).toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-29"]')).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show newer loaded turns" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show earlier loaded turns" }));

    expect(container.querySelector('[data-turn-id="turn-1"]')).toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-25"]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show newer loaded turns" }));
    fireEvent.click(screen.getByRole("button", { name: "Show newer loaded turns" }));

    expect(container.querySelector('[data-turn-id="turn-1"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-40"]')).toBeInTheDocument();
  });

  it("keeps the active turn mounted while browsing the earliest loaded turns", () => {
    const turns = turnRange(1, 40);
    turns[39] = { ...turns[39], status: "inProgress" };
    const { container } = render(
      <Conversation
        {...conversationProps}
        thread={{ id: "thread-active", turns }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show earlier loaded turns" }));
    fireEvent.click(screen.getByRole("button", { name: "Show earlier loaded turns" }));

    expect(container.querySelectorAll("[data-turn-id]")).toHaveLength(24);
    expect(container.querySelector('[data-turn-id="turn-1"]')).toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-40"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show newer loaded turns" })).toBeInTheDocument();
  });

  it("reveals a newly prepended history page after Load earlier is used", () => {
    const onLoadEarlier = vi.fn();
    const { container, rerender } = render(
      <Conversation
        {...conversationProps}
        hasMore
        onLoadEarlier={onLoadEarlier}
        thread={{ id: "thread-prepend", turns: turnRange(11, 34) }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load earlier turns" }));
    expect(onLoadEarlier).toHaveBeenCalledOnce();

    rerender(
      <Conversation
        {...conversationProps}
        hasMore
        onLoadEarlier={onLoadEarlier}
        thread={{ id: "thread-prepend", turns: turnRange(1, 34) }}
      />,
    );

    expect(container.querySelectorAll("[data-turn-id]")).toHaveLength(24);
    expect(container.querySelector('[data-turn-id="turn-1"]')).toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-24"]')).toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-34"]')).not.toBeInTheDocument();
  });

  it("follows a new turn at the bottom but preserves a reader's older window", () => {
    const { container, rerender } = render(
      <Conversation
        {...conversationProps}
        thread={{ id: "thread-follow", turns: turnRange(1, 30) }}
      />,
    );
    const scroll = container.querySelector(".conversation-scroll");
    if (!(scroll instanceof HTMLElement)) throw new Error("Expected conversation scroller");

    rerender(
      <Conversation
        {...conversationProps}
        thread={{ id: "thread-follow", turns: turnRange(1, 31) }}
      />,
    );

    expect(container.querySelector('[data-turn-id="turn-31"]')).toBeInTheDocument();
    expect(container.querySelectorAll("[data-turn-id]")).toHaveLength(24);

    Object.defineProperties(scroll, {
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 500 },
    });
    fireEvent.scroll(scroll);

    rerender(
      <Conversation
        {...conversationProps}
        thread={{ id: "thread-follow", turns: turnRange(1, 32) }}
      />,
    );

    expect(container.querySelector('[data-turn-id="turn-8"]')).toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-32"]')).not.toBeInTheDocument();
    expect(container.querySelectorAll("[data-turn-id]")).toHaveLength(24);
  });

  it("resets to the latest window when switching threads", () => {
    const { container, rerender } = render(
      <Conversation
        {...conversationProps}
        thread={{ id: "thread-first", turns: turnRange(1, 40) }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show earlier loaded turns" }));
    fireEvent.click(screen.getByRole("button", { name: "Show earlier loaded turns" }));
    expect(container.querySelector('[data-turn-id="turn-1"]')).toBeInTheDocument();

    rerender(
      <Conversation
        {...conversationProps}
        thread={{ id: "thread-second", turns: turnRange(101, 140) }}
      />,
    );

    expect(container.querySelectorAll("[data-turn-id]")).toHaveLength(24);
    expect(container.querySelector('[data-turn-id="turn-101"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-117"]')).toBeInTheDocument();
    expect(container.querySelector('[data-turn-id="turn-140"]')).toBeInTheDocument();
  });
});
