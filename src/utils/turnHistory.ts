import type { CodexItemsPage, CodexTurnsPage } from "../types/protocol";
import { errorMessage, normalizeItemsPage, normalizeTurnsPage } from "./protocol";

export type RpcClient = (method: string, params?: unknown) => Promise<unknown>;

interface TurnPageRequest {
  threadId: string;
  cursor?: string;
  preferredLimit: number;
}

interface FullTurnPageRequest {
  threadId: string;
  cursor?: string;
}

interface TurnItemPageRequest {
  threadId: string;
  turnId: string;
  cursor?: string;
  preferredLimit: number;
}

export function isOversizedHistoryResponseError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("gateway message limit") ||
    (message.includes("codex app-server stdout jsonl line exceeded") &&
      message.includes("byte limit"));
}

export class TurnDetailUnavailableError extends Error {
  override name = "TurnDetailUnavailableError";
}

export function isThreadItemPaginationUnsupported(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("thread/items/list") &&
    (message.includes("not supported") || message.includes("method not found"));
}

export async function resumeThreadForHistory(
  rpc: RpcClient,
  threadId: string,
  initialLimit: number,
): Promise<unknown> {
  try {
    return await rpc("thread/resume", {
      threadId,
      excludeTurns: true,
      initialTurnsPage: {
        limit: Math.max(1, initialLimit),
        sortDirection: "desc",
        itemsView: "full",
      },
    });
  } catch (error) {
    if (!isOversizedHistoryResponseError(error)) throw error;
    return rpc("thread/resume", { threadId, excludeTurns: true });
  }
}

export async function requestTurnPage(
  rpc: RpcClient,
  { threadId, cursor, preferredLimit }: TurnPageRequest,
): Promise<CodexTurnsPage> {
  const limits = [...new Set([
    Math.max(1, preferredLimit),
    Math.max(1, Math.floor(preferredLimit / 2)),
    1,
  ])];
  let limitError: unknown;

  for (const limit of limits) {
    try {
      const page = normalizeTurnsPage(await rpc("thread/turns/list", {
        threadId,
        ...(cursor !== undefined ? { cursor } : {}),
        limit,
        sortDirection: "desc",
        itemsView: "full",
      }));
      if (!page) throw new Error("Codex returned an invalid turn page");
      return page;
    } catch (error) {
      if (!isOversizedHistoryResponseError(error)) throw error;
      limitError = error;
    }
  }

  try {
    const page = normalizeTurnsPage(await rpc("thread/turns/list", {
      threadId,
      ...(cursor !== undefined ? { cursor } : {}),
      limit: 1,
      sortDirection: "desc",
      itemsView: "summary",
    }));
    if (!page) throw new Error("Codex returned an invalid turn summary page");
    return page;
  } catch (error) {
    if (isOversizedHistoryResponseError(error) && limitError) throw limitError;
    throw error;
  }
}

export async function requestFullTurnPage(
  rpc: RpcClient,
  { threadId, cursor }: FullTurnPageRequest,
): Promise<CodexTurnsPage> {
  const page = normalizeTurnsPage(await rpc("thread/turns/list", {
    threadId,
    ...(cursor !== undefined ? { cursor } : {}),
    limit: 1,
    sortDirection: "desc",
    itemsView: "full",
  }));
  if (!page) throw new Error("Codex returned an invalid full turn page");
  return page;
}

export async function requestTurnItemPage(
  rpc: RpcClient,
  { threadId, turnId, cursor, preferredLimit }: TurnItemPageRequest,
): Promise<CodexItemsPage> {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(preferredLimit)));
  const limits = [...new Set([
    boundedLimit,
    Math.max(1, Math.floor(boundedLimit / 2)),
    1,
  ])];
  let limitError: unknown;

  for (const limit of limits) {
    try {
      const page = normalizeItemsPage(await rpc("thread/items/list", {
        threadId,
        turnId,
        ...(cursor !== undefined ? { cursor } : {}),
        limit,
        sortDirection: "asc",
      }));
      if (!page) throw new Error("Codex returned an invalid item page");
      if (page.data.some((entry) => entry.turnId !== turnId)) {
        throw new Error("Codex returned an item for a different turn");
      }
      if (cursor !== undefined && page.nextCursor === cursor) {
        throw new Error("Codex returned a non-advancing item cursor");
      }
      return page;
    } catch (error) {
      if (!isOversizedHistoryResponseError(error)) throw error;
      limitError = error;
    }
  }

  if (limitError) {
    throw new TurnDetailUnavailableError(
      "A single Codex item still exceeds Ask Codex transport limits",
      { cause: limitError },
    );
  }
  throw new Error("Codex item page exceeded the gateway message limit");
}
