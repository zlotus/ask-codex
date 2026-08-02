import {
  Activity,
  CircleCheck,
  CircleStop,
  Clock3,
  MessageCircleQuestion,
  ShieldQuestion,
  TriangleAlert,
} from "lucide-react";
import type {
  ActivityKind,
  CodexThread,
  PendingRequest,
  ThreadActivityEvent,
} from "../types/protocol";
import { buildActivityEntries, threadTitle } from "./activityDirectoryModel";

interface ActivityDirectoryProps {
  threads: CodexThread[];
  recentEvents: ThreadActivityEvent[];
  pendingRequests: PendingRequest[];
  selectedThreadId: string | null;
  search: string;
  onSelect: (threadId: string) => void;
}

function workspaceName(cwd: string | undefined): string {
  const normalized = cwd?.replace(/[\\/]+$/, "") ?? "";
  const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return normalized.slice(separator + 1) || normalized || "Unknown project";
}

function activityLabel(kind: ActivityKind): string {
  switch (kind) {
    case "waitingApproval": return "Approval needed";
    case "waitingInput": return "Input needed";
    case "running": return "Running";
    case "systemError": return "System error";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
    case "completed": return "Completed";
    case "updated": return "Updated";
  }
}

function ActivityIcon({ kind }: { kind: ActivityKind }) {
  const props = { size: 14, "aria-hidden": true } as const;
  switch (kind) {
    case "waitingApproval": return <ShieldQuestion {...props} />;
    case "waitingInput": return <MessageCircleQuestion {...props} />;
    case "running": return <Activity {...props} />;
    case "systemError":
    case "failed": return <TriangleAlert {...props} />;
    case "interrupted": return <CircleStop {...props} />;
    case "completed": return <CircleCheck {...props} />;
    case "updated": return <Clock3 {...props} />;
  }
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return "Time unavailable";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

function durationLabel(durationMs: number | undefined): string | null {
  if (durationMs === undefined) return null;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
}

function sectionFor(kind: ActivityKind): "attention" | "running" | "recent" {
  if (kind === "waitingApproval" || kind === "waitingInput" || kind === "systemError") return "attention";
  return kind === "running" ? "running" : "recent";
}

export function ActivityDirectory({
  threads,
  recentEvents,
  pendingRequests,
  selectedThreadId,
  search,
  onSelect,
}: ActivityDirectoryProps) {
  const normalizedSearch = search.trim().toLowerCase();
  const entries = buildActivityEntries(threads, recentEvents, pendingRequests).filter((entry) => {
    if (!normalizedSearch) return true;
    return `${threadTitle(entry.thread)} ${entry.thread.cwd ?? ""} ${activityLabel(entry.kind)}`
      .toLowerCase()
      .includes(normalizedSearch);
  });
  const sections = [
    { id: "attention" as const, label: "Needs attention" },
    { id: "running" as const, label: "Running now" },
    { id: "recent" as const, label: "Recent" },
  ];

  return (
    <div className="activity-directory" aria-label="Thread activity">
      {sections.map((section) => {
        const sectionEntries = entries.filter((entry) => sectionFor(entry.kind) === section.id);
        if (sectionEntries.length === 0) return null;
        return (
          <section className="activity-section" aria-labelledby={`activity-${section.id}`} key={section.id}>
            <h2 id={`activity-${section.id}`}>{section.label}<span>{sectionEntries.length}</span></h2>
            <div className="activity-directory-list">
              {sectionEntries.map((entry) => {
                const duration = durationLabel(entry.durationMs);
                return (
                  <button
                    className={`activity-entry activity-entry--${entry.kind}${entry.thread.id === selectedThreadId ? " activity-entry--selected" : ""}`}
                    type="button"
                    key={entry.thread.id}
                    onClick={() => onSelect(entry.thread.id)}
                  >
                    <span className="activity-entry-icon"><ActivityIcon kind={entry.kind} /></span>
                    <span className="activity-entry-copy">
                      <strong>{threadTitle(entry.thread)}</strong>
                      <span>{workspaceName(entry.thread.cwd)}</span>
                    </span>
                    <span className="activity-entry-state">
                      <strong>{activityLabel(entry.kind)}</strong>
                      <span>{duration ?? relativeTime(entry.occurredAt)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
      {entries.length === 0 && <p className="activity-directory-empty">No activity found</p>}
    </div>
  );
}
