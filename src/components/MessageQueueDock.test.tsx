import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MessageQueueItem } from "../types/protocol";
import { MessageQueueDock } from "./MessageQueueDock";

const queued: MessageQueueItem = {
  id: "a".repeat(32),
  threadId: "thread-1",
  text: "Continue the queued task",
  expectedLastTurnId: "turn-1",
  status: "queued",
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: 2,
};

describe("MessageQueueDock", () => {
  it("expands queued items and exposes explicit send, cancel, and refresh actions", () => {
    const onRefresh = vi.fn();
    const onSend = vi.fn();
    const onCancel = vi.fn();
    render(
      <MessageQueueDock
        items={[queued]}
        loading={false}
        error={null}
        disabled={false}
        busyItemId={null}
        onRefresh={onRefresh}
        onSend={onSend}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText("Continue the queued task")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send queued message" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel queued message" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh message queue" }));
    expect(onSend).toHaveBeenCalledWith(queued);
    expect(onCancel).toHaveBeenCalledWith(queued);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Collapse message queue/ }));
    expect(screen.queryByText("Continue the queued task")).not.toBeInTheDocument();
  });

  it("does not offer resend for an indeterminate item", () => {
    render(
      <MessageQueueDock
        items={[{ ...queued, status: "indeterminate", revision: 4 }]}
        loading={false}
        error={null}
        disabled={false}
        busyItemId={null}
        onRefresh={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Outcome unknown")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Send/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss after checking thread history" }))
      .toBeEnabled();
  });
});
