import type { Thresholds } from "@alvip/shared";

export interface DedupInput {
  imageId: string;
  ordinal: number | null;
  /** Null when the image could not be fetched. */
  sha256: string | null;
  /** 64-bit difference hash, 16 hex chars. Null when not decodable. */
  dhash: string | null;
  /** 32×32 greyscale thumbnail (1024 bytes). Null when not decodable. */
  fingerprint: Uint8Array | null;
  usable: boolean;
  qualityScore: number;
}

export interface DedupResult {
  imageId: string;
  /** Representative image ID of the cluster. */
  groupId: string;
  isRepresentative: boolean;
  duplicateKind: "EXACT" | "NEAR" | null;
}

export interface DedupSummary {
  results: Map<string, DedupResult>;
  /** Distinct clusters among images that have content. */
  uniqueCount: number;
  exactDuplicates: number;
  nearDuplicates: number;
}

export function hammingHex64(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / a.length;
}

/** Both signals must agree: same structure (dHash) AND nearly identical pixels (MAD). */
export function isNearDuplicate(a: DedupInput, b: DedupInput, t: Thresholds["duplicates"]): boolean {
  if (!a.dhash || !b.dhash || !a.fingerprint || !b.fingerprint) return false;
  if (hammingHex64(a.dhash, b.dhash) > t.near_duplicate_hamming_max) return false;
  return meanAbsDiff(a.fingerprint, b.fingerprint) <= t.near_duplicate_mad_max;
}

/**
 * Cluster exact (same SHA-256) and near duplicates (PRD §15). Each cluster counts as ONE
 * piece of evidence; the representative is the best usable image. Nothing is deleted —
 * reviewers can still see every image.
 */
export function dedupe(inputs: readonly DedupInput[], t: Thresholds["duplicates"]): DedupSummary {
  const parent = new Map(inputs.map((i) => [i.imageId, i.imageId]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const withContent = inputs.filter((i) => i.sha256 !== null);
  const bySha = new Map<string, string>();
  for (const i of withContent) {
    const first = bySha.get(i.sha256!);
    if (first) union(first, i.imageId);
    else bySha.set(i.sha256!, i.imageId);
  }
  for (let x = 0; x < withContent.length; x++) {
    for (let y = x + 1; y < withContent.length; y++) {
      const a = withContent[x]!;
      const b = withContent[y]!;
      if (find(a.imageId) !== find(b.imageId) && isNearDuplicate(a, b, t)) union(a.imageId, b.imageId);
    }
  }

  const clusters = new Map<string, DedupInput[]>();
  for (const i of inputs) {
    const root = find(i.imageId);
    clusters.set(root, [...(clusters.get(root) ?? []), i]);
  }

  const results = new Map<string, DedupResult>();
  let exactDuplicates = 0;
  let nearDuplicates = 0;
  let uniqueCount = 0;
  for (const members of clusters.values()) {
    const rep = [...members].sort(compareRepresentative)[0]!;
    if (rep.sha256 !== null) uniqueCount++;
    for (const m of members) {
      const isRep = m.imageId === rep.imageId;
      const kind = isRep ? null : m.sha256 === rep.sha256 ? "EXACT" : "NEAR";
      if (kind === "EXACT") exactDuplicates++;
      if (kind === "NEAR") nearDuplicates++;
      results.set(m.imageId, { imageId: m.imageId, groupId: rep.imageId, isRepresentative: isRep, duplicateKind: kind });
    }
  }
  return { results, uniqueCount, exactDuplicates, nearDuplicates };
}

/** Usable first, then higher quality, then earlier in the submission, then ID (stable). */
function compareRepresentative(a: DedupInput, b: DedupInput): number {
  return (
    Number(b.usable) - Number(a.usable) ||
    b.qualityScore - a.qualityScore ||
    (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER) ||
    a.imageId.localeCompare(b.imageId)
  );
}
