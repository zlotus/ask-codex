import { errorMessage, isRecord, readString } from "./protocol";

export const MAX_IMAGES_PER_TURN = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SUPPORTED_IMAGE_TYPE_SET = new Set<string>(SUPPORTED_IMAGE_TYPES);
const UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const DISCARD_TIMEOUT_MS = 15 * 1000;

export interface UploadedAttachment {
  id: string;
  mediaType: string;
  size: number;
  expiresAt: number;
}

function requestHeaders(token: string, contentType?: string): HeadersInit {
  return {
    Accept: "application/json",
    ...(contentType ? { "Content-Type": contentType } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function responseError(response: Response): Promise<Error> {
  let detail = `Attachment request failed (${response.status})`;
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      const nested = isRecord(body.error) ? readString(body.error.message) : undefined;
      detail = nested ?? readString(body.error) ?? detail;
    }
  } catch {
    // The status remains useful when a proxy replaces the JSON error body.
  }
  return new Error(detail);
}

async function withTimeout<T>(
  timeoutMs: number,
  timeoutMessage: string,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timeoutMessage, { cause: error });
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function validateFiles(files: readonly File[]): void {
  if (files.length > MAX_IMAGES_PER_TURN) {
    throw new Error(`A turn can include at most ${MAX_IMAGES_PER_TURN} images`);
  }
  for (const file of files) {
    if (!SUPPORTED_IMAGE_TYPE_SET.has(file.type)) {
      throw new Error(`${file.name || "Image"} must be a PNG, JPEG, or WebP image`);
    }
    if (file.size === 0) {
      throw new Error(`${file.name || "Image"} is empty`);
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`${file.name || "Image"} exceeds the 10 MiB image limit`);
    }
  }
}

async function uploadImage(file: File, token: string): Promise<UploadedAttachment> {
  try {
    return await withTimeout(UPLOAD_TIMEOUT_MS, "Image upload timed out", async (signal) => {
      const response = await fetch("/api/attachments", {
        method: "POST",
        headers: requestHeaders(token, file.type),
        body: file,
        signal,
      });
      if (!response.ok) throw await responseError(response);

      const body: unknown = await response.json();
      const attachment = isRecord(body) && isRecord(body.attachment) ? body.attachment : null;
      const id = attachment ? readString(attachment.id) : undefined;
      const mediaType = attachment ? readString(attachment.mediaType) : undefined;
      const size = attachment?.size;
      const expiresAt = attachment?.expiresAt;
      if (
        !id ||
        !ATTACHMENT_ID_PATTERN.test(id) ||
        !mediaType ||
        !SUPPORTED_IMAGE_TYPE_SET.has(mediaType) ||
        !Number.isSafeInteger(size) ||
        (size as number) < 1 ||
        !Number.isFinite(expiresAt)
      ) {
        throw new Error("The server returned an invalid attachment response");
      }
      return { id, mediaType, size: size as number, expiresAt: expiresAt as number };
    });
  } catch (error) {
    throw new Error(`${file.name || "Image"}: ${errorMessage(error)}`, { cause: error });
  }
}

export async function discardAttachment(id: string, token: string): Promise<void> {
  if (!ATTACHMENT_ID_PATTERN.test(id)) return;
  await withTimeout(DISCARD_TIMEOUT_MS, "Attachment cleanup timed out", async (signal) => {
    const response = await fetch(`/api/attachments/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: requestHeaders(token),
      signal,
    });
    if (!response.ok && response.status !== 404) throw await responseError(response);
  });
}

export async function uploadImageAttachments(
  files: readonly File[],
  token: string,
): Promise<UploadedAttachment[]> {
  validateFiles(files);
  if (files.length === 0) return [];

  const results = await Promise.allSettled(files.map((file) => uploadImage(file, token)));
  const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) {
    void discardAttachments(uploaded, token);
    throw failed.reason instanceof Error ? failed.reason : new Error(errorMessage(failed.reason));
  }
  return results.map((result) => (result as PromiseFulfilledResult<UploadedAttachment>).value);
}

export async function discardAttachments(
  attachments: readonly Pick<UploadedAttachment, "id">[],
  token: string,
): Promise<void> {
  await Promise.allSettled(attachments.map((attachment) => discardAttachment(attachment.id, token)));
}
