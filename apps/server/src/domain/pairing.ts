import type { Thresholds } from "@alvip/shared";

/**
 * Before/after candidate generation (PRD §18). Candidates are only PROPOSALS: a pair is
 * accepted only after the vision model confirms both photos show the same area.
 * Visual similarity here just decides which combinations are worth paying to check.
 */

export interface PairableImage {
  imageId: string;
  ref: string;
  /** 32×32 greyscale thumbnail (row-major), or null when unavailable. */
  fingerprint: Uint8Array | null;
  /** 64-bin colour histogram (0–255 per bin), or null when unavailable. */
  colorHist: Uint8Array | null;
}

export interface PairCandidate {
  beforeId: string;
  afterId: string;
  /** Lower = more similar: colour-histogram L1 + structure_weight × structural distance. */
  distance: number;
  /** 1 = closest after-photo for this before-photo. */
  rank: number;
}

const SIDE = 32;

/**
 * Mean absolute difference between two 32×32 thumbnails, each mean-normalised (so a
 * lighter "after" lawn does not dominate), minimised over small shifts (camera moved a
 * little between shots). Requires ≥ 50% overlap.
 */
export function shiftedDistance(a: Uint8Array, b: Uint8Array, maxShift = 6): number {
  if (a.length !== SIDE * SIDE || b.length !== SIDE * SIDE) return Number.POSITIVE_INFINITY;
  const ma = mean(a);
  const mb = mean(b);
  let best = Number.POSITIVE_INFINITY;
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let sum = 0;
      let n = 0;
      for (let y = Math.max(0, -dy); y < Math.min(SIDE, SIDE - dy); y++) {
        for (let x = Math.max(0, -dx); x < Math.min(SIDE, SIDE - dx); x++) {
          sum += Math.abs(a[y * SIDE + x]! - ma - (b[(y + dy) * SIDE + (x + dx)]! - mb));
          n++;
        }
      }
      if (n >= (SIDE * SIDE) / 2) best = Math.min(best, sum / n);
    }
  }
  return best;
}

/** Colour palette (shift-invariant) plus a little structure. Calibrated on mock scenes only. */
export function combinedDistance(a: PairableImage, b: PairableImage, structureWeight: number): number {
  if (!a.colorHist || !b.colorHist || !a.fingerprint || !b.fingerprint) return Number.POSITIVE_INFINITY;
  let l1 = 0;
  for (let i = 0; i < a.colorHist.length; i++) l1 += Math.abs(a.colorHist[i]! - b.colorHist[i]!);
  return l1 / 255 + structureWeight * shiftedDistance(a.fingerprint, b.fingerprint);
}

function mean(v: Uint8Array): number {
  let s = 0;
  for (const x of v) s += x;
  return s / v.length;
}

/**
 * All before×after combinations when there are few; otherwise the K visually closest
 * after-photos per before-photo. Ordered best-first within each before-photo.
 */
export function pairCandidates(
  befores: readonly PairableImage[],
  afters: readonly PairableImage[],
  t: Thresholds["pairing"],
): PairCandidate[] {
  const all = befores.length * afters.length;
  const perBefore = all <= t.max_full_pairs ? afters.length : t.candidates_per_before;
  const out: PairCandidate[] = [];
  for (const b of befores) {
    const ranked = afters
      .map((a) => ({
        afterId: a.imageId,
        distance: combinedDistance(b, a, t.structure_weight),
        ref: a.ref,
      }))
      .sort((x, y) => x.distance - y.distance || x.ref.localeCompare(y.ref))
      .slice(0, perBefore);
    ranked.forEach((r, i) => out.push({ beforeId: b.imageId, afterId: r.afterId, distance: round2(r.distance), rank: i + 1 }));
  }
  return out;
}

const round2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
