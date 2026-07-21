export type RpcId = number | string;

export type CodexStatus = "starting" | "ready" | "error";

export interface StatusMessage {
  type: "status";
  status: CodexStatus;
  defaultCwd: string;
  version?: string;
  error?: { message: string };
}

export interface RpcResultMessage {
  type: "rpcResult";
  id: string;
  result: unknown;
}

export interface RpcErrorMessage {
  type: "rpcError";
  id: string;
  error: unknown;
}

export interface NotificationMessage {
  type: "notification";
  method: string;
  params: unknown;
}

export interface RequestMessage {
  type: "request";
  id: RpcId;
  method: string;
  params: unknown;
}

export type ServerMessage =
  | StatusMessage
  | RpcResultMessage
  | RpcErrorMessage
  | NotificationMessage
  | RequestMessage;

export interface BrowserRpcMessage {
  type: "rpc";
  id: string;
  method: string;
  params: unknown;
}

export interface BrowserResponseMessage {
  type: "response";
  id: RpcId;
  result?: unknown;
  error?: unknown;
}

export type BrowserMessage = BrowserRpcMessage | BrowserResponseMessage;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value));
}

export function parseBrowserMessage(value: unknown): BrowserMessage | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.type === "rpc") {
    if (
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      typeof value.method !== "string" ||
      value.method.length === 0 ||
      !("params" in value)
    ) {
      return null;
    }

    return {
      type: "rpc",
      id: value.id,
      method: value.method,
      params: value.params,
    };
  }

  if (value.type === "response") {
    const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
    const hasError = Object.prototype.hasOwnProperty.call(value, "error");
    if (!isRpcId(value.id) || hasResult === hasError) {
      return null;
    }

    if (hasResult) {
      return { type: "response", id: value.id, result: value.result };
    }

    return { type: "response", id: value.id, error: value.error };
  }

  return null;
}
