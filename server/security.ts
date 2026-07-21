import { timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";

import { isRecord } from "./types.js";

const RPC_METHODS_WITH_CWD = new Set([
  "thread/start",
  "thread/resume",
  "turn/start",
]);

export class ClientRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ClientRpcError";
  }
}

export class ClientInputError extends ClientRpcError {
  constructor(message: string) {
    super(-32602, message);
    this.name = "ClientInputError";
  }
}

export class MethodNotAllowedError extends ClientRpcError {
  constructor(method: string) {
    super(-32601, `RPC method is not available in Ask Agent: ${method}`);
    this.name = "MethodNotAllowedError";
  }
}

export function normalizeHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (host.startsWith("::ffff:")) {
    return isLoopbackHost(host.slice("::ffff:".length));
  }

  const ipv4 = host.split(".");
  return ipv4.length === 4 &&
    ipv4[0] === "127" &&
    ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function assertSafeBind(host: string, token?: string): void {
  if (!isLoopbackHost(host) && !token) {
    throw new Error(
      "ASK_AGENT_TOKEN is required when ASK_AGENT_HOST is not a loopback address",
    );
  }
}

export function isAllowedOrigin(
  origin: string | undefined,
  hostHeader: string | undefined,
  boundHost?: string,
  production = true,
): boolean {
  if (!hostHeader) {
    return false;
  }

  try {
    const requestUrl = new URL(`http://${hostHeader}`);
    const requestHostname = requestUrl.hostname;
    if (!requestHostname) {
      return false;
    }
    const normalizedRequestHostname = normalizeHostname(requestHostname);
    const loopbackBind = Boolean(boundHost && isLoopbackHost(boundHost));
    if (loopbackBind && !isLoopbackHost(normalizedRequestHostname)) {
      return false;
    }
    if (!origin) {
      return true;
    }

    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") {
      return false;
    }
    const originHostname = normalizeHostname(parsedOrigin.hostname);

    if (loopbackBind) {
      if (!isLoopbackHost(originHostname)) {
        return false;
      }
      if (parsedOrigin.origin === requestUrl.origin) {
        return true;
      }
      return !production &&
        parsedOrigin.protocol === "http:" &&
        parsedOrigin.port === "5173";
    }

    return originHostname === normalizedRequestHostname ||
      (isLoopbackHost(originHostname) && isLoopbackHost(normalizedRequestHostname));
  } catch {
    return false;
  }
}

export function tokenMatches(candidate: string | null | undefined, token: string): boolean {
  if (candidate === null || candidate === undefined) {
    return false;
  }
  const candidateBytes = Buffer.from(candidate);
  const tokenBytes = Buffer.from(token);
  return candidateBytes.length === tokenBytes.length &&
    timingSafeEqual(candidateBytes, tokenBytes);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1];
}

export function isHttpAuthorized(
  request: IncomingMessage,
  token: string | undefined,
): boolean {
  if (!token) {
    return true;
  }
  return tokenMatches(bearerToken(request), token);
}

export async function validateRpcCwd(method: string, params: unknown): Promise<void> {
  if (!RPC_METHODS_WITH_CWD.has(method) || !isRecord(params)) {
    return;
  }

  const cwd = params.cwd;
  if (cwd === undefined || cwd === null) {
    return;
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new ClientInputError(`${method} cwd must be an absolute path`);
  }

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    throw new ClientInputError(`${method} cwd does not exist`);
  }
  if (!cwdStat.isDirectory()) {
    throw new ClientInputError(`${method} cwd must be a directory`);
  }
}
