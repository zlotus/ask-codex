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
});
