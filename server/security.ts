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
    super(-32601, `RPC method is not available in Ask Codex: ${method}`);
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

export function assertSafeBind(
  host: string,
  token?: string,
  publicOrigin?: string,
): void {
  if (publicOrigin && !token) {
    throw new Error(
      "ASK_CODEX_TOKEN is required when ASK_CODEX_PUBLIC_ORIGIN is configured",
    );
  }
  if (!isLoopbackHost(host) && !token) {
    throw new Error(
      "ASK_CODEX_TOKEN is required when ASK_CODEX_HOST is not a loopback address",
    );
  }
}

function parseHttpOrigin(value: string): URL | undefined {
  // URL normalization removes empty query markers and dot segments. Reject
  // every suffix except one optional trailing slash before parsing.
  const authority = /^https?:\/\/([^\s/?#\\]+)\/?$/i.exec(value)?.[1];
  if (!authority || authority.endsWith(":")) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function normalizePublicOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = parseHttpOrigin(trimmed);
  if (!parsed) {
    throw new Error(
      "ASK_CODEX_PUBLIC_ORIGIN must be an http:// or https:// origin without a path, query, fragment, or credentials",
    );
  }
  return parsed.origin;
}

function effectivePort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  return url.protocol === "https:" ? "443" : "80";
}

function matchesPublicHost(hostHeader: string, publicOrigin: URL): boolean {
  try {
    const requestUrl = new URL(`${publicOrigin.protocol}//${hostHeader}`);
    return !requestUrl.username &&
      !requestUrl.password &&
      requestUrl.pathname === "/" &&
      !requestUrl.search &&
      !requestUrl.hash &&
      normalizeHostname(requestUrl.hostname) === normalizeHostname(publicOrigin.hostname) &&
      effectivePort(requestUrl) === effectivePort(publicOrigin);
  } catch {
    return false;
  }
}

function hostHeaderIsLoopback(hostHeader: string): boolean {
  try {
    const requestUrl = new URL(`http://${hostHeader}`);
    return !requestUrl.username &&
      !requestUrl.password &&
      requestUrl.pathname === "/" &&
      !requestUrl.search &&
      !requestUrl.hash &&
      isLoopbackHost(requestUrl.hostname);
  } catch {
    return false;
  }
}

export function isAllowedOrigin(
  origin: string | undefined,
  hostHeader: string | undefined,
  boundHost?: string,
  production = true,
  publicOrigin?: string,
): boolean {
  if (!hostHeader) {
    return false;
  }

  try {
    if (publicOrigin) {
      const parsedPublicOrigin = parseHttpOrigin(publicOrigin);
      if (!parsedPublicOrigin) {
        return false;
      }
      if (matchesPublicHost(hostHeader, parsedPublicOrigin)) {
        if (!origin) {
          return true;
        }
        return parseHttpOrigin(origin)?.origin === parsedPublicOrigin.origin;
      }
      if (!hostHeaderIsLoopback(hostHeader)) {
        return false;
      }
    }

    const requestUrl = new URL(`http://${hostHeader}`);
    if (
      requestUrl.username ||
      requestUrl.password ||
      requestUrl.pathname !== "/" ||
      requestUrl.search ||
      requestUrl.hash
    ) {
      return false;
    }
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

    const parsedOrigin = parseHttpOrigin(origin);
    if (!parsedOrigin) {
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
  if (!isRecord(params)) {
    return;
  }

  if (method === "skills/list") {
    if (params.cwds === undefined) return;
    if (!Array.isArray(params.cwds)) {
      throw new ClientInputError(`${method} cwds must be an array`);
    }
    for (const [index, cwd] of params.cwds.entries()) {
      await validateDirectory(method, cwd, `cwds[${index}]`);
    }
    return;
  }

  if (!RPC_METHODS_WITH_CWD.has(method)) return;

  const cwd = params.cwd;
  if (cwd === undefined || cwd === null) {
    return;
  }
  await validateDirectory(method, cwd, "cwd");
}

async function validateDirectory(
  method: string,
  value: unknown,
  label: string,
): Promise<void> {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new ClientInputError(`${method} ${label} must be an absolute path`);
  }

  let directoryStat;
  try {
    directoryStat = await stat(value);
  } catch {
    throw new ClientInputError(`${method} ${label} does not exist`);
  }
  if (!directoryStat.isDirectory()) {
    throw new ClientInputError(`${method} ${label} must be a directory`);
  }
}
