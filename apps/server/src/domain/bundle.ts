import type { ServiceAssessmentStatus, Thresholds } from "@alvip/shared";
import type { EvidenceItem, ServiceAssessment } from "./evidence";

/**
 * Evidence Bundler (PRD §20–23). Picks the smallest useful set of images for the
 * reviewer, strongest first, while every image stays available.
 *
 * Safety rules:
 *  - Images in a contradiction, and images with significant counter-evidence, are ALWAYS
 *    in the bundle. A bundle must never hide the evidence against a service.
 *  - The before/after pair that established a service is always included.
 *  - The size cap only trims optional images.
 * Scores order images; they are internal and never shown as numbers.
 */

export interface BundleImage {
  imageId: string;
  ref: string;
  usable: boolean;
  isRepresentative: boolean;
  duplicateGroup: string;
  qualityScore: number;
}

export interface BundlePair {
  pairId: string;
  beforeId: string;
  afterId: string;
  confirmed: boolean;
  /** Services whose before/after this pair established. */
  establishes: string[];
}

export type BundleReason = "CONTRADICTION" | "COUNTER_EVIDENCE" | "BEFORE_AFTER_PAIR" | "TOP_SUPPORT" | "CONTEXT_ONLY";

export interface BundleEntry {
  imageId: string;
  ref: string;
  rank: number;
  reasons: BundleReason[];
  services: { service: string; role: "SUPPORTING" | "CONTRADICTING" | "CONTEXT" | "BEFORE" | "AFTER" }[];
}

export interface ServiceBundle {
  service: string;
  status: ServiceAssessmentStatus;
  /** Ordered image IDs for this service: contradictions, counter-evidence, pair, support, context. */
  imageIds: string[];
  pairIds: string[];
}

export interface EvidenceBundle {
  entries: BundleEntry[];
  byService: ServiceBundle[];
  /** Every image ranked for "all images, strongest first" (1 = most useful). */
  imageRanks: Map<string, number>;
  totalImages: number;
  mustIncludeCount: number;
}

const REASON_PRIORITY: BundleReason[] = ["CONTRADICTION", "COUNTER_EVIDENCE", "BEFORE_AFTER_PAIR", "TOP_SUPPORT", "CONTEXT_ONLY"];

export function buildBundle(args: {
  assessments: readonly ServiceAssessment[];
  images: readonly BundleImage[];
  pairs: readonly BundlePair[];
  thresholds: Thresholds;
}): EvidenceBundle {
  const t = args.thresholds;
  const imagesById = new Map(args.images.map((i) => [i.imageId, i]));
  const selected = new Map<string, { reasons: Set<BundleReason>; services: BundleEntry["services"]; mandatory: boolean; order: number }>();
  let order = 0;

  const add = (imageId: string, reason: BundleReason, service: string, role: BundleEntry["services"][number]["role"], mandatory: boolean) => {
    if (!imagesById.has(imageId)) return;
    const entry = selected.get(imageId) ?? { reasons: new Set<BundleReason>(), services: [], mandatory: false, order: order++ };
    entry.reasons.add(reason);
    if (!entry.services.some((s) => s.service === service && s.role === role)) entry.services.push({ service, role });
    entry.mandatory ||= mandatory;
    selected.set(imageId, entry);
  };

  // Area of an image = the confirmed pair it belongs to (unpaired images are their own area).
  const areaOf = new Map<string, string>();
  for (const p of args.pairs.filter((p) => p.confirmed)) {
    const area = areaOf.get(p.beforeId) ?? areaOf.get(p.afterId) ?? p.pairId;
    areaOf.set(p.beforeId, area);
    areaOf.set(p.afterId, area);
  }
  const area = (imageId: string) => areaOf.get(imageId) ?? imageId;

  const byService: ServiceBundle[] = [];
  const optional: { imageId: string; service: string; strength: number }[] = [];

  for (const a of [...args.assessments].sort((x, y) => x.service.localeCompare(y.service))) {
    const ids: string[] = [];
    const push = (id: string) => {
      if (!ids.includes(id)) ids.push(id);
    };

    // 1. Contradictions: both sides, always.
    for (const c of a.contradictions) {
      add(c.contradicting.imageId, "CONTRADICTION", a.service, "CONTRADICTING", true);
      add(c.supporting.imageId, "CONTRADICTION", a.service, "SUPPORTING", true);
      push(c.contradicting.imageId);
      push(c.supporting.imageId);
    }
    // 2. Significant counter-evidence, always (one per duplicate cluster).
    for (const item of onePerCluster(a.contradicting.filter((i) => i.strength >= t.evidence.counter_evidence_min_strength))) {
      add(item.imageId, "COUNTER_EVIDENCE", a.service, "CONTRADICTING", true);
      push(item.imageId);
    }
    // 3. The pair(s) that established this service: best one is enough.
    const pairs = args.pairs.filter((p) => p.confirmed && p.establishes.includes(a.service));
    const pairIds: string[] = [];
    if (pairs[0]) {
      add(pairs[0].beforeId, "BEFORE_AFTER_PAIR", a.service, "BEFORE", true);
      add(pairs[0].afterId, "BEFORE_AFTER_PAIR", a.service, "AFTER", true);
      push(pairs[0].beforeId);
      push(pairs[0].afterId);
      pairIds.push(pairs[0].pairId);
    }
    // 4. Strongest support, diversified by duplicate cluster then by area.
    const support = diversify(
      onePerCluster(a.supporting.filter((i) => !i.baseline && imagesById.get(i.imageId)?.usable)),
      area,
    );
    support.forEach((item, i) => {
      if (i < t.bundle.per_service_supporting) {
        add(item.imageId, "TOP_SUPPORT", a.service, "SUPPORTING", false);
        push(item.imageId);
      } else {
        optional.push({ imageId: item.imageId, service: a.service, strength: item.strength });
      }
    });
    // 5. No support at all → show the best context image so the reviewer sees why.
    if (support.length === 0) {
      const ctx = onePerCluster(a.context)[0];
      if (ctx) {
        add(ctx.imageId, "CONTEXT_ONLY", a.service, "CONTEXT", false);
        push(ctx.imageId);
      }
    }
    byService.push({ service: a.service, status: a.status, imageIds: ids, pairIds });
  }

  // Trim optional entries beyond the cap (mandatory ones always stay).
  const mandatory = [...selected.entries()].filter(([, e]) => e.mandatory);
  const optionalSelected = [...selected.entries()]
    .filter(([, e]) => !e.mandatory)
    .sort((x, y) => priority(x[1].reasons) - priority(y[1].reasons) || x[1].order - y[1].order);
  const room = Math.max(0, t.bundle.max_images - mandatory.length);
  const kept = [...mandatory, ...optionalSelected.slice(0, room)];
  const keptIds = new Set(kept.map(([id]) => id));
  for (const sb of byService) sb.imageIds = sb.imageIds.filter((id) => keptIds.has(id));

  const entries: BundleEntry[] = kept
    .sort((x, y) => priority(x[1].reasons) - priority(y[1].reasons) || x[1].order - y[1].order)
    .map(([imageId, e], i) => ({
      imageId,
      ref: imagesById.get(imageId)!.ref,
      rank: i + 1,
      reasons: REASON_PRIORITY.filter((r) => e.reasons.has(r)),
      services: e.services,
    }));

  return {
    entries,
    byService,
    imageRanks: rankAllImages(args.images, args.assessments, args.pairs, entries),
    totalImages: args.images.length,
    mustIncludeCount: mandatory.length,
  };
}

/** Order for the "all images" view: bundle first, then by evidence value (PRD §23). */
function rankAllImages(
  images: readonly BundleImage[],
  assessments: readonly ServiceAssessment[],
  pairs: readonly BundlePair[],
  entries: readonly BundleEntry[],
): Map<string, number> {
  const bundleRank = new Map(entries.map((e) => [e.imageId, e.rank]));
  const strongest = new Map<string, number>();
  const counter = new Set<string>();
  for (const a of assessments) {
    for (const i of [...a.supporting, ...a.contradicting]) strongest.set(i.imageId, Math.max(strongest.get(i.imageId) ?? 0, i.strength));
    for (const i of a.contradicting) counter.add(i.imageId);
  }
  const paired = new Set(pairs.filter((p) => p.confirmed).flatMap((p) => [p.beforeId, p.afterId]));

  const score = (i: BundleImage) =>
    (i.usable ? 0.2 * i.qualityScore : -1) +
    0.4 * (strongest.get(i.imageId) ?? 0) +
    (paired.has(i.imageId) ? 0.2 : 0) +
    (counter.has(i.imageId) ? 0.2 : 0) +
    (i.isRepresentative ? 0 : -0.5); // duplicates sink below their representative

  const ordered = [...images].sort((a, b) => {
    const ra = bundleRank.get(a.imageId) ?? Infinity;
    const rb = bundleRank.get(b.imageId) ?? Infinity;
    return ra - rb || score(b) - score(a) || a.ref.localeCompare(b.ref);
  });
  return new Map(ordered.map((i, n) => [i.imageId, n + 1]));
}

function onePerCluster(items: readonly EvidenceItem[]): EvidenceItem[] {
  const best = new Map<string, EvidenceItem>();
  for (const i of items) {
    const prev = best.get(i.duplicateGroup);
    if (!prev || i.strength > prev.strength) best.set(i.duplicateGroup, i);
  }
  return [...best.values()].sort((a, b) => b.strength - a.strength || a.ref.localeCompare(b.ref));
}

/** Round-robin across areas so the strongest image of each area comes before second-bests. */
function diversify(items: EvidenceItem[], area: (id: string) => string): EvidenceItem[] {
  const groups = new Map<string, EvidenceItem[]>();
  for (const i of items) groups.set(area(i.imageId), [...(groups.get(area(i.imageId)) ?? []), i]);
  const queues = [...groups.values()].sort((a, b) => b[0]!.strength - a[0]!.strength || a[0]!.ref.localeCompare(b[0]!.ref));
  const out: EvidenceItem[] = [];
  for (let round = 0; out.length < items.length; round++) {
    for (const q of queues) if (q[round]) out.push(q[round]!);
  }
  return out;
}

const priority = (reasons: Set<BundleReason>) => Math.min(...[...reasons].map((r) => REASON_PRIORITY.indexOf(r)));
