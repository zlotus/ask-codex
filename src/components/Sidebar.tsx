import {
  Archive,
  ArchiveRestore,
  KeyRound,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CodexThread, ConnectionState } from "../types/protocol";
import { formatTimestamp, threadRecencyTimestamp } from "../utils/protocol";

export interface SidebarProps {
  threads: CodexThread[];
  archivedThreads: CodexThread[];
  selectedThreadId: string | null;
  search: string;
  open: boolean;
  loading: boolean;
  connection: ConnectionState;
  isThreadActive: (threadId: string) => boolean;
  onSearch: (value: string) => void;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  onClose: () => void;
  onToken: () => void;
  onArchive: (threadId: string) => void;
  onUnarchive: (threadId: string) => void;
  onDelete: (threadId: string) => void;
}

type ThreadView = "active" | "archived";

interface ThreadActionMenuState {
  thread: CodexThread;
  view: ThreadView;
  left: number;
  top: number;
  trigger: HTMLButtonElement | null;
}

interface DeleteThreadState {
  thread: CodexThread;
  view: ThreadView;
  returnFocus: HTMLButtonElement | null;
}

interface LongPressState {
  pointerId: number;
  threadId: string;
  startX: number;
  startY: number;
  timer: ReturnType<typeof setTimeout> | null;
  opened: boolean;
}

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;
const ACTION_MENU_WIDTH = 188;
const ACTION_MENU_HEIGHT = 142;

function threadTitle(thread: CodexThread): string {
  return thread.name?.trim() || thread.preview?.trim() || "Untitled thread";
}

function threadStatus(thread: CodexThread): string {
  if (typeof thread.status === "string") return thread.status;
  if (thread.status && typeof thread.status.type === "string") return thread.status.type;
  return "idle";
}

function menuPosition(clientX: number, clientY: number) {
  const maxLeft = Math.max(8, window.innerWidth - ACTION_MENU_WIDTH - 8);
  const maxTop = Math.max(8, window.innerHeight - ACTION_MENU_HEIGHT - 8);
  return {
    left: Math.max(8, Math.min(clientX, maxLeft)),
    top: Math.max(8, Math.min(clientY, maxTop)),
  };
}

function restoreFocus(element: HTMLButtonElement | null) {
  if (element?.isConnected) element.focus();
}

export function Sidebar(props: SidebarProps) {
  const [view, setView] = useState<ThreadView>("active");
  const [actionMenu, setActionMenu] = useState<ThreadActionMenuState | null>(null);
  const [deleteThread, setDeleteThread] = useState<DeleteThreadState | null>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const archivedTabRef = useRef<HTMLButtonElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const deleteDialogRef = useRef<HTMLFormElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const longPressRef = useRef<LongPressState | null>(null);
  const suppressedSelectionRef = useRef<string | null>(null);
  const suppressionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTabId = useId();
  const archivedTabId = useId();
  const activePanelId = useId();
  const archivedPanelId = useId();
  const actionMenuId = useId();
  const activeActionReasonId = useId();
  const deleteTitleId = useId();
  const deleteDescriptionId = useId();

  const normalizedSearch = props.search.trim().toLowerCase();
  const viewThreads = view === "active" ? props.threads : props.archivedThreads;
  const visibleThreads = normalizedSearch
    ? viewThreads.filter((thread) => `${threadTitle(thread)} ${thread.cwd ?? ""}`.toLowerCase().includes(normalizedSearch))
    : viewThreads;

  function clearLongPress() {
    if (longPressRef.current?.timer) clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  }

  function suppressNextSelection(threadId: string) {
    suppressedSelectionRef.current = threadId;
    if (suppressionTimerRef.current) clearTimeout(suppressionTimerRef.current);
    suppressionTimerRef.current = setTimeout(() => {
      if (suppressedSelectionRef.current === threadId) suppressedSelectionRef.current = null;
      suppressionTimerRef.current = null;
    }, 800);
  }

  function openActionMenu(
    thread: CodexThread,
    menuView: ThreadView,
    clientX: number,
    clientY: number,
    trigger: HTMLButtonElement | null,
  ) {
    setDeleteThread(null);
    setActionMenu({ thread, view: menuView, ...menuPosition(clientX, clientY), trigger });
  }

  function closeDeleteDialog(returnFocus = true) {
    const trigger = deleteThread?.returnFocus ?? null;
    setDeleteThread(null);
    if (returnFocus) restoreFocus(trigger);
  }

  useEffect(() => {
    return () => {
      if (longPressRef.current?.timer) clearTimeout(longPressRef.current.timer);
      if (suppressionTimerRef.current) clearTimeout(suppressionTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!actionMenu) return;
    const firstEnabled = actionMenuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)");
    (firstEnabled ?? actionMenuRef.current)?.focus();

    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (actionMenuRef.current?.contains(target) || actionMenu.trigger?.contains(target)) return;
      setActionMenu(null);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setActionMenu(null);
      restoreFocus(actionMenu.trigger);
    };
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [actionMenu]);

  useEffect(() => {
    if (!deleteThread) return;
    deleteCancelRef.current?.focus();

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setDeleteThread(null);
      restoreFocus(deleteThread.returnFocus);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [deleteThread]);

  useEffect(() => {
    const staleMenu = actionMenu && !(actionMenu.view === "active" ? props.threads : props.archivedThreads)
      .some((thread) => thread.id === actionMenu.thread.id)
      ? { threadId: actionMenu.thread.id, view: actionMenu.view }
      : null;
    const staleDelete = deleteThread && !(deleteThread.view === "active" ? props.threads : props.archivedThreads)
      .some((thread) => thread.id === deleteThread.thread.id)
      ? { threadId: deleteThread.thread.id, view: deleteThread.view }
      : null;
    if (!staleMenu && !staleDelete) return;

    const timer = setTimeout(() => {
      if (staleMenu) {
        setActionMenu((current) => (
          current?.thread.id === staleMenu.threadId && current?.view === staleMenu.view ? null : current
        ));
      }
      if (staleDelete) {
        setDeleteThread((current) => (
          current?.thread.id === staleDelete.threadId && current?.view === staleDelete.view ? null : current
        ));
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [actionMenu, deleteThread, props.archivedThreads, props.threads]);

  function switchView(nextView: ThreadView, focusTab = false) {
    clearLongPress();
    setActionMenu(null);
    setView(nextView);
    if (focusTab) {
      (nextView === "active" ? activeTabRef.current : archivedTabRef.current)?.focus();
    }
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    let nextView: ThreadView | null = null;
    if (event.key === "ArrowLeft" || event.key === "Home") nextView = "active";
    if (event.key === "ArrowRight" || event.key === "End") nextView = "archived";
    if (!nextView) return;
    event.preventDefault();
    switchView(nextView, true);
  }

  function handleContextMenu(
    event: React.MouseEvent<HTMLDivElement>,
    thread: CodexThread,
    menuView: ThreadView,
  ) {
    event.preventDefault();
    const pendingPress = longPressRef.current;
    if (pendingPress?.threadId === thread.id) {
      suppressNextSelection(thread.id);
      clearLongPress();
    }
    const rowButton = event.currentTarget.querySelector<HTMLButtonElement>(".thread-row");
    const rect = event.currentTarget.getBoundingClientRect();
    openActionMenu(
      thread,
      menuView,
      event.clientX || rect.left + 12,
      event.clientY || rect.top + 12,
      rowButton,
    );
  }

  function handleLongPressStart(
    event: ReactPointerEvent<HTMLButtonElement>,
    thread: CodexThread,
    menuView: ThreadView,
  ) {
    if (event.pointerType === "mouse" || event.button !== 0) return;
    clearLongPress();
    const rowButton = event.currentTarget;
    const press: LongPressState = {
      pointerId: event.pointerId,
      threadId: thread.id,
      startX: event.clientX,
      startY: event.clientY,
      timer: null,
      opened: false,
    };
    press.timer = setTimeout(() => {
      if (longPressRef.current !== press) return;
      press.timer = null;
      press.opened = true;
      suppressNextSelection(thread.id);
      const rect = rowButton.getBoundingClientRect();
      openActionMenu(
        thread,
        menuView,
        press.startX || rect.right - 18,
        press.startY || rect.top + 18,
        rowButton,
      );
    }, LONG_PRESS_MS);
    longPressRef.current = press;
  }

  function handleLongPressMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const press = longPressRef.current;
    if (!press || press.pointerId !== event.pointerId || press.opened) return;
    if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) <= LONG_PRESS_MOVE_PX) return;
    suppressNextSelection(press.threadId);
    clearLongPress();
  }

  function handleLongPressEnd(event: ReactPointerEvent<HTMLButtonElement>) {
    const press = longPressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    const opened = press.opened;
    clearLongPress();
    if (opened) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function handleLongPressCancel(event: ReactPointerEvent<HTMLButtonElement>) {
    const press = longPressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    suppressNextSelection(press.threadId);
    clearLongPress();
  }

  function handleThreadSelect(
    event: React.MouseEvent<HTMLButtonElement>,
    thread: CodexThread,
    rowView: ThreadView,
  ) {
    if (suppressedSelectionRef.current === thread.id) {
      suppressedSelectionRef.current = null;
      if (suppressionTimerRef.current) clearTimeout(suppressionTimerRef.current);
      suppressionTimerRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (rowView === "archived") {
      const rect = event.currentTarget.getBoundingClientRect();
      openActionMenu(thread, rowView, rect.right - ACTION_MENU_WIDTH, rect.top + 8, event.currentTarget);
      return;
    }
    props.onSelect(thread.id);
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(actionMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
    items[nextIndex]?.focus();
  }

  function handleDeleteDialogKeyDown(event: React.KeyboardEvent<HTMLFormElement>) {
    if (event.key !== "Tab") return;
    const focusable = Array.from(deleteDialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  const menuThreadActive = actionMenu ? props.isThreadActive(actionMenu.thread.id) : false;
  const lifecycleAction = actionMenu?.view === "archived" ? "Unarchive" : "Archive";
  const LifecycleIcon = actionMenu?.view === "archived" ? ArchiveRestore : Archive;
  const panelId = view === "active" ? activePanelId : archivedPanelId;
  const labelledBy = view === "active" ? activeTabId : archivedTabId;

  return (
    <>
      {props.open && <button className="sidebar-scrim" type="button" aria-label="Close threads" onClick={props.onClose} />}
      <aside className={`sidebar ${props.open ? "sidebar--open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">A</div>
          <div><strong>Ask Codex</strong><span>Codex workspace</span></div>
          <button className="icon-button sidebar-close" type="button" title="Close threads" aria-label="Close threads" onClick={props.onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <button type="button" className="new-thread-button" onClick={props.onNew}>
          <MessageSquarePlus size={17} aria-hidden="true" />
          New thread
        </button>
        <div className="thread-tools">
          <label className="search-box">
            <Search size={15} aria-hidden="true" />
            <input
              value={props.search}
              onChange={(event) => props.onSearch(event.target.value)}
              placeholder="Search threads"
              aria-label="Search threads"
            />
          </label>
          <button className="icon-button icon-button--dark" type="button" title="Refresh threads" aria-label="Refresh threads" onClick={props.onRefresh} disabled={props.loading}>
            <RefreshCw size={16} className={props.loading ? "spin" : undefined} aria-hidden="true" />
          </button>
        </div>
        <div className="thread-tabs" role="tablist" aria-label="Thread views">
          <button
            ref={activeTabRef}
            id={activeTabId}
            className={`thread-tab ${view === "active" ? "thread-tab--selected" : ""}`}
            type="button"
            role="tab"
            aria-selected={view === "active"}
            aria-controls={activePanelId}
            tabIndex={view === "active" ? 0 : -1}
            onClick={() => switchView("active")}
            onKeyDown={handleTabKeyDown}
          >
            Active
            <span aria-hidden="true">{props.threads.length}</span>
          </button>
          <button
            ref={archivedTabRef}
            id={archivedTabId}
            className={`thread-tab ${view === "archived" ? "thread-tab--selected" : ""}`}
            type="button"
            role="tab"
            aria-selected={view === "archived"}
            aria-controls={archivedPanelId}
            tabIndex={view === "archived" ? 0 : -1}
            onClick={() => switchView("archived")}
            onKeyDown={handleTabKeyDown}
          >
            Archived
            <span aria-hidden="true">{props.archivedThreads.length}</span>
          </button>
        </div>
        <nav
          id={panelId}
          className="thread-list"
          role="tabpanel"
          aria-labelledby={labelledBy}
          aria-label={`${view === "active" ? "Active" : "Archived"} threads`}
        >
          {visibleThreads.map((thread) => {
            const title = threadTitle(thread);
            const menuOpen = actionMenu?.thread.id === thread.id && actionMenu.view === view;
            return (
              <div
                className="thread-row-shell"
                key={thread.id}
                onContextMenu={(event) => handleContextMenu(event, thread, view)}
              >
                <button
                  type="button"
                  className={`thread-row ${thread.id === props.selectedThreadId ? "thread-row--selected" : ""}`}
                  aria-label={title}
                  aria-current={thread.id === props.selectedThreadId ? "page" : undefined}
                  aria-haspopup={view === "archived" ? "menu" : undefined}
                  aria-expanded={view === "archived" ? menuOpen : undefined}
                  aria-controls={view === "archived" && menuOpen ? actionMenuId : undefined}
                  onClick={(event) => handleThreadSelect(event, thread, view)}
                  onPointerDown={(event) => handleLongPressStart(event, thread, view)}
                  onPointerMove={handleLongPressMove}
                  onPointerUp={handleLongPressEnd}
                  onPointerCancel={handleLongPressCancel}
                >
                  <span className="thread-title">{title}</span>
                  <span className="thread-meta" aria-hidden="true">
                    <span className={`thread-dot thread-dot--${threadStatus(thread).toLowerCase()}`} />
                    {formatTimestamp(threadRecencyTimestamp(thread)) || thread.id.slice(0, 8)}
                  </span>
                </button>
                <button
                  className="thread-more-button"
                  type="button"
                  title={`More actions for ${title}`}
                  aria-label={`More actions for ${title}`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-controls={menuOpen ? actionMenuId : undefined}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    openActionMenu(thread, view, rect.right - ACTION_MENU_WIDTH, rect.bottom + 4, event.currentTarget);
                  }}
                >
                  <MoreHorizontal size={16} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {visibleThreads.length === 0 && (
            <p className="thread-empty">No {view === "active" ? "active" : "archived"} threads found</p>
          )}
        </nav>
        <div className="sidebar-footer">
          <span className={`connection-dot connection-dot--${props.connection}`} />
          <span>{props.connection}</span>
          <button className="icon-button icon-button--dark token-button" type="button" title="Connection token" aria-label="Connection token" onClick={props.onToken}>
            <KeyRound size={15} aria-hidden="true" />
          </button>
        </div>
      </aside>

      {actionMenu && (
        <div
          ref={actionMenuRef}
          id={actionMenuId}
          className="thread-action-menu"
          role="menu"
          tabIndex={-1}
          aria-label={`Actions for ${threadTitle(actionMenu.thread)}`}
          aria-describedby={menuThreadActive ? activeActionReasonId : undefined}
          style={{ left: actionMenu.left, top: actionMenu.top }}
          onKeyDown={handleMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            disabled={menuThreadActive}
            aria-describedby={menuThreadActive ? activeActionReasonId : undefined}
            onClick={() => {
              if (menuThreadActive) return;
              const threadId = actionMenu.thread.id;
              const menuView = actionMenu.view;
              setActionMenu(null);
              if (menuView === "archived") props.onUnarchive(threadId);
              else props.onArchive(threadId);
            }}
          >
            <LifecycleIcon size={15} aria-hidden="true" />
            {lifecycleAction}
          </button>
          <button
            className="thread-action-menu__danger"
            type="button"
            role="menuitem"
            disabled={menuThreadActive}
            aria-describedby={menuThreadActive ? activeActionReasonId : undefined}
            onClick={() => {
              if (menuThreadActive) return;
              setDeleteThread({ thread: actionMenu.thread, view: actionMenu.view, returnFocus: actionMenu.trigger });
              setActionMenu(null);
            }}
          >
            <Trash2 size={15} aria-hidden="true" />
            Delete
          </button>
          {menuThreadActive && (
            <p id={activeActionReasonId} className="thread-action-menu__note">
              Finish the active turn before archiving or deleting this thread.
            </p>
          )}
        </div>
      )}

      {deleteThread && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeDeleteDialog();
          }}
        >
          <form
            ref={deleteDialogRef}
            className="delete-thread-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={deleteTitleId}
            aria-describedby={deleteDescriptionId}
            onKeyDown={handleDeleteDialogKeyDown}
            onSubmit={(event) => {
              event.preventDefault();
              const threadId = deleteThread.thread.id;
              const trigger = deleteThread.returnFocus;
              setDeleteThread(null);
              props.onDelete(threadId);
              restoreFocus(trigger);
            }}
          >
            <div className="dialog-heading">
              <Trash2 size={19} aria-hidden="true" />
              <div>
                <strong id={deleteTitleId}>Delete thread permanently?</strong>
                <span>Destructive action</span>
              </div>
              <button className="icon-button" type="button" title="Close" aria-label="Close" onClick={() => closeDeleteDialog()}>
                <X size={17} aria-hidden="true" />
              </button>
            </div>
            <p id={deleteDescriptionId} className="delete-thread-dialog__description">
              This permanently deletes the thread "{threadTitle(deleteThread.thread)}"; descendant sessions may also be permanently deleted. This action cannot be undone.
            </p>
            <div className="dialog-actions">
              <button ref={deleteCancelRef} className="button button--quiet" type="button" onClick={() => closeDeleteDialog()}>
                Cancel
              </button>
              <button className="button button--danger" type="submit">
                <Trash2 size={14} aria-hidden="true" />
                Delete permanently
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

export function MobileMenuButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="icon-button mobile-menu-button" type="button" title="Open threads" aria-label="Open threads" onClick={onClick}>
      <Menu size={19} aria-hidden="true" />
    </button>
  );
}
