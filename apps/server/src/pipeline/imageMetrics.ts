import { createHash } from "node:crypto";
import sharp, { type Sharp } from "sharp";
import type { ImageMetrics } from "../domain/quality";
import { openImage, type HeicDecoder } from "./imageDecode";

export interface ImageFingerprints {
  sha256: string;
  /** 64-bit difference hash, 16 hex chars; null when not decodable. */
  dhash: string | null;
  /** 32×32 greyscale thumbnail; null when not decodable. */
  fingerprint: Uint8Array | null;
  /** 64-bin RGB histogram (4 levels per channel), each bin scaled to 0–255; null when not decodable. */
  colorHist: Uint8Array | null;
}

export interface AnalyzedImage {
  metrics: ImageMetrics;
  fingerprints: ImageFingerprints;
}

const ANALYSIS_MAX_SIDE = 512;

/**
 * Decode once and measure. Never throws for bad input: undecodable bytes become
 * `decodable: false` so the image is recorded as CORRUPT rather than failing the run.
 */
export async function analyzeImageBytes(
  bytes: Buffer,
  opts: { maxInputPixels: number; heicDecoder?: HeicDecoder },
): Promise<AnalyzedImage> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const base = { present: true, bytes: bytes.length } as const;
  try {
    const opened = await openImage(bytes, opts);

    // Measure on a bounded, true single-channel greyscale copy
    // (greyscale() alone keeps 3 sRGB channels).
    const { data, info } = await opened
      .image()
      .greyscale()
      .toColourspace("b-w")
      .resize({ width: ANALYSIS_MAX_SIDE, height: ANALYSIS_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 1) throw new Error(`expected 1 greyscale channel, got ${info.channels}`);

    const { mean, darkFraction, brightFraction } = luminanceStats(data);
    const laplacianVariance = laplacianVarianceOf(data, info.width, info.height);

    // Hashes come from the already-decoded greyscale copy (no further full decodes).
    const greyResize = async (w: number, h: number) => {
      const out = await sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } })
        .resize(w, h, { fit: "fill" })
        .toColourspace("b-w")
        .raw()
        .toBuffer();
      if (out.length !== w * h) throw new Error(`expected ${w * h} greyscale bytes, got ${out.length}`);
      return out;
    };
    const dhashRaw = await greyResize(9, 8);
    const fingerprint = new Uint8Array(await greyResize(32, 32));
    const colorHist = await colorHistogram(opened.image());

    return {
      metrics: {
        ...base,
        decodable: true,
        format: opened.format,
        decoder: opened.decoder,
        width: opened.width,
        height: opened.height,
        meanLuminance: round2(mean),
        laplacianVariance: round2(laplacianVariance),
        darkFraction: round2(darkFraction),
        brightFraction: round2(brightFraction),
      },
      fingerprints: { sha256, dhash: dhashFrom(dhashRaw), fingerprint, colorHist },
    };
  } catch (err) {
    return {
      metrics: { ...base, decodable: false, decodeError: (err as Error).message.slice(0, 300) },
      fingerprints: { sha256, dhash: null, fingerprint: null, colorHist: null },
    };
  }
}

/** Shift-invariant colour signature used to shortlist before/after candidates. */
async function colorHistogram(image: Sharp): Promise<Uint8Array> {
  const { data, info } = await image.resize(64, 64, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected 3 colour channels, got ${info.channels}`);
  const counts = new Float64Array(64);
  for (let i = 0; i < data.length; i += 3) counts[(data[i]! >> 6) * 16 + (data[i + 1]! >> 6) * 4 + (data[i + 2]! >> 6)]! += 1;
  const n = data.length / 3;
  return Uint8Array.from(counts, (c) => Math.round((c / n) * 255));
}

function luminanceStats(gray: Buffer) {
  let sum = 0;
  let dark = 0;
  let bright = 0;
  for (const v of gray) {
    sum += v;
    if (v < 16) dark++;
    else if (v > 240) bright++;
  }
  const n = gray.length || 1;
  return { mean: sum / n, darkFraction: dark / n, brightFraction: bright / n };
}

/** Variance of the 4-neighbour Laplacian — standard focus measure. */
export function laplacianVarianceOf(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const l = gray[i - width]! + gray[i + width]! + gray[i - 1]! + gray[i + 1]! - 4 * gray[i]!;
      sum += l;
      sumSq += l * l;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** dHash: compare each pixel to its right neighbour on a 9×8 greyscale image → 64 bits. */
function dhashFrom(raw9x8: Buffer): string {
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (raw9x8[y * 9 + x]! > raw9x8[y * 9 + x + 1]! ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

const round2 = (x: number) => Math.round(x * 100) / 100;
