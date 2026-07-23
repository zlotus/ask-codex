import type { CodexItem } from "../types/protocol";

const TOOL_ACTIVITY_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
]);

export function isToolActivityItem(item: CodexItem): boolean {
  return TOOL_ACTIVITY_TYPES.has(item.type);
}

export function isFailedToolActivity(item: CodexItem): boolean {
  if (item.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0) {
    return true;
  }
  const status = item.status?.toLowerCase() ?? "";
  return status.includes("fail") || status.includes("error") || status === "declined";
}

export function isRunningToolActivity(item: CodexItem): boolean {
  const status = item.status?.toLowerCase() ?? "";
  return status.includes("progress") || status === "running" || status === "started";
}

export function displayToolStatus(item: CodexItem): string | undefined {
  if (isFailedToolActivity(item)) {
    return typeof item.exitCode === "number" ? `failed (exit ${item.exitCode})` : "failed";
  }
  const status = item.status?.toLowerCase();
  if (status === "completed" || status === "success" || status === "succeeded") return undefined;
  return item.status;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string | null {
  return count > 0 ? `${count} ${count === 1 ? singular : plural}` : null;
}

export function summarizeToolActivities(items: readonly CodexItem[]): string {
  const counts = items.reduce((current, item) => {
    current[item.type] = (current[item.type] ?? 0) + 1;
    return current;
  }, {} as Record<string, number>);

  return [
    countLabel(counts.commandExecution ?? 0, "command"),
    countLabel(counts.fileChange ?? 0, "file change"),
    countLabel(counts.mcpToolCall ?? 0, "MCP call"),
    countLabel(counts.webSearch ?? 0, "search", "searches"),
  ].filter((label): label is string => label !== null).join(", ");
}
