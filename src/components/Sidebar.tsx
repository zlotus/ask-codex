import { KeyRound, Menu, MessageSquarePlus, RefreshCw, Search, X } from "lucide-react";
import type { CodexThread, ConnectionState } from "../types/protocol";
import { formatTimestamp } from "../utils/protocol";

interface SidebarProps {
  threads: CodexThread[];
  selectedThreadId: string | null;
  search: string;
  open: boolean;
  loading: boolean;
  connection: ConnectionState;
  onSearch: (value: string) => void;
  onSelect: (threadId: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  onClose: () => void;
  onToken: () => void;
}

function threadTitle(thread: CodexThread): string {
  return thread.name?.trim() || thread.preview?.trim() || "Untitled thread";
}

function threadStatus(thread: CodexThread): string {
  if (typeof thread.status === "string") return thread.status;
  if (thread.status && typeof thread.status.type === "string") return thread.status.type;
  return "idle";
}

export function Sidebar(props: SidebarProps) {
  const normalizedSearch = props.search.trim().toLowerCase();
  const visibleThreads = normalizedSearch
    ? props.threads.filter((thread) => `${threadTitle(thread)} ${thread.cwd ?? ""}`.toLowerCase().includes(normalizedSearch))
    : props.threads;
  return (
    <>
      {props.open && <button className="sidebar-scrim" type="button" aria-label="Close threads" onClick={props.onClose} />}
      <aside className={`sidebar ${props.open ? "sidebar--open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">A</div>
          <div><strong>Ask Agent</strong><span>Codex workspace</span></div>
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
        <nav className="thread-list" aria-label="Threads">
          {visibleThreads.map((thread) => (
            <button
              type="button"
              key={thread.id}
              className={`thread-row ${thread.id === props.selectedThreadId ? "thread-row--selected" : ""}`}
              onClick={() => props.onSelect(thread.id)}
            >
              <span className="thread-title">{threadTitle(thread)}</span>
              <span className="thread-meta">
                <span className={`thread-dot thread-dot--${threadStatus(thread).toLowerCase()}`} />
                {formatTimestamp(thread.updatedAt ?? thread.createdAt) || thread.id.slice(0, 8)}
              </span>
            </button>
          ))}
          {visibleThreads.length === 0 && <p className="thread-empty">No threads found</p>}
        </nav>
        <div className="sidebar-footer">
          <span className={`connection-dot connection-dot--${props.connection}`} />
          <span>{props.connection}</span>
          <button className="icon-button icon-button--dark token-button" type="button" title="Connection token" aria-label="Connection token" onClick={props.onToken}>
            <KeyRound size={15} aria-hidden="true" />
          </button>
        </div>
      </aside>
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
