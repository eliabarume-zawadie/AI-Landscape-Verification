/**
 * Fetches image bytes for a locator returned by the source system (PRD §13).
 * The vision engine never talks to NetSuite or URLs directly.
 */
export interface ImageProvider {
  readonly name: string;
  fetch(locator: string, opts?: { signal?: AbortSignal }): Promise<FetchedImage>;
}

export interface FetchedImage {
  bytes: Buffer;
  /** Content type reported by the source; format is still verified by decoding. */
  contentType?: string;
  /** Metadata supplied by the source (e.g. EXIF-derived capture time), if any. */
  metadata?: Record<string, unknown>;
}

export class ImageFetchError extends Error {
  override name = "ImageFetchError";
  constructor(
    message: string,
    /** NOT_FOUND / FORBIDDEN are permanent; TRANSIENT may be retried. */
    readonly kind: "NOT_FOUND" | "FORBIDDEN" | "TRANSIENT",
  ) {
    super(message);
  }
}
