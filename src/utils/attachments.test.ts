import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_IMAGE_BYTES,
  uploadImageAttachments,
} from "./attachments";

function image(name: string, type = "image/png", size = 8): File {
  return new File([new Uint8Array(size)], name, { type });
}

function uploadResponse(id: string, mediaType = "image/png", size = 8): Response {
  return new Response(JSON.stringify({
    attachment: { id, mediaType, size, expiresAt: Date.now() + 60_000 },
  }), { status: 201, headers: { "Content-Type": "application/json" } });
}

describe("image attachment uploads", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uploads raw image bodies with bearer auth and preserves file order", async () => {
    const firstId = "a".repeat(32);
    const secondId = "b".repeat(32);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(uploadResponse(firstId, "image/png"))
      .mockResolvedValueOnce(uploadResponse(secondId, "image/webp"));
    vi.stubGlobal("fetch", fetchMock);
    const first = image("first.png");
    const second = image("second.webp", "image/webp");

    await expect(uploadImageAttachments([first, second], "secret-token"))
      .resolves.toEqual([
        expect.objectContaining({ id: firstId }),
        expect.objectContaining({ id: secondId }),
      ]);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/attachments", expect.objectContaining({
      method: "POST",
      body: first,
      headers: expect.objectContaining({
        Authorization: "Bearer secret-token",
        "Content-Type": "image/png",
      }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/attachments", expect.objectContaining({
      body: second,
    }));
  });

  it("cleans up successful peers when one upload fails", async () => {
    const uploadedId = "a".repeat(32);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(uploadResponse(uploadedId))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "invalidImage", message: "Image bytes do not match Content-Type" },
      }), { status: 415 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadImageAttachments([image("good.png"), image("bad.png")], "token"))
      .rejects.toThrow("bad.png: Image bytes do not match Content-Type");
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/attachments/${uploadedId}`, expect.objectContaining({
      method: "DELETE",
    }));
  });

  it("rejects unsupported, empty, oversized, and excessive files before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadImageAttachments([image("vector.svg", "image/svg+xml")], ""))
      .rejects.toThrow("PNG, JPEG, or WebP");
    await expect(uploadImageAttachments([image("empty.png", "image/png", 0)], ""))
      .rejects.toThrow("is empty");
    await expect(uploadImageAttachments([image("large.png", "image/png", MAX_IMAGE_BYTES + 1)], ""))
      .rejects.toThrow("10 MiB");
    await expect(uploadImageAttachments(Array.from({ length: 5 }, (_, index) => image(`${index}.png`)), ""))
      .rejects.toThrow("at most 4 images");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed attachment responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      attachment: { id: "/tmp/image.png", mediaType: "image/png", size: 8, expiresAt: Date.now() },
    }), { status: 201 })));

    await expect(uploadImageAttachments([image("image.png")], ""))
      .rejects.toThrow("invalid attachment response");
  });

  it("aborts a stalled upload and identifies the file that timed out", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    }));

    const upload = uploadImageAttachments([image("stalled.png")], "");
    const rejection = expect(upload).rejects.toThrow("stalled.png: Image upload timed out");
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });
});
