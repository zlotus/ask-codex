// @vitest-environment node

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertSafeBind,
  isAllowedOrigin,
  isLoopbackHost,
  validateRpcCwd,
} from "./security.js";

describe("server security", () => {
  it("requires a token for non-loopback binds", () => {
    expect(() => assertSafeBind("0.0.0.0")).toThrow("ASK_CODEX_TOKEN");
    expect(() => assertSafeBind("192.168.1.10")).toThrow("ASK_CODEX_TOKEN");
    expect(() => assertSafeBind("0.0.0.0", "secret")).not.toThrow();
    expect(isLoopbackHost("127.8.9.10")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  it("requires a token when a public origin is configured", () => {
    expect(() => assertSafeBind(
      "127.0.0.1",
      undefined,
      "https://codex.example.com",
    )).toThrow("ASK_CODEX_TOKEN");
    expect(() => assertSafeBind(
      "127.0.0.1",
      "secret",
      "https://codex.example.com",
    )).not.toThrow();
  });

  it("allows matching non-loopback hostnames", () => {
    expect(isAllowedOrigin("http://localhost:5173", "localhost:4173")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173", "127.0.0.1:4173")).toBe(true);
    expect(isAllowedOrigin("https://example.com", "example.com:4173")).toBe(true);
    expect(isAllowedOrigin("https://evil.example", "example.com:4173")).toBe(false);
    expect(isAllowedOrigin("file:///tmp/index.html", "localhost:4173")).toBe(false);
    expect(isAllowedOrigin("https://evil.example", "evil.example", "127.0.0.1")).toBe(false);
  });

  it("requires an exact loopback Origin in production", () => {
    expect(isAllowedOrigin(
      "http://127.0.0.1:4173",
      "127.0.0.1:4173",
      "127.0.0.1",
      true,
    )).toBe(true);
    expect(isAllowedOrigin(
      "http://127.0.0.1:5173",
      "127.0.0.1:4173",
      "127.0.0.1",
      true,
    )).toBe(false);
    expect(isAllowedOrigin(
      "https://127.0.0.1:4173",
      "127.0.0.1:4173",
      "127.0.0.1",
      true,
    )).toBe(false);
    expect(isAllowedOrigin(
      "http://localhost:4173",
      "127.0.0.1:4173",
      "127.0.0.1",
      true,
    )).toBe(false);
  });

  it("allows only the explicit Vite loopback port in development", () => {
    expect(isAllowedOrigin(
      "http://localhost:5173",
      "127.0.0.1:4173",
      "127.0.0.1",
      false,
    ))
      .toBe(true);
    expect(isAllowedOrigin(
      "http://localhost:5174",
      "127.0.0.1:4173",
      "127.0.0.1",
      false,
    )).toBe(false);
    expect(isAllowedOrigin(
      "https://localhost:5173",
      "127.0.0.1:4173",
      "127.0.0.1",
      false,
    )).toBe(false);
  });

  it("allows an exact configured public Host and Origin through a loopback bind", () => {
    const publicOrigin = "https://codex.example.com";

    expect(isAllowedOrigin(
      publicOrigin,
      "codex.example.com",
      "127.0.0.1",
      true,
      publicOrigin,
    )).toBe(true);
    expect(isAllowedOrigin(
      publicOrigin,
      "codex.example.com:443",
      "127.0.0.1",
      true,
      publicOrigin,
    )).toBe(true);
    expect(isAllowedOrigin(
      undefined,
      "codex.example.com",
      "127.0.0.1",
      true,
      publicOrigin,
    )).toBe(true);
  });

  it("rejects public Host, Origin, and port mismatches", () => {
    const publicOrigin = "https://codex.example.com";

    expect(isAllowedOrigin(
      "https://evil.example",
      "codex.example.com",
      "127.0.0.1",
      true,
      publicOrigin,
    )).toBe(false);
    expect(isAllowedOrigin(
      publicOrigin,
      "evil.example",
      "127.0.0.1",
      true,
      publicOrigin,
    )).toBe(false);
    expect(isAllowedOrigin(
      publicOrigin,
      "codex.example.com:444",
      "127.0.0.1",
      true,
      publicOrigin,
    )).toBe(false);

    const nonDefaultPort = "https://codex.example.com:8443";
    expect(isAllowedOrigin(
      nonDefaultPort,
      "codex.example.com:8443",
      "127.0.0.1",
      true,
      nonDefaultPort,
    )).toBe(true);
    expect(isAllowedOrigin(
      nonDefaultPort,
      "codex.example.com",
      "127.0.0.1",
      true,
      nonDefaultPort,
    )).toBe(false);

    expect(isAllowedOrigin(
      publicOrigin,
      "codex.example.com:444",
      "0.0.0.0",
      true,
      publicOrigin,
    )).toBe(false);
    expect(isAllowedOrigin(
      "https://evil.example",
      "evil.example",
      "0.0.0.0",
      true,
      publicOrigin,
    )).toBe(false);
  });

  it("preserves direct loopback access when a public origin is configured", () => {
    expect(isAllowedOrigin(
      "http://127.0.0.1:4173",
      "127.0.0.1:4173",
      "127.0.0.1",
      true,
      "https://codex.example.com",
    )).toBe(true);
  });

  it("validates cwd overrides for thread and turn methods", async () => {
    await expect(validateRpcCwd("thread/start", { cwd: process.cwd() })).resolves.toBeUndefined();
    await expect(validateRpcCwd("turn/start", { cwd: "relative/path" })).rejects.toThrow(
      "absolute path",
    );
    await expect(
      validateRpcCwd("thread/resume", { cwd: join(process.cwd(), "does-not-exist") }),
    ).rejects.toThrow("does not exist");
    await expect(
      validateRpcCwd("thread/start", { cwd: join(process.cwd(), "package.json") }),
    ).rejects.toThrow("must be a directory");
    await expect(validateRpcCwd("thread/list", { cwd: "relative-is-irrelevant" }))
      .resolves.toBeUndefined();
  });
});
