import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodexSocket } from "./useCodexSocket";

class TestWebSocket {
  static readonly OPEN = 1;
  static instances: TestWebSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();

  constructor(readonly url: string) {
    TestWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.onopen?.();
  }

  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
}

const options = {
  enabled: true,
  token: "",
  onNotification: vi.fn(),
  onRequest: vi.fn(),
};

describe("useCodexSocket reconnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestWebSocket.instances = [];
    vi.stubGlobal("WebSocket", TestWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves retry attempts across effect restarts and resets only after Codex is ready", () => {
    const { result } = renderHook(() => useCodexSocket(options));
    act(() => vi.advanceTimersByTime(0));
    expect(TestWebSocket.instances).toHaveLength(1);

    act(() => TestWebSocket.instances[0].close());
    expect(result.current.connectionDetail).toBe("Disconnected · retrying in 1s");
    expect(result.current.retryAttempt).toBe(1);

    act(() => vi.advanceTimersByTime(1_000));
    act(() => vi.advanceTimersByTime(0));
    expect(TestWebSocket.instances).toHaveLength(2);
    expect(result.current.connectionDetail).toBe("Reconnecting · attempt 1");

    act(() => {
      TestWebSocket.instances[1].open();
      TestWebSocket.instances[1].close();
    });
    expect(result.current.connectionDetail).toBe("Disconnected · retrying in 2s");
    expect(result.current.retryAttempt).toBe(2);
    act(() => vi.advanceTimersByTime(1_999));
    expect(TestWebSocket.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    act(() => vi.advanceTimersByTime(0));
    expect(TestWebSocket.instances).toHaveLength(3);

    act(() => {
      TestWebSocket.instances[2].open();
      TestWebSocket.instances[2].message({
        type: "status",
        status: "ready",
        defaultCwd: "/workspace",
      });
    });
    expect(result.current.connection).toBe("connected");
    expect(result.current.retryAttempt).toBe(0);
    expect(result.current.readySequence).toBe(1);

    act(() => {
      TestWebSocket.instances[2].message({
        type: "status",
        status: "starting",
        defaultCwd: "/workspace",
      });
    });
    expect(result.current.connectionDetail).toBe("Restarting Codex");
    act(() => {
      TestWebSocket.instances[2].message({
        type: "status",
        status: "ready",
        defaultCwd: "/workspace",
      });
    });
    expect(result.current.connection).toBe("connected");
    expect(result.current.readySequence).toBe(2);
  });
});
