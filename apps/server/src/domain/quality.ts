import type { Thresholds } from "@alvip/shared";

/** Pixel-level measurements of one image (computed by pipeline/imageMetrics.ts). */
export interface ImageMetrics {
  /** False when the bytes could not be fetched at all. */
  present: boolean;
  decodable: boolean;
  decodeError?: string;
  format?: string;
  /** Which decoder read the pixels ("libheif" for HEVC HEIC photos). */
  decoder?: "sharp" | "libheif";
  width?: number;
  height?: number;
  bytes: number;
  /** 0–255 mean of the greyscale image. */
  meanLuminance?: number;
  /** Variance of the Laplacian on a ≤512px greyscale copy; low = blurry. */
  laplacianVariance?: number;
  /** Share of pixels < 16 / > 240. */
  darkFraction?: number;
  brightFraction?: number;
}

/**
 * Pixel-detectable issues. OBSTRUCTED and IRRELEVANT need scene understanding and are
 * added by the vision stage (Phase 4).
 */
export const QUALITY_ISSUES = [
  "MISSING",
  "CORRUPT",
  "UNSUPPORTED_FORMAT",
  "TOO_LARGE",
  "TOO_SMALL",
  "BLURRY",
  "TOO_DARK",
  "OVEREXPOSED",
  "OBSTRUCTED",
  "IRRELEVANT",
] as const;
export type QualityIssue = (typeof QUALITY_ISSUES)[number];

export interface QualityAssessment {
  /** 0–1, for ranking only. Not calibrated and never shown as a percentage. */
  score: number;
  usable: boolean;
  issues: QualityIssue[];
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * PRD §14. Any detected issue makes the image unusable, and unusable images can never
 * count as positive evidence (enforced by the evidence engine, Phase 5).
 */
export function assessQuality(m: ImageMetrics, t: Thresholds["quality"]): QualityAssessment {
  if (!m.present) return { score: 0, usable: false, issues: ["MISSING"] };
  if (m.bytes > t.max_image_bytes) return { score: 0, usable: false, issues: ["TOO_LARGE"] };
  if (!m.decodable) return { score: 0, usable: false, issues: ["CORRUPT"] };
  if (!m.format || !t.accepted_formats.includes(m.format)) {
    return { score: 0, usable: false, issues: ["UNSUPPORTED_FORMAT"] };
  }

  const issues: QualityIssue[] = [];
  const minDim = Math.min(m.width ?? 0, m.height ?? 0);
  const lap = m.laplacianVariance ?? 0;
  const mean = m.meanLuminance ?? 0;

  if (minDim < t.min_dimension_px) issues.push("TOO_SMALL");
  if (lap < t.blur_laplacian_variance_min) issues.push("BLURRY");
  if (mean < t.dark_mean_luminance_max) issues.push("TOO_DARK");
  if (mean > t.bright_mean_luminance_min) issues.push("OVEREXPOSED");

  // Each component is 0.5 exactly at its threshold and 1 when comfortably clear of it.
  const sharpness = clamp01(lap / (2 * t.blur_laplacian_variance_min));
  const resolution = clamp01(minDim / (2 * t.min_dimension_px));
  const exposure =
    mean < t.dark_mean_luminance_max
      ? clamp01((mean / t.dark_mean_luminance_max) * 0.5)
      : mean > t.bright_mean_luminance_min
        ? clamp01(((255 - mean) / (255 - t.bright_mean_luminance_min)) * 0.5)
        : 1;
  const score = round3(sharpness * resolution * exposure);

  return { score, usable: issues.length === 0 && score >= t.min_usable_score, issues };
}
