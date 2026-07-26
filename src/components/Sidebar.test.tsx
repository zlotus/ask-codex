import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { CodexThread } from "../types/protocol";
import { Sidebar } from "./Sidebar";

const activeThread: CodexThread = {
  id: "thread-active",
  name: "Active thread",
  cwd: "/workspace/active",
  status: "completed",
};

const archivedThread: CodexThread = {
  id: "thread-archived",
  name: "Archived thread",
  cwd: "/workspace/archived",
  status: "completed",
};

function sidebarProps(overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
  return {
    threads: [activeThread],
    archivedThreads: [archivedThread],
    selectedThreadId: null,
    search: "",
    open: true,
    loading: false,
    connection: "connected" as const,
    isThreadActive: vi.fn(() => false),
    onSearch: vi.fn(),
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    onToken: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("Sidebar thread lifecycle actions", () => {
  it("opens the shared menu on right click and closes it outside or with Escape", () => {
    const props = sidebarProps();
    render(<Sidebar {...props} />);
    const row = screen.getByRole("button", { name: "Active thread" });

    fireEvent.contextMenu(row, { clientX: 100, clientY: 120 });
    expect(screen.getByRole("menu", { name: "Actions for Active thread" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
    expect(props.onSelect).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(row, { clientX: 100, clientY: 120 });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });

  it("opens from More and requires a permanent-delete confirmation", async () => {
    const props = sidebarProps();
    render(<Sidebar {...props} />);
    const more = screen.getByRole("button", { name: "More actions for Active thread" });

    fireEvent.click(more);
    expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    const dialog = screen.getByRole("dialog", { name: "Delete thread permanently?" });
    expect(dialog).toHaveTextContent('permanently deletes the thread "Active thread"');
    expect(dialog).toHaveTextContent("descendant sessions may also be permanently deleted");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(props.onDelete).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(more).toHaveFocus());

    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(props.onDelete).toHaveBeenCalledWith("thread-active");
  });

  it("uses a 550ms touch hold only to open the menu and suppresses row selection", () => {
    vi.useFakeTimers();
    const props = sidebarProps();
    render(<Sidebar {...props} />);
    const row = screen.getByRole("button", { name: "Active thread" });

    fireEvent.pointerDown(row, {
      pointerId: 7,
      pointerType: "touch",
      button: 0,
      clientX: 24,
      clientY: 42,
    });
    act(() => vi.advanceTimersByTime(549));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));

    expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
    expect(props.onArchive).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.pointerUp(row, { pointerId: 7, pointerType: "touch" });
    fireEvent.click(row);
    expect(props.onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(props.onArchive).toHaveBeenCalledWith("thread-active");
  });

  it("cancels touch holds after clear movement or pointer cancellation", () => {
    vi.useFakeTimers();
    const props = sidebarProps();
    render(<Sidebar {...props} />);
    const row = screen.getByRole("button", { name: "Active thread" });

    fireEvent.pointerDown(row, { pointerId: 8, pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(row, { pointerId: 8, pointerType: "touch", clientX: 26, clientY: 10 });
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(props.onSelect).not.toHaveBeenCalled();

    fireEvent.pointerDown(row, { pointerId: 9, pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(row, { pointerId: 9, pointerType: "touch" });
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("disables both lifecycle actions with an accessible reason for an active thread", () => {
    const props = sidebarProps({ isThreadActive: (threadId) => threadId === "thread-active" });
    render(<Sidebar {...props} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Active thread" }));
    const menu = screen.getByRole("menu", { name: "Actions for Active thread" });
    const archive = screen.getByRole("menuitem", { name: "Archive" });
    const remove = screen.getByRole("menuitem", { name: "Delete" });
    expect(archive).toBeDisabled();
    expect(remove).toBeDisabled();
    expect(menu).toHaveFocus();
    expect(menu).toHaveAccessibleDescription("Finish the active turn before archiving or deleting this thread.");
  });

  it("switches tabs with the keyboard and exposes Unarchive only for archived threads", () => {
    const props = sidebarProps();
    render(<Sidebar {...props} />);
    const activeTab = screen.getByRole("tab", { name: "Active" });
    const archivedTab = screen.getByRole("tab", { name: "Archived" });

    activeTab.focus();
    fireEvent.keyDown(activeTab, { key: "ArrowRight" });
    expect(archivedTab).toHaveAttribute("aria-selected", "true");
    expect(archivedTab).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Active thread" })).not.toBeInTheDocument();
    const archivedRow = screen.getByRole("button", { name: "Archived thread" });
    expect(archivedRow).toBeInTheDocument();

    fireEvent.click(archivedRow);
    expect(props.onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    expect(props.onUnarchive).toHaveBeenCalledWith("thread-archived");
    expect(props.onArchive).not.toHaveBeenCalled();
  });

  it("closes menus and confirmations when a lifecycle update removes their source row", async () => {
    const props = sidebarProps();
    const { rerender } = render(<Sidebar {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "More actions for Active thread" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    rerender(<Sidebar {...props} threads={[]} />);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    rerender(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for Active thread" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    rerender(<Sidebar {...props} threads={[]} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
