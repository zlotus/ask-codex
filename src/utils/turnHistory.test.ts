import { describe, expect, it, vi } from "vitest";
import { requestFullTurnPage, requestTurnPage, resumeThreadForHistory } from "./turnHistory";

describe("turn history loading", () => {
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
});
