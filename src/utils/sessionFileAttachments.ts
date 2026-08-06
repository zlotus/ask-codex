import { MAX_ATTACHMENTS_PER_TURN, MAX_FILE_BYTES } from "./attachments";
import {
  isSessionImagePreviewKey,
  sessionImagePreviewKey,
  sessionImagePreviewThreadId,
} from "./sessionImagePreviews";

export const MAX_LOCAL_FILE_COUNT = 8;
export const MAX_LOCAL_FILE_BYTES = 40 * 1024 * 1024;

export interface LocalFileAttachment {
  blob: Blob;
  mediaType: string;
  name: string;
  size: number;
}

interface FileGroup {
  byteSize: number;
  files: LocalFileAttachment[];
}

export type SessionFileAttachmentSnapshot = Readonly<
  Record<string, readonly LocalFileAttachment[]>
>;

export const sessionFileAttachmentKey = sessionImagePreviewKey;
export const sessionFileAttachmentThreadId = sessionImagePreviewThreadId;
export const isSessionFileAttachmentKey = isSessionImagePreviewKey;

export function downloadLocalFileAttachment(file: LocalFileAttachment): void {
  const url = URL.createObjectURL(file.blob);
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = file.name;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}

function isValidFile(file: LocalFileAttachment): boolean {
  const blobTag = Object.prototype.toString.call(file.blob);
  const validBlob = typeof file.blob === "object" &&
    file.blob !== null &&
    ((typeof Blob !== "undefined" && file.blob instanceof Blob) || blobTag === "[object Blob]") &&
    typeof file.blob.slice === "function";
  return typeof file.name === "string" &&
    file.name.length > 0 &&
    typeof file.mediaType === "string" &&
    file.mediaType.length > 0 &&
    Number.isSafeInteger(file.size) &&
    file.size >= 1 &&
    file.size <= MAX_FILE_BYTES &&
    validBlob &&
    file.blob.size === file.size;
}

export class SessionFileAttachmentRegistry {
  readonly #entries = new Map<string, FileGroup>();
  #fileCount = 0;
  #byteSize = 0;

  remember(
    key: string,
    files: readonly LocalFileAttachment[],
  ): SessionFileAttachmentSnapshot {
    if (
      !isSessionFileAttachmentKey(key) ||
      files.length < 1 ||
      files.length > MAX_ATTACHMENTS_PER_TURN ||
      !files.every(isValidFile)
    ) {
      return this.snapshot();
    }
    this.#remove(key);
    const stored = files.map((file) => ({ ...file }));
    const group = {
      files: stored,
      byteSize: stored.reduce((total, file) => total + file.size, 0),
    };
    this.#entries.set(key, group);
    this.#fileCount += stored.length;
    this.#byteSize += group.byteSize;
    while (this.#fileCount > MAX_LOCAL_FILE_COUNT || this.#byteSize > MAX_LOCAL_FILE_BYTES) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.#remove(oldestKey);
    }
    return this.snapshot();
  }

  snapshot(): SessionFileAttachmentSnapshot {
    return Object.fromEntries(
      [...this.#entries].map(([key, group]) => [
        key,
        group.files.map((file) => ({ ...file })),
      ]),
    );
  }

  removeThread(threadId: string): SessionFileAttachmentSnapshot {
    for (const key of [...this.#entries.keys()]) {
      if (sessionFileAttachmentThreadId(key) === threadId) this.#remove(key);
    }
    return this.snapshot();
  }

  clear(): void {
    this.#entries.clear();
    this.#fileCount = 0;
    this.#byteSize = 0;
  }

  #remove(key: string): void {
    const group = this.#entries.get(key);
    if (!group) return;
    this.#entries.delete(key);
    this.#fileCount -= group.files.length;
    this.#byteSize -= group.byteSize;
  }
}
