import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "./Conversation";

const FILE_CAPABILITY_ID = "a".repeat(32);

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
