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
    expect(() => assertSafeBind("0.0.0.0")).toThrow("ASK_AGENT_TOKEN");
    expect(() => assertSafeBind("192.168.1.10")).toThrow("ASK_AGENT_TOKEN");
    expect(() => assertSafeBind("0.0.0.0", "secret")).not.toThrow();
    expect(isLoopbackHost("127.8.9.10")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
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
