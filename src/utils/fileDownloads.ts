import type { FileDownloadCapability } from "../types/protocol";
import { isRecord, readString } from "./protocol";

const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const FALLBACK_FILE_NAME = "download";

function requestHeaders(token: string): HeadersInit {
  return {
    Accept: "application/octet-stream, application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function responseError(response: Response): Promise<Error> {
  let detail = `File download failed (${response.status})`;
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      const nested = isRecord(body.error) ? readString(body.error.message) : undefined;
      detail = nested ?? readString(body.error) ?? detail;
    }
  } catch {
    // The status remains useful when a proxy replaces the gateway JSON body.
  }
  return new Error(detail);
}

function safeFileName(value: string | undefined): string {
  if (!value) return FALLBACK_FILE_NAME;
  const leaf = value.split(/[\\/]/).at(-1) ?? "";
  const cleaned = [...leaf]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f &&
        !(codePoint >= 0x7f && codePoint <= 0x9f) &&
        !(codePoint >= 0x202a && codePoint <= 0x202e) &&
        !(codePoint >= 0x2066 && codePoint <= 0x2069);
    })
    .join("")
    .trim()
    .slice(0, 240);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : FALLBACK_FILE_NAME;
}

function contentDispositionFileName(value: string | null): string {
  if (!value || !/^\s*attachment(?:\s*;|\s*$)/i.test(value)) return FALLBACK_FILE_NAME;

  const encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]*)/i.exec(value)?.[1]?.trim();
  if (encoded) {
    try {
      return safeFileName(decodeURIComponent(encoded));
    } catch {
      // Fall through to the ASCII filename when the extended value is malformed.
    }
  }

  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(value)?.[1];
  if (quoted !== undefined) {
    return safeFileName(quoted.replace(/\\(["\\])/g, "$1"));
  }
  const plain = /(?:^|;)\s*filename\s*=\s*([^;]*)/i.exec(value)?.[1]?.trim();
  return safeFileName(plain);
}

function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try {
    link.href = objectUrl;
    link.download = fileName;
    link.hidden = true;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

export async function downloadFileCapability(
  capability: FileDownloadCapability,
  token: string,
): Promise<void> {
  if (!CAPABILITY_ID_PATTERN.test(capability.capabilityId)) {
    throw new Error("File download is unavailable");
  }

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(
      `/api/file-downloads/${encodeURIComponent(capability.capabilityId)}`,
      {
        method: "POST",
        headers: requestHeaders(token),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw await responseError(response);

    const declaredSize = response.headers.get("Content-Length");
    if (
      declaredSize !== null &&
      (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_DOWNLOAD_BYTES)
    ) {
      throw new Error("File download exceeds the size limit");
    }

    const blob = await response.blob();
    if (blob.size > MAX_DOWNLOAD_BYTES) {
      throw new Error("File download exceeds the size limit");
    }
    triggerBrowserDownload(
      blob,
      contentDispositionFileName(response.headers.get("Content-Disposition")),
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("File download timed out", { cause: error });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
