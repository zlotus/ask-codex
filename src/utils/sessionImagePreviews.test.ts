import { describe, expect, it, vi } from "vitest";
import { SessionImagePreviewRegistry, sessionImagePreviewKey } from "./sessionImagePreviews";

function image(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

function blobLabel(blob: Blob): string {
  return blob instanceof File ? blob.name : blob.type;
}

describe("SessionImagePreviewRegistry", () => {
  it("keeps ordered groups isolated by thread and turn, then revokes them on clear", () => {
    let nextUrl = 0;
    const revokeObjectURL = vi.fn();
    const registry = new SessionImagePreviewRegistry({
      createObjectURL: (blob) => `blob:${blobLabel(blob)}:${++nextUrl}`,
      revokeObjectURL,
    });
    const firstKey = sessionImagePreviewKey("thread-1", "turn-1");
    const secondKey = sessionImagePreviewKey("thread-2", "turn-1");

    registry.remember(firstKey, [image("first.png", 2), image("second.png", 3)]);
    const snapshot = registry.remember(secondKey, [image("third.png", 4)]);

    expect(snapshot[firstKey]).toEqual(["blob:first.png:1", "blob:second.png:2"]);
    expect(snapshot[secondKey]).toEqual(["blob:third.png:3"]);
    registry.clear();
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual([
      "blob:first.png:1",
      "blob:second.png:2",
      "blob:third.png:3",
    ]);
    expect(registry.snapshot()).toEqual({});
  });

  it("evicts the oldest whole group when count or byte budgets are exceeded", () => {
    const revokeObjectURL = vi.fn();
    const registry = new SessionImagePreviewRegistry({
      maxImages: 3,
      maxBytes: 7,
      createObjectURL: (blob) => `blob:${blobLabel(blob)}`,
      revokeObjectURL,
    });
    const firstKey = sessionImagePreviewKey("thread-1", "turn-1");
    const secondKey = sessionImagePreviewKey("thread-1", "turn-2");

    registry.remember(firstKey, [image("first.png", 3), image("second.png", 3)]);
    const snapshot = registry.remember(secondKey, [image("third.png", 2), image("fourth.png", 2)]);

    expect(snapshot[firstKey]).toBeUndefined();
    expect(snapshot[secondKey]).toEqual(["blob:third.png", "blob:fourth.png"]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first.png");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:second.png");
  });

  it("rolls back partially created URLs without replacing an existing group", () => {
    const revokeObjectURL = vi.fn();
    let shouldFail = false;
    const registry = new SessionImagePreviewRegistry({
      createObjectURL: (blob) => {
        const label = blobLabel(blob);
        if (shouldFail && label === "failure.png") throw new Error("preview failed");
        return `blob:${label}`;
      },
      revokeObjectURL,
    });
    const key = sessionImagePreviewKey("thread-1", "turn-1");
    registry.remember(key, [image("existing.png", 1)]);
    shouldFail = true;

    const snapshot = registry.remember(key, [image("created.png", 1), image("failure.png", 1)]);

    expect(snapshot[key]).toEqual(["blob:existing.png"]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:created.png");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:existing.png");
  });
});
