import type { CodexItem } from "../types/protocol";
import { readString, textParts } from "../utils/protocol";

const TOOL_ACTIVITY_TYPES = new Set([
  "collabAgentToolCall",
  "commandExecution",
  "contextCompaction",
  "dynamicToolCall",
  "enteredReviewMode",
  "exitedReviewMode",
  "fileChange",
  "hookPrompt",
  "imageGeneration",
  "imageView",
  "mcpToolCall",
  "sleep",
  "subAgentActivity",
  "webSearch",
]);

export function isToolActivityItem(item: CodexItem): boolean {
  return TOOL_ACTIVITY_TYPES.has(item.type);
}

export function hasVisibleReasoning(items: readonly CodexItem[]): boolean {
  return items.some((item) => {
    const summary = textParts(item.summary) || readString(item.summaryText);
    const detail = textParts(item.content) || readString(item.contentText) || readString(item.text);
    const hasOmittedContent = Object.entries(item.streamOmittedCharacters ?? {}).some(([key, value]) => (
      (key === "summary" || key.startsWith("summary[") || key === "content" || key.startsWith("content[")) &&
      Number.isSafeInteger(value) && value > 0
    ));
    return Boolean(summary || detail || hasOmittedContent);
  });
}

export function isFailedToolActivity(item: CodexItem): boolean {
  if (item.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0) {
    return true;
  }
  if (item.type === "dynamicToolCall" && item.success === false) return true;
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
    countLabel(counts.dynamicToolCall ?? 0, "dynamic tool"),
    countLabel(counts.collabAgentToolCall ?? 0, "agent call"),
    countLabel(counts.subAgentActivity ?? 0, "agent update"),
    countLabel(counts.webSearch ?? 0, "search", "searches"),
    countLabel(counts.imageView ?? 0, "image view"),
    countLabel(counts.imageGeneration ?? 0, "image generation"),
    countLabel(counts.sleep ?? 0, "wait"),
    countLabel((counts.enteredReviewMode ?? 0) + (counts.exitedReviewMode ?? 0), "review event"),
    countLabel(counts.contextCompaction ?? 0, "compaction"),
    countLabel(counts.hookPrompt ?? 0, "hook prompt"),
  ].filter((label): label is string => label !== null).join(", ");
}
