const DEFAULT_MAX_IMAGES = 8;
const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;

interface PreviewGroup {
  urls: string[];
  imageCount: number;
  byteSize: number;
}

interface SessionImagePreviewRegistryOptions {
  maxImages?: number;
  maxBytes?: number;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

export type SessionImagePreviewSnapshot = Readonly<Record<string, readonly string[]>>;

export function sessionImagePreviewKey(threadId: string, turnId: string): string {
  return JSON.stringify([threadId, turnId]);
}

export class SessionImagePreviewRegistry {
  readonly #entries = new Map<string, PreviewGroup>();
  readonly #maxImages: number;
  readonly #maxBytes: number;
  readonly #createObjectURL: (blob: Blob) => string;
  readonly #revokeObjectURL: (url: string) => void;
  #imageCount = 0;
  #byteSize = 0;

  constructor(options: SessionImagePreviewRegistryOptions = {}) {
    this.#maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#createObjectURL = options.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
    this.#revokeObjectURL = options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));
  }

  remember(key: string, blobs: readonly Blob[]): SessionImagePreviewSnapshot {
    if (blobs.length === 0) return this.snapshot();

    const urls: string[] = [];
    try {
      for (const blob of blobs) urls.push(this.#createObjectURL(blob));
    } catch {
      this.#revokeUrls(urls);
      return this.snapshot();
    }

    this.#remove(key);
    const group: PreviewGroup = {
      urls,
      imageCount: blobs.length,
      byteSize: blobs.reduce((total, blob) => total + blob.size, 0),
    };
    this.#entries.set(key, group);
    this.#imageCount += group.imageCount;
    this.#byteSize += group.byteSize;

    while (this.#imageCount > this.#maxImages || this.#byteSize > this.#maxBytes) {
      const oldestKey = this.#entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.#remove(oldestKey);
    }
    return this.snapshot();
  }

  snapshot(): SessionImagePreviewSnapshot {
    return Object.fromEntries(
      [...this.#entries].map(([key, group]) => [key, [...group.urls]]),
    );
  }

  clear(): void {
    for (const group of this.#entries.values()) this.#revokeUrls(group.urls);
    this.#entries.clear();
    this.#imageCount = 0;
    this.#byteSize = 0;
  }

  #remove(key: string): void {
    const group = this.#entries.get(key);
    if (!group) return;
    this.#entries.delete(key);
    this.#imageCount -= group.imageCount;
    this.#byteSize -= group.byteSize;
    this.#revokeUrls(group.urls);
  }

  #revokeUrls(urls: readonly string[]): void {
    for (const url of urls) {
      try {
        this.#revokeObjectURL(url);
      } catch {
        // URL cleanup is best-effort and must not affect a submitted turn.
      }
    }
  }
}
