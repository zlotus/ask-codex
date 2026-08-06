import { errorMessage, isRecord, readString } from "./protocol";

export const MAX_IMAGES_PER_TURN = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TURN = 4;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];
type DetectedImageFormat = SupportedImageType | "image/heif" | "image/avif";

const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SUPPORTED_IMAGE_TYPE_SET = new Set<string>(SUPPORTED_IMAGE_TYPES);
const POTENTIAL_IMAGE_TYPE_SET = new Set([
  ...SUPPORTED_IMAGE_TYPES,
  "image/jpg",
  "image/pjpeg",
]);
const IMAGE_FILENAME_PATTERN = /\.(?:png|jpe?g|webp)$/i;
const IMAGE_HEADER_BYTES = 4 * 1024;
const JPEG_MARKER_SEARCH_BYTES = IMAGE_HEADER_BYTES;
const UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const DISCARD_TIMEOUT_MS = 15 * 1000;
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

export interface UploadedAttachment {
  id: string;
  mediaType: string;
  size: number;
  expiresAt: number;
}

export interface UploadedFileAttachment extends UploadedAttachment {
  name: string;
}

export function isPotentialImageFile(file: Pick<File, "name" | "type">): boolean {
  const mediaType = file.type.trim().toLowerCase();
  if (POTENTIAL_IMAGE_TYPE_SET.has(mediaType)) return true;
  return (
    (mediaType === "" || mediaType === "application/octet-stream") &&
    IMAGE_FILENAME_PATTERN.test(file.name)
  );
}

function requestHeaders(token: string, contentType?: string): HeadersInit {
  return {
    Accept: "application/json",
    ...(contentType ? { "Content-Type": contentType } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function fileUploadMediaType(file: File): string {
  const mediaType = file.type.trim().toLowerCase();
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType)
    ? mediaType
    : "application/octet-stream";
}

function hasAttachmentFileNameControlCharacter(name: string): boolean {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isValidAttachmentFileName(name: string): boolean {
  return Boolean(name) &&
    name.trim() === name &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !hasAttachmentFileNameControlCharacter(name) &&
    new TextEncoder().encode(name).byteLength <= 255;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}

function startsWithBytes(data: Uint8Array, signature: readonly number[]): boolean {
  return data.byteLength >= signature.length &&
    signature.every((byte, index) => data[index] === byte);
}

function asciiAt(data: Uint8Array, offset: number, value: string): boolean {
  if (data.byteLength < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function asciiFourCC(data: Uint8Array, offset: number): string | undefined {
  if (data.byteLength < offset + 4) return undefined;
  return String.fromCharCode(
    data[offset],
    data[offset + 1],
    data[offset + 2],
    data[offset + 3],
  );
}

function readUint32BigEndian(data: Uint8Array, offset: number): number | undefined {
  if (data.byteLength < offset + 4) return undefined;
  return (
    data[offset] * 0x1000000 +
    data[offset + 1] * 0x10000 +
    data[offset + 2] * 0x100 +
    data[offset + 3]
  );
}

function readUint32LittleEndian(data: Uint8Array, offset: number): number | undefined {
  if (data.byteLength < offset + 4) return undefined;
  return (
    data[offset] +
    data[offset + 1] * 0x100 +
    data[offset + 2] * 0x10000 +
    data[offset + 3] * 0x1000000
  );
}

function detectIsoBaseMediaFormat(data: Uint8Array, fileSize: number): DetectedImageFormat | undefined {
  if (!asciiAt(data, 4, "ftyp")) return undefined;
  const boxSize = readUint32BigEndian(data, 0);
  if (boxSize === undefined || boxSize < 16 || boxSize > fileSize) return undefined;

  const brands: string[] = [];
  const majorBrand = asciiFourCC(data, 8);
  if (majorBrand) brands.push(majorBrand);
  for (let offset = 16; offset + 4 <= Math.min(boxSize, data.byteLength); offset += 4) {
    const brand = asciiFourCC(data, offset);
    if (brand) brands.push(brand);
  }
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return "image/avif";
  if (brands.some((brand) => HEIF_BRANDS.has(brand))) return "image/heif";
  return undefined;
}

function detectImageFormat(data: Uint8Array, fileSize: number): DetectedImageFormat | undefined {
  if (
    startsWithBytes(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
    fileSize >= 24 &&
    data[8] === 0 &&
    data[9] === 0 &&
    data[10] === 0 &&
    data[11] === 13 &&
    asciiAt(data, 12, "IHDR")
  ) {
    return "image/png";
  }

  if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    const markerSearchEnd = Math.min(data.byteLength, JPEG_MARKER_SEARCH_BYTES);
    let markerOffset = 2;
    while (markerOffset < markerSearchEnd && data[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    if (
      markerOffset > 2 &&
      markerOffset < markerSearchEnd &&
      data[markerOffset] !== 0x00
    ) {
      return "image/jpeg";
    }
  }

  if (
    fileSize >= 16 &&
    asciiAt(data, 0, "RIFF") &&
    asciiAt(data, 8, "WEBP") &&
    (asciiAt(data, 12, "VP8 ") ||
      asciiAt(data, 12, "VP8L") ||
      asciiAt(data, 12, "VP8X"))
  ) {
    const declaredSize = readUint32LittleEndian(data, 4);
    if (declaredSize !== undefined && declaredSize + 8 === fileSize) {
      return "image/webp";
    }
  }

  return detectIsoBaseMediaFormat(data, fileSize);
}

async function detectedUploadMediaType(file: File): Promise<SupportedImageType> {
  const header = new Uint8Array(
    await file.slice(0, Math.min(file.size, IMAGE_HEADER_BYTES)).arrayBuffer(),
  );
  const format = detectImageFormat(header, file.size);
  if (format === "image/heif") {
    throw new Error(
      "HEIF/HEIC images are not supported; export the image as PNG, JPEG, or WebP",
    );
  }
  if (format === "image/avif") {
    throw new Error(
      "AVIF images are not supported; export the image as PNG, JPEG, or WebP",
    );
  }
  if (!format) {
    throw new Error("Image content is not a supported PNG, JPEG, or WebP image");
  }
  return format;
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
    const uploadMediaType = await detectedUploadMediaType(file);
    return await withTimeout(UPLOAD_TIMEOUT_MS, "Image upload timed out", async (signal) => {
      const response = await fetch("/api/attachments", {
        method: "POST",
        headers: requestHeaders(token, uploadMediaType),
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

function validateGenericFiles(files: readonly File[]): void {
  if (files.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new Error(`A turn can include at most ${MAX_ATTACHMENTS_PER_TURN} attachments`);
  }
  for (const file of files) {
    if (!isValidAttachmentFileName(file.name)) {
      throw new Error("File name is invalid");
    }
    if (file.size === 0) {
      throw new Error(`${file.name} is empty`);
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(`${file.name} exceeds the 10 MiB file limit`);
    }
  }
}

async function uploadFile(file: File, token: string): Promise<UploadedFileAttachment> {
  try {
    return await withTimeout(UPLOAD_TIMEOUT_MS, "File upload timed out", async (signal) => {
      const response = await fetch("/api/file-attachments", {
        method: "POST",
        headers: {
          ...requestHeaders(token, fileUploadMediaType(file)),
          "X-Ask-Codex-File-Name": encodeURIComponent(file.name),
        },
        body: file,
        signal,
      });
      if (!response.ok) throw await responseError(response);

      const body: unknown = await response.json();
      const attachment = isRecord(body) && isRecord(body.attachment) ? body.attachment : null;
      const id = attachment ? readString(attachment.id) : undefined;
      const name = attachment ? readString(attachment.name) : undefined;
      const mediaType = attachment ? readString(attachment.mediaType) : undefined;
      const size = attachment?.size;
      const expiresAt = attachment?.expiresAt;
      if (
        !id ||
        !ATTACHMENT_ID_PATTERN.test(id) ||
        name !== file.name ||
        !mediaType ||
        !Number.isSafeInteger(size) ||
        (size as number) !== file.size ||
        !Number.isFinite(expiresAt)
      ) {
        throw new Error("The server returned an invalid attachment response");
      }
      return { id, name, mediaType, size: size as number, expiresAt: expiresAt as number };
    });
  } catch (error) {
    throw new Error(`${file.name || "File"}: ${errorMessage(error)}`, { cause: error });
  }
}

export async function uploadFileAttachments(
  files: readonly File[],
  token: string,
): Promise<UploadedFileAttachment[]> {
  validateGenericFiles(files);
  if (files.length === 0) return [];

  const results = await Promise.allSettled(files.map((file) => uploadFile(file, token)));
  const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) {
    void discardFileAttachments(uploaded, token);
    throw failed.reason instanceof Error ? failed.reason : new Error(errorMessage(failed.reason));
  }
  return results.map((result) => (
    result as PromiseFulfilledResult<UploadedFileAttachment>
  ).value);
}

export async function discardAttachments(
  attachments: readonly Pick<UploadedAttachment, "id">[],
  token: string,
): Promise<void> {
  await Promise.allSettled(attachments.map((attachment) => discardAttachment(attachment.id, token)));
}

export async function discardFileAttachment(id: string, token: string): Promise<void> {
  if (!ATTACHMENT_ID_PATTERN.test(id)) return;
  await withTimeout(DISCARD_TIMEOUT_MS, "Attachment cleanup timed out", async (signal) => {
    const response = await fetch(`/api/file-attachments/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: requestHeaders(token),
      signal,
    });
    if (!response.ok && response.status !== 404) throw await responseError(response);
  });
}

export async function discardFileAttachments(
  attachments: readonly Pick<UploadedFileAttachment, "id">[],
  token: string,
): Promise<void> {
  await Promise.allSettled(
    attachments.map((attachment) => discardFileAttachment(attachment.id, token)),
  );
}
