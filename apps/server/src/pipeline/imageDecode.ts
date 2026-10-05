import decodeHeic from "heic-decode";
import sharp, { type Metadata, type Sharp } from "sharp";

/**
 * Open image bytes for processing.
 *
 * sharp's prebuilt binaries read HEIF headers but cannot decode HEVC-compressed HEIC,
 * which is the default iPhone photo format (plan A15, verified with a real file). For
 * those files we decode with libheif (WebAssembly, via heic-decode) and hand sharp the
 * raw pixels. Everything else goes straight through sharp.
 */
export interface OpenedImage {
  /** Fresh sharp pipeline over the (decoded) image, EXIF/HEIF orientation applied. */
  image(): Sharp;
  format: string;
  width: number;
  height: number;
  decoder: "sharp" | "libheif";
}

export class ImageDecodeError extends Error {
  override name = "ImageDecodeError";
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

/** True when the ISO-BMFF `ftyp` box declares a HEIF/HEIC brand. */
export function hasHeifBrand(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ascii = (from: number) => String.fromCharCode(...bytes.subarray(from, from + 4));
  return ascii(4) === "ftyp" && HEIF_BRANDS.has(ascii(8));
}

/** Limits concurrent HEVC decodes: each full-size iPhone photo needs ~48 MB of RGBA. */
class Semaphore {
  private waiting: (() => void)[] = [];
  constructor(private available: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available > 0) this.available--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.available++;
    }
  }
}
const heicSlots = new Semaphore(2);

export type HeicDecoder = (bytes: Buffer) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
const defaultHeicDecoder: HeicDecoder = (bytes) => decodeHeic({ buffer: bytes });

export async function openImage(
  bytes: Buffer,
  opts: { maxInputPixels: number; heicDecoder?: HeicDecoder },
): Promise<OpenedImage> {
  const fromBytes = () => sharp(bytes, { failOn: "warning", limitInputPixels: opts.maxInputPixels });

  let meta: Metadata;
  try {
    meta = await fromBytes().metadata();
  } catch (err) {
    throw new ImageDecodeError((err as Error).message);
  }

  const heif = meta.format === "heif" || hasHeifBrand(bytes);
  if (!heif || meta.compression === "av1") {
    // Normal path; a full decode is attempted by the caller's pipeline.
    return {
      image: () => fromBytes().rotate(),
      format: meta.format ?? "unknown",
      width: orientedWidth(meta),
      height: orientedHeight(meta),
      decoder: "sharp",
    };
  }

  // HEVC HEIC: check the pixel budget from the header before allocating anything.
  if ((meta.width ?? 0) * (meta.height ?? 0) > opts.maxInputPixels) {
    throw new ImageDecodeError(`Input image exceeds pixel limit (${meta.width}x${meta.height})`);
  }
  let decoded: Awaited<ReturnType<HeicDecoder>>;
  try {
    decoded = await heicSlots.run(() => (opts.heicDecoder ?? defaultHeicDecoder)(bytes));
  } catch (err) {
    throw new ImageDecodeError(`HEIC decode failed: ${(err as Error)?.message ?? String(err)}`);
  }
  const raw = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
  // libheif applies HEIF rotation/mirroring itself, so no extra rotate() here.
  return {
    image: () => sharp(raw, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }),
    format: "heif",
    width: decoded.width,
    height: decoded.height,
    decoder: "libheif",
  };
}

const swaps = (m: Metadata) => (m.orientation ?? 1) >= 5;
const orientedWidth = (m: Metadata) => (swaps(m) ? m.height : m.width) ?? 0;
const orientedHeight = (m: Metadata) => (swaps(m) ? m.width : m.height) ?? 0;
