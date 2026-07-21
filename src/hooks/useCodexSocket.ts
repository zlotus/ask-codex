import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConnectionState,
  NotificationMessage,
  ServerRequestMessage,
  StatusMessage,
} from "../types/protocol";
import { errorMessage, parseServerMessage } from "../utils/protocol";

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface UseCodexSocketOptions {
  enabled: boolean;
  token: string;
  onNotification: (message: NotificationMessage) => void;
  onRequest: (message: ServerRequestMessage) => void;
  onStatus?: (message: StatusMessage) => void;
  onError?: (message: string) => void;
}

interface CodexSocketClient {
  connection: ConnectionState;
  connectionDetail: string;
  rpc: (method: string, params?: unknown) => Promise<unknown>;
  respond: (id: string | number, result?: unknown, error?: unknown) => void;
  reconnect: () => void;
}

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL("/ws", `${protocol}//${window.location.host}`);
  return url.toString();
}

function makeId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function useCodexSocket(options: UseCodexSocketOptions): CodexSocketClient {
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [connectionDetail, setConnectionDetail] = useState("Not connected");
  const [retrySignal, setRetrySignal] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);
  const pendingRef = useRef(new Map<string, PendingRpc>());
  const callbacksRef = useRef(options);
  const generationRef = useRef(0);

  useEffect(() => {
    callbacksRef.current = options;
  }, [options]);

  const rejectPending = useCallback((reason: string) => {
    for (const pending of pendingRef.current.values()) pending.reject(new Error(reason));
    pendingRef.current.clear();
  }, []);

  const connect = useCallback(() => {
    if (!callbacksRef.current.enabled) return;
    const generation = ++generationRef.current;
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    socketRef.current?.close();
    setConnection("connecting");
    setConnectionDetail(retryCountRef.current > 0 ? "Reconnecting" : "Connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl());
    } catch (error) {
      setConnection("error");
      setConnectionDetail(errorMessage(error));
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      if (generation !== generationRef.current) return;
      if (callbacksRef.current.token) {
        socket.send(JSON.stringify({ type: "auth", token: callbacksRef.current.token }));
      }
      retryCountRef.current = 0;
      setConnection("connecting");
      setConnectionDetail("Connected to server, starting Codex");
    };

    socket.onmessage = (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        callbacksRef.current.onError?.("Received an invalid server message");
        return;
      }
      const message = parseServerMessage(raw);
      if (!message) {
        callbacksRef.current.onError?.("Received an unsupported server message");
        return;
      }
      switch (message.type) {
        case "status": {
          callbacksRef.current.onStatus?.(message);
          if (message.status === "error") {
            const detail = message.error?.message ?? "Codex failed to start";
            setConnection("error");
            setConnectionDetail(detail);
            callbacksRef.current.onError?.(detail);
          } else if (message.status === "ready") {
            setConnection("connected");
            setConnectionDetail("Ready");
          } else {
            setConnection("connecting");
            setConnectionDetail("Starting Codex");
          }
          break;
        }
        case "rpcResult": {
          const pending = pendingRef.current.get(message.id);
          if (pending) {
            pendingRef.current.delete(message.id);
            pending.resolve(message.result);
          }
          break;
        }
        case "rpcError": {
          const pending = pendingRef.current.get(message.id);
          const detail = errorMessage(message.error);
          if (pending) {
            pendingRef.current.delete(message.id);
            pending.reject(new Error(detail));
          } else {
            callbacksRef.current.onError?.(detail);
          }
          break;
        }
        case "notification":
          callbacksRef.current.onNotification(message);
          break;
        case "request":
          callbacksRef.current.onRequest(message);
          break;
      }
    };

    socket.onerror = () => {
      if (generation !== generationRef.current) return;
      setConnection("error");
      setConnectionDetail("WebSocket connection failed");
    };

    socket.onclose = () => {
      if (generation !== generationRef.current) return;
      socketRef.current = null;
      rejectPending("Connection closed before Codex replied");
      if (!callbacksRef.current.enabled) return;
      setConnection("disconnected");
      setConnectionDetail("Disconnected");
      const delay = Math.min(1_000 * 2 ** retryCountRef.current, 12_000);
      retryCountRef.current += 1;
      retryTimerRef.current = window.setTimeout(() => {
        setRetrySignal((current) => current + 1);
      }, delay);
    };
  }, [rejectPending]);

  useEffect(() => {
    if (!options.enabled) return;
    retryCountRef.current = 0;
    const startTimer = window.setTimeout(connect, 0);
    return () => {
      window.clearTimeout(startTimer);
      generationRef.current += 1;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
      rejectPending("Connection closed");
    };
  }, [connect, options.enabled, options.token, rejectPending, retrySignal]);

  const rpc = useCallback((method: string, params: unknown = {}) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex is not connected"));
    }
    const id = makeId();
    return new Promise<unknown>((resolve, reject) => {
      pendingRef.current.set(id, { resolve, reject });
      socket.send(JSON.stringify({ type: "rpc", id, method, params }));
    });
  }, []);

  const respond = useCallback((id: string | number, result?: unknown, error?: unknown) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex is not connected");
    }
    socket.send(JSON.stringify({
      type: "response",
      id,
      ...(error !== undefined ? { error } : { result }),
    }));
  }, []);

  const reconnect = useCallback(() => {
    retryCountRef.current = 0;
    setRetrySignal((current) => current + 1);
  }, []);

  return {
    connection: options.enabled ? connection : "disconnected",
    connectionDetail: options.enabled ? connectionDetail : "Not connected",
    rpc,
    respond,
    reconnect,
  };
}
