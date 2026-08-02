import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function sidebarProps(overrides: Partial<ComponentProps<typeof Sidebar>> = {}): ComponentProps<typeof Sidebar> {
  return {
    threads: [activeThread],
    archivedThreads: [archivedThread],
    selectedThreadId: null,
    search: "",
    open: true,
    loading: false,
    connection: "connected" as const,
    recentActivities: [],
    pendingRequests: [],
    skills: [],
    skillsLoading: false,
    skillsLoaded: false,
    skillsError: null,
    skillsTruncated: false,
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
    onRename: vi.fn(),
    onPin: vi.fn(),
    onSkillsView: vi.fn(),
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
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
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
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
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

    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
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
    const rename = screen.getByRole("menuitem", { name: "Rename" });
    const pin = screen.getByRole("menuitem", { name: "Pin" });
    const archive = screen.getByRole("menuitem", { name: "Archive" });
    const remove = screen.getByRole("menuitem", { name: "Delete" });
    expect(rename).toBeEnabled();
    expect(pin).toBeEnabled();
    expect(archive).toBeDisabled();
    expect(remove).toBeDisabled();
    expect(rename).toHaveFocus();
    expect(menu).toHaveAccessibleDescription("Finish the active turn before archiving or deleting this thread.");
  });

  it("groups threads by cwd and puts pinned threads first without reordering each tier", () => {
    const props = sidebarProps({
      threads: [
        { id: "alpha-unpinned-1", name: "Alpha recent", cwd: "/workspace/alpha" },
        { id: "beta-unpinned", name: "Beta", cwd: "/workspace/beta" },
        { id: "alpha-pinned-1", name: "Alpha pinned first", cwd: "/workspace/alpha", isPinned: true },
        { id: "alpha-pinned-2", name: "Alpha pinned second", cwd: "/workspace/alpha", isPinned: true },
        { id: "alpha-unpinned-2", name: "Alpha older", cwd: "/workspace/alpha" },
      ],
    });
    const { container } = render(<Sidebar {...props} />);

    const groups = [...container.querySelectorAll<HTMLElement>(".thread-group")];
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAttribute("open");
    expect(within(groups[0]).getByText("alpha")).toBeInTheDocument();
    expect(within(groups[0]).getByText("/workspace/alpha")).toBeInTheDocument();
    expect(within(groups[0]).getByLabelText("4 threads")).toHaveTextContent("4");
    expect(within(groups[1]).getByText("beta")).toBeInTheDocument();
    expect([...groups[0].querySelectorAll(".thread-title")].map((node) => node.textContent)).toEqual([
      "Alpha pinned first",
      "Alpha pinned second",
      "Alpha recent",
      "Alpha older",
    ]);
    expect(within(groups[0]).getByRole("button", { name: "Alpha pinned first" }))
      .toHaveAccessibleDescription("Pinned");
    expect(within(groups[0]).getByRole("button", { name: "Alpha recent" }))
      .not.toHaveAccessibleDescription();
    fireEvent.click(groups[0].querySelector("summary") as HTMLElement);
    expect(groups[0]).not.toHaveAttribute("open");
  });

  it("allows an active thread to be renamed and pinned while lifecycle actions stay disabled", async () => {
    const props = sidebarProps({ isThreadActive: (threadId) => threadId === "thread-active" });
    const { rerender } = render(<Sidebar {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "More actions for Active thread" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const dialog = screen.getByRole("dialog", { name: "Rename thread" });
    const input = within(dialog).getByRole("textbox", { name: "Thread name" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("maxlength", "200");
    fireEvent.change(input, { target: { value: "  Focused work  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(props.onRename).toHaveBeenCalledWith("thread-active", "Focused work");

    const more = screen.getByRole("button", { name: "More actions for Active thread" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(props.onPin).toHaveBeenCalledWith("thread-active", true);
    expect(more).toHaveFocus();

    rerender(<Sidebar {...props} threads={[{ ...activeThread, isPinned: true }]} />);
    const pinnedRow = screen.getByRole("button", { name: "Active thread" });
    expect(pinnedRow).toHaveAccessibleName("Active thread");
    expect(pinnedRow).toHaveAccessibleDescription("Pinned");
    const pinnedMore = screen.getByRole("button", { name: "More actions for Active thread" });
    fireEvent.click(pinnedMore);
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(props.onPin).toHaveBeenLastCalledWith("thread-active", false);
    expect(pinnedMore).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
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

    fireEvent.keyDown(archivedTab, { key: "ArrowRight" });
    const activityTab = screen.getByRole("tab", { name: "Activity" });
    expect(activityTab).toHaveAttribute("aria-selected", "true");
    expect(activityTab).toHaveFocus();

    fireEvent.keyDown(activityTab, { key: "ArrowRight" });
    const skillsTab = screen.getByRole("tab", { name: "Skills" });
    expect(skillsTab).toHaveAttribute("aria-selected", "true");
    expect(skillsTab).toHaveFocus();
    expect(props.onSkillsView).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(skillsTab, { key: "ArrowRight" });
    expect(activeTab).toHaveAttribute("aria-selected", "true");
    expect(activeTab).toHaveFocus();
  });

  it("opens a read-only Skills directory with loading, errors, scopes, and enabled state", () => {
    const props = sidebarProps();
    const { rerender } = render(<Sidebar {...props} />);

    const skillsTab = screen.getByRole("tab", { name: "Skills" });
    fireEvent.click(skillsTab);
    expect(props.onSkillsView).toHaveBeenCalledTimes(1);
    fireEvent.click(skillsTab);
    expect(props.onSkillsView).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Skills have not been loaded")).toBeInTheDocument();

    rerender(<Sidebar {...props} skillsLoading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading skills");

    rerender(<Sidebar
      {...props}
      skillsLoaded
      skills={[{
        cwd: "/workspace/active",
        errorCount: 1,
        skills: [
          {
            name: "repo-audit",
            description: "Inspect repository architecture and tests.",
            shortDescription: "Inspect repository architecture.",
            scope: "repo",
            enabled: true,
          },
          {
            name: "legacy-helper",
            description: "A disabled user-level helper.",
            scope: "user",
            enabled: false,
          },
        ],
      }]}
    />);
    const workspace = screen.getByLabelText("Project active");
    expect(within(workspace).getByText("active")).toBeInTheDocument();
    expect(within(workspace).getByText("/workspace/active")).toBeInTheDocument();
    expect(within(workspace).getByLabelText("2 skills")).toHaveTextContent("2");
    expect(within(workspace).getByText("repo-audit")).toBeInTheDocument();
    expect(within(workspace).getByText("Inspect repository architecture.")).toHaveAttribute(
      "title",
      "Inspect repository architecture and tests.",
    );
    expect(within(workspace).getByText("repo")).toBeInTheDocument();
    expect(within(workspace).getByText("Enabled")).toBeInTheDocument();
    expect(within(workspace).getByText("Disabled")).toBeInTheDocument();
    expect(within(workspace).getByRole("status")).toHaveTextContent("1 skill could not be loaded");
    fireEvent.click(screen.getByRole("tab", { name: "Active" }));
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(props.onSkillsView).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh skills" }));
    expect(props.onRefresh).toHaveBeenCalledWith("skills");

    rerender(<Sidebar
      {...props}
      skillsLoaded
      skillsError="Skills could not be loaded"
    />);
    expect(screen.getByRole("status")).toHaveTextContent("Skills could not be loaded");
    expect(screen.queryByText("No skills found")).not.toBeInTheDocument();

    rerender(<Sidebar
      {...props}
      skillsLoaded
      skillsTruncated
    />);
    expect(screen.getByRole("status")).toHaveTextContent("Showing the 16 most relevant projects");
    expect(screen.queryByText("No skills found")).not.toBeInTheDocument();

    rerender(<Sidebar
      {...props}
      search="repo"
      skillsLoaded
      skills={[{
        cwd: "/workspace/active",
        errorCount: 0,
        skills: [
          { name: "repo-audit", description: "Inspect architecture.", scope: "repo", enabled: true },
          { name: "other", description: "Unrelated helper.", scope: "user", enabled: true },
        ],
      }]}
    />);
    expect(screen.getByRole("textbox", { name: "Search skills" })).toHaveValue("repo");
    expect(screen.getByText("repo-audit")).toBeInTheDocument();
    expect(screen.queryByText("other")).not.toBeInTheDocument();
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

    rerender(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions for Active thread" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(screen.getByRole("dialog", { name: "Rename thread" })).toBeInTheDocument();
    rerender(<Sidebar {...props} threads={[]} />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename thread" })).not.toBeInTheDocument());
  });
});
