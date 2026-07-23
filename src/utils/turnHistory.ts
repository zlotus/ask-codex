import type { CodexTurnsPage } from "../types/protocol";
import { errorMessage, normalizeTurnsPage } from "./protocol";

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

export function isGatewayMessageLimitError(error: unknown): boolean {
  return errorMessage(error).includes("gateway message limit");
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
    if (!isGatewayMessageLimitError(error)) throw error;
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
      if (!isGatewayMessageLimitError(error)) throw error;
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
    if (isGatewayMessageLimitError(error) && limitError) throw limitError;
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
