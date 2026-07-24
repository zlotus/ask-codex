import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "./Conversation";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("Conversation history recovery", () => {
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
