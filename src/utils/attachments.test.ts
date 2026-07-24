import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_IMAGE_BYTES,
  isPotentialImageFile,
  uploadImageAttachments,
} from "./attachments";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);
const JPEG_WITH_FILL = new Uint8Array([
  0xff, 0xd8, 0xff, 0xff, 0xff, 0xe1, 0x00, 0x02, 0xff, 0xd9,
]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);
const HEIF = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63,
]);
const AVIF = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
  0x6d, 0x69, 0x66, 0x31, 0x00, 0x00, 0x00, 0x00,
  0x6d, 0x69, 0x66, 0x31, 0x61, 0x76, 0x69, 0x66,
]);

function image(
  name: string,
  bytes: BlobPart = PNG,
  type = "image/png",
): File {
  return new File([bytes], name, { type });
}

function jpegWithMarkerAt(offset: number) {
  const bytes = new Uint8Array(offset + 3);
  bytes.fill(0xff, 0, offset);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[offset] = 0xe1;
  return bytes;
}

function uploadResponse(id: string, mediaType = "image/png", size = PNG.byteLength): Response {
  return new Response(JSON.stringify({
    attachment: { id, mediaType, size, expiresAt: Date.now() + 60_000 },
  }), { status: 201, headers: { "Content-Type": "application/json" } });
}

describe("image attachment uploads", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("recognizes Android MIME aliases and generic image file metadata", () => {
    expect(isPotentialImageFile(image("camera.jpg", JPEG_WITH_FILL, "image/jpg"))).toBe(true);
    expect(isPotentialImageFile(image("camera.jpeg", JPEG_WITH_FILL, "image/pjpeg"))).toBe(true);
    expect(isPotentialImageFile(image("camera.JPG", JPEG_WITH_FILL, "application/octet-stream")))
      .toBe(true);
    expect(isPotentialImageFile(image("pasted.webp", WEBP, ""))).toBe(true);
    expect(isPotentialImageFile(image("document.txt", JPEG_WITH_FILL, "application/octet-stream")))
      .toBe(false);
    expect(isPotentialImageFile(image("vector.svg", "<svg/>", "image/svg+xml"))).toBe(false);
  });

  it("uploads raw image bodies with bearer auth and preserves file order", async () => {
    const firstId = "a".repeat(32);
    const secondId = "b".repeat(32);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(uploadResponse(firstId, "image/png"))
      .mockResolvedValueOnce(uploadResponse(secondId, "image/webp"));
    vi.stubGlobal("fetch", fetchMock);
    const first = image("first.png");
    const second = image("second.webp", WEBP, "image/webp");

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
      headers: expect.objectContaining({ "Content-Type": "image/webp" }),
    }));
  });

  it("uses detected PNG and WebP types instead of misleading JPEG metadata", async () => {
    const firstId = "p".repeat(32);
    const secondId = "w".repeat(32);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(uploadResponse(firstId, "image/png", PNG.byteLength))
      .mockResolvedValueOnce(uploadResponse(secondId, "image/webp", WEBP.byteLength));
    vi.stubGlobal("fetch", fetchMock);
    const mislabeledPng = image("5523.jpg", PNG, "image/jpeg");
    const mislabeledWebp = image("camera.jpg", WEBP, "image/jpeg");

    await expect(uploadImageAttachments([mislabeledPng, mislabeledWebp], ""))
      .resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/attachments", expect.objectContaining({
      body: mislabeledPng,
      headers: expect.objectContaining({ "Content-Type": "image/png" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/attachments", expect.objectContaining({
      body: mislabeledWebp,
      headers: expect.objectContaining({ "Content-Type": "image/webp" }),
    }));
  });

  it("recognizes JPEG marker fill bytes without trusting its filename or MIME", async () => {
    const id = "j".repeat(32);
    const fetchMock = vi.fn().mockResolvedValue(
      uploadResponse(id, "image/jpeg", JPEG_WITH_FILL.byteLength),
    );
    vi.stubGlobal("fetch", fetchMock);
    const jpeg = image("not-a-jpeg.png", JPEG_WITH_FILL, "application/octet-stream");

    await expect(uploadImageAttachments([jpeg], "")).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/attachments", expect.objectContaining({
      body: jpeg,
      headers: expect.objectContaining({ "Content-Type": "image/jpeg" }),
    }));
  });

  it("bounds JPEG fill-byte detection to the shared 4 KiB prefix", async () => {
    const id = "k".repeat(32);
    const fetchMock = vi.fn().mockResolvedValue(
      uploadResponse(id, "image/jpeg", 4 * 1024 + 2),
    );
    vi.stubGlobal("fetch", fetchMock);
    const withinWindow = image("within.jpg", jpegWithMarkerAt(4 * 1024 - 1), "image/jpeg");
    const beyondWindow = image("beyond.jpg", jpegWithMarkerAt(4 * 1024), "image/jpeg");

    await expect(uploadImageAttachments([withinWindow], "")).resolves.toHaveLength(1);
    await expect(uploadImageAttachments([beyondWindow], ""))
      .rejects.toThrow("beyond.jpg: Image content is not a supported PNG, JPEG, or WebP image");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("identifies HEIF and AVIF containers before upload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadImageAttachments([image("camera.jpg", HEIF, "image/jpeg")], ""))
      .rejects.toThrow(
        "camera.jpg: HEIF/HEIC images are not supported; export the image as PNG, JPEG, or WebP",
      );
    await expect(uploadImageAttachments([image("still.jpg", AVIF, "image/jpeg")], ""))
      .rejects.toThrow(
        "still.jpg: AVIF images are not supported; export the image as PNG, JPEG, or WebP",
      );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown content and WebP files with inconsistent RIFF sizes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const forged = image("forged.jpg", new TextEncoder().encode("not an image"), "image/jpeg");
    const badWebp = WEBP.slice();
    badWebp[4] = 0x09;

    await expect(uploadImageAttachments([forged], ""))
      .rejects.toThrow("forged.jpg: Image content is not a supported PNG, JPEG, or WebP image");
    await expect(uploadImageAttachments([image("bad.webp", badWebp, "image/webp")], ""))
      .rejects.toThrow("bad.webp: Image content is not a supported PNG, JPEG, or WebP image");
    expect(fetchMock).not.toHaveBeenCalled();
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

    await expect(uploadImageAttachments([image("vector.svg", new TextEncoder().encode("<svg/>"), "image/svg+xml")], ""))
      .rejects.toThrow("PNG, JPEG, or WebP");
    await expect(uploadImageAttachments([image("empty.png", new Uint8Array(0))], ""))
      .rejects.toThrow("is empty");
    await expect(uploadImageAttachments([
      image("large.png", new Uint8Array(MAX_IMAGE_BYTES + 1)),
    ], ""))
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
