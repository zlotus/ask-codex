import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toolbar } from "./Toolbar";

describe("Toolbar", () => {
  it("keeps the header compact and delegates detailed settings to the dialog", () => {
    const onSettings = vi.fn();
    render(
      <Toolbar
        settings={{ cwd: "/workspace", model: "", effort: "", sandbox: "workspace-write" }}
        title="Thread title"
        connection="connected"
        connectionDetail="Ready"
        running={false}
        syncing={false}
        syncError={null}
        retryAttempt={0}
        onUsage={vi.fn()}
        onReconnect={vi.fn()}
        onResync={vi.fn()}
        onSettings={onSettings}
        onMenu={vi.fn()}
      />,
    );

    expect(screen.getByText("Thread title")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Thread settings" }));
    expect(onSettings).toHaveBeenCalledOnce();
  });

  it("surfaces non-default sandbox risk", () => {
    render(
      <Toolbar
        settings={{ cwd: "/workspace", model: "", effort: "", sandbox: "danger-full-access" }}
        title="Thread"
        connection="connected"
        connectionDetail="Ready"
        running
        syncing={false}
        syncError={null}
        retryAttempt={0}
        onUsage={vi.fn()}
        onReconnect={vi.fn()}
        onResync={vi.fn()}
        onSettings={vi.fn()}
        onMenu={vi.fn()}
      />,
    );

    expect(screen.getByText("Full access")).toBeInTheDocument();
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("opens usage and keeps synchronization distinct from turn activity", () => {
    const onUsage = vi.fn();
    render(
      <Toolbar
        settings={{ cwd: "/workspace", model: "", effort: "", sandbox: "workspace-write" }}
        title="Thread"
        connection="connected"
        connectionDetail="Ready"
        running
        syncing
        syncError={null}
        retryAttempt={0}
        onUsage={onUsage}
        onReconnect={vi.fn()}
        onResync={vi.fn()}
        onSettings={vi.fn()}
        onMenu={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Connected · Syncing");
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Usage and limits" }));
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it("makes a failed connection directly retryable and announces the retry attempt", () => {
    const onReconnect = vi.fn();
    render(
      <Toolbar
        settings={{ cwd: "/workspace", model: "", effort: "", sandbox: "workspace-write" }}
        title="Thread"
        connection="disconnected"
        connectionDetail="Disconnected · retrying in 4s"
        running={false}
        syncing={false}
        syncError={null}
        retryAttempt={3}
        onUsage={vi.fn()}
        onReconnect={onReconnect}
        onResync={vi.fn()}
        onSettings={vi.fn()}
        onMenu={vi.fn()}
      />,
    );

    const reconnect = screen.getByRole("button", { name: /Retry connection now/ });
    expect(reconnect).toHaveTextContent("Retrying · attempt 3");
    fireEvent.click(reconnect);
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("keeps a failed live-state sync blocked and directly retryable", () => {
    const onResync = vi.fn();
    render(
      <Toolbar
        settings={{ cwd: "/workspace", model: "", effort: "", sandbox: "workspace-write" }}
        title="Thread"
        connection="connected"
        connectionDetail="Ready"
        running={false}
        syncing={false}
        syncError="Live state refresh failed"
        retryAttempt={0}
        onUsage={vi.fn()}
        onReconnect={vi.fn()}
        onResync={onResync}
        onSettings={vi.fn()}
        onMenu={vi.fn()}
      />,
    );

    const retry = screen.getByRole("button", { name: /Retry live state sync/ });
    expect(retry).toHaveTextContent("Sync failed · Retry");
    fireEvent.click(retry);
    expect(onResync).toHaveBeenCalledOnce();
  });
});
