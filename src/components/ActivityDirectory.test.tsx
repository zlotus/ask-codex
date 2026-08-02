import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityDirectory } from "./ActivityDirectory";
import { buildActivityEntries, monitoredActivityCount } from "./activityDirectoryModel";

const threads = [
  {
    id: "approval",
    name: "Approve deployment",
    cwd: "/workspace/alpha",
    status: { type: "active", activeFlags: ["waitingOnApproval"] },
    recencyAt: 1_800_000_000,
  },
  {
    id: "running",
    name: "Run tests",
    cwd: "/workspace/beta",
    status: { type: "active", activeFlags: [] },
    recencyAt: 1_799_999_900,
  },
  {
    id: "recent",
    name: "Finished work",
    cwd: "/workspace/alpha",
    status: { type: "idle" },
    recencyAt: 1_799_999_800,
  },
];

describe("ActivityDirectory", () => {
  it("organizes attention, live, and recent rows without retaining turn content", () => {
    const entries = buildActivityEntries(threads, [{
      threadId: "recent",
      turnId: "turn-1",
      kind: "completed",
      occurredAt: 1_800_000_100_000,
      durationMs: 3_000,
    }], []);
    expect(entries.map(({ thread, kind }) => [thread.id, kind])).toEqual([
      ["approval", "waitingApproval"],
      ["running", "running"],
      ["recent", "completed"],
    ]);
    expect(monitoredActivityCount(threads, [])).toBe(2);
  });

  it("does not leave a stale running event live after an idle snapshot arrives", () => {
    const entries = buildActivityEntries([threads[2]], [{
      threadId: "recent",
      kind: "running",
      occurredAt: 1_800_000_100_000,
    }], []);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("updated");
  });

  it("bounds the recent directory independently of the live activity count", () => {
    const recentThreads = Array.from({ length: 14 }, (_, index) => ({
      id: `recent-${index}`,
      name: `Recent ${index}`,
      status: { type: "idle" },
    }));
    const events = recentThreads.map((thread, index) => ({
      threadId: thread.id,
      kind: "completed" as const,
      occurredAt: index,
    }));

    const entries = buildActivityEntries(recentThreads, events, []);
    expect(entries).toHaveLength(12);
    expect(entries.map((entry) => entry.thread.id)).not.toContain("recent-0");
    expect(entries.map((entry) => entry.thread.id)).not.toContain("recent-1");
  });

  it("lets the user jump to a thread and filters activity", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <ActivityDirectory
        threads={threads}
        recentEvents={[]}
        pendingRequests={[]}
        selectedThreadId={null}
        search=""
        onSelect={onSelect}
      />,
    );
    expect(within(screen.getByRole("heading", { name: /Needs attention/ }).parentElement!)
      .getByText("Approve deployment")).toBeInTheDocument();
    expect(screen.getByText("Run tests")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Run tests/ }));
    expect(onSelect).toHaveBeenCalledWith("running");

    rerender(
      <ActivityDirectory
        threads={threads}
        recentEvents={[]}
        pendingRequests={[]}
        selectedThreadId={null}
        search="deployment"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("Approve deployment")).toBeInTheDocument();
    expect(screen.queryByText("Run tests")).not.toBeInTheDocument();
  });
});
