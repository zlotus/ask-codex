import type WebSocket from "ws";

import { isRecord } from "./types.js";

export class ThreadOwnership {
  private readonly owners = new Map<string, WebSocket>();

  set(threadId: string, owner: WebSocket): void {
    this.owners.set(threadId, owner);
  }

  get(threadId: string | undefined): WebSocket | undefined {
    return threadId ? this.owners.get(threadId) : undefined;
  }

  deleteOwner(owner: WebSocket): void {
    for (const [threadId, candidate] of this.owners) {
      if (candidate === owner) {
        this.owners.delete(threadId);
      }
    }
  }
}

export function threadIdFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  if (typeof params.threadId === "string") {
    return params.threadId;
  }
  if (typeof params.conversationId === "string") {
    return params.conversationId;
  }
  return undefined;
}

export function threadIdFromStartResult(result: unknown): string | undefined {
  if (!isRecord(result) || !isRecord(result.thread)) {
    return undefined;
  }
  return typeof result.thread.id === "string" ? result.thread.id : undefined;
}
