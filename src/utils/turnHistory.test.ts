import { describe, expect, it, vi } from "vitest";
import {
  isOversizedHistoryResponseError,
  requestFullTurnPage,
  isThreadItemPaginationUnsupported,
  requestTurnItemPage,
  requestTurnPage,
  resumeThreadForHistory,
} from "./turnHistory";

describe("turn history loading", () => {
  it("recognizes the app-server unsupported item pagination error", () => {
    expect(isThreadItemPaginationUnsupported(
      new Error("thread/items/list is not supported yet"),
    )).toBe(true);
    expect(isThreadItemPaginationUnsupported(new Error("Method not found: thread/items/list")))
      .toBe(true);
    expect(isThreadItemPaginationUnsupported(new Error("thread/turns/list is not supported")))
      .toBe(false);
  });

  it("recognizes both gateway and app-server history response limits", () => {
    expect(isOversizedHistoryResponseError(
      new Error("Codex response exceeded the 1 MiB gateway message limit"),
    )).toBe(true);
    expect(isOversizedHistoryResponseError(
      new Error("Codex app-server stdout JSONL line exceeded 8388608 byte limit"),
    )).toBe(true);
    expect(isOversizedHistoryResponseError(new Error("Connection closed"))).toBe(false);
  });

  it("retries resume without an initial page when the combined response is oversized", async () => {
    const rpc = vi.fn()
      .mockRejectedValueOnce(new Error("Codex response exceeded the 1 MiB gateway message limit"))
      .mockResolvedValueOnce({ thread: { id: "thread-1", turns: [] }, initialTurnsPage: null });

    await expect(resumeThreadForHistory(rpc, "thread-1", 10)).resolves.toEqual(expect.objectContaining({
      thread: expect.objectContaining({ id: "thread-1" }),
    }));
    expect(rpc).toHaveBeenNthCalledWith(2, "thread/resume", {
      threadId: "thread-1",
      excludeTurns: true,
    });
  });

  it("reduces a full page after a gateway size error", async () => {
    const rpc = vi.fn()
      .mockRejectedValueOnce(new Error("Codex response exceeded the 1 MiB gateway message limit"))
      .mockResolvedValueOnce({ data: [{ id: "turn-1", items: [] }], nextCursor: "next" });

    const page = await requestTurnPage(rpc, { threadId: "thread-1", preferredLimit: 10 });

    expect(page.nextCursor).toBe("next");
    expect(rpc).toHaveBeenNthCalledWith(1, "thread/turns/list", expect.objectContaining({ limit: 10, itemsView: "full" }));
    expect(rpc).toHaveBeenNthCalledWith(2, "thread/turns/list", expect.objectContaining({ limit: 5, itemsView: "full" }));
  });

  it("falls back to a single summary turn when full detail remains oversized", async () => {
    const sizeError = new Error("Codex response exceeded the 1 MiB gateway message limit");
    const rpc = vi.fn()
      .mockRejectedValueOnce(sizeError)
      .mockRejectedValueOnce(sizeError)
      .mockRejectedValueOnce(sizeError)
      .mockResolvedValueOnce({
        data: [{ id: "turn-1", items: [], itemsView: "summary" }],
        nextCursor: null,
      });

    const page = await requestTurnPage(rpc, {
      threadId: "thread-1",
      cursor: "older",
      preferredLimit: 10,
    });

    expect(page.data[0]?.itemsView).toBe("summary");
    expect(rpc).toHaveBeenLastCalledWith("thread/turns/list", {
      threadId: "thread-1",
      cursor: "older",
      limit: 1,
      sortDirection: "desc",
      itemsView: "summary",
    });
  });

  it("does not retry unrelated failures", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("Connection closed"));

    await expect(requestTurnPage(rpc, { threadId: "thread-1", preferredLimit: 10 }))
      .rejects.toThrow("Connection closed");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("preserves an empty opaque cursor", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], nextCursor: null });

    await requestTurnPage(rpc, {
      threadId: "thread-1",
      cursor: "",
      preferredLimit: 10,
    });

    expect(rpc).toHaveBeenCalledWith("thread/turns/list", expect.objectContaining({ cursor: "" }));
  });

  it("requests one full turn without falling back to a summary", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ id: "turn-large", items: [], itemsView: "full" }],
      nextCursor: "older",
    });

    const page = await requestFullTurnPage(rpc, {
      threadId: "thread-1",
      cursor: "page-large",
    });

    expect(page.data[0]?.id).toBe("turn-large");
    expect(rpc).toHaveBeenCalledWith("thread/turns/list", {
      threadId: "thread-1",
      cursor: "page-large",
      limit: 1,
      sortDirection: "desc",
      itemsView: "full",
    });
  });

  it("requests an ascending item page with a bounded limit and preserves an empty cursor", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ turnId: "turn-large", item: { id: "item-1", type: "agentMessage" } }],
      nextCursor: "next-item-page",
      backwardsCursor: "newer-item-page",
    });

    const page = await requestTurnItemPage(rpc, {
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "",
      preferredLimit: 250,
    });

    expect(page.data[0]?.item.id).toBe("item-1");
    expect(rpc).toHaveBeenCalledWith("thread/items/list", {
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "",
      limit: 100,
      sortDirection: "asc",
    });
  });

  it("reduces an item page after gateway size errors", async () => {
    const sizeError = new Error("Codex response exceeded the 1 MiB gateway message limit");
    const rpc = vi.fn()
      .mockRejectedValueOnce(sizeError)
      .mockRejectedValueOnce(sizeError)
      .mockResolvedValueOnce({ data: [], nextCursor: null, backwardsCursor: null });

    await requestTurnItemPage(rpc, {
      threadId: "thread-1",
      turnId: "turn-large",
      preferredLimit: 25,
    });

    expect(rpc).toHaveBeenNthCalledWith(1, "thread/items/list", expect.objectContaining({ limit: 25 }));
    expect(rpc).toHaveBeenNthCalledWith(2, "thread/items/list", expect.objectContaining({ limit: 12 }));
    expect(rpc).toHaveBeenNthCalledWith(3, "thread/items/list", expect.objectContaining({ limit: 1 }));
  });

  it("reduces an item page after the app-server stdout line limit restarts the process", async () => {
    const rpc = vi.fn()
      .mockRejectedValueOnce(new Error(
        "Codex app-server stdout JSONL line exceeded 8388608 byte limit",
      ))
      .mockResolvedValueOnce({ data: [], nextCursor: null, backwardsCursor: null });

    await requestTurnItemPage(rpc, {
      threadId: "thread-1",
      turnId: "turn-large",
      preferredLimit: 10,
    });

    expect(rpc).toHaveBeenNthCalledWith(1, "thread/items/list", expect.objectContaining({ limit: 10 }));
    expect(rpc).toHaveBeenNthCalledWith(2, "thread/items/list", expect.objectContaining({ limit: 5 }));
  });

  it("reports when one item still exceeds the gateway limit", async () => {
    const sizeError = new Error("Codex response exceeded the 1 MiB gateway message limit");
    const rpc = vi.fn().mockRejectedValue(sizeError);

    await expect(requestTurnItemPage(rpc, {
      threadId: "thread-1",
      turnId: "turn-large",
      preferredLimit: 10,
    })).rejects.toThrow("A single Codex item still exceeds Ask Codex transport limits");
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("rejects item pages for another turn without retrying", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ turnId: "turn-other", item: { id: "item-1", type: "agentMessage" } }],
      nextCursor: null,
      backwardsCursor: null,
    });

    await expect(requestTurnItemPage(rpc, {
      threadId: "thread-1",
      turnId: "turn-large",
      preferredLimit: 25,
    })).rejects.toThrow("Codex returned an item for a different turn");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-advancing item cursor, including an empty opaque cursor", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], nextCursor: "", backwardsCursor: null });

    await expect(requestTurnItemPage(rpc, {
      threadId: "thread-1",
      turnId: "turn-large",
      cursor: "",
      preferredLimit: 25,
    })).rejects.toThrow("Codex returned a non-advancing item cursor");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
