import type { Thresholds } from "@alvip/shared";

/**
 * Before/after stage of each photo (PRD §18).
 *
 * SAFETY: stage is derived ONLY from metadata (filename, capture time) — never from
 * what the photo shows. Inferring "before" from "looks unmowed" would turn genuine
 * counter-evidence into baseline. Upload order is never used: adjacent photos are not
 * assumed to be before/after.
 */
export type PhotoStage = "BEFORE" | "AFTER" | "DURING" | "UNKNOWN";

export interface StageInput {
  imageId: string;
  filename: string | null;
  capturedAt: Date | null;
}

export interface StageResult {
  stage: PhotoStage;
  /** STRONG = filename and capture time agree; SINGLE = one signal; NONE = unknown. */
  certainty: "STRONG" | "SINGLE" | "NONE";
  signals: { filename: PhotoStage | null; time: "BEFORE" | "AFTER" | null; conflict: boolean };
}

const BEFORE_WORDS = new Set(["before", "pre", "prior", "initial"]);
const AFTER_WORDS = new Set(["after", "post", "done", "complete", "completed", "finished", "final"]);
const DURING_WORDS = new Set(["during", "progress", "inprogress", "wip"]);

/** Filename keyword signal. Tokens split on anything non-alphanumeric (so "lawn_before_01" works). */
export function stageFromFilename(filename: string | null): PhotoStage | null {
  if (!filename) return null;
  const tokens = filename
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const before = tokens.some((t) => BEFORE_WORDS.has(t));
  const after = tokens.some((t) => AFTER_WORDS.has(t));
  const during = tokens.some((t) => DURING_WORDS.has(t));
  if ([before, after, during].filter(Boolean).length !== 1) return null; // none or ambiguous
  return before ? "BEFORE" : after ? "AFTER" : "DURING";
}

/**
 * Capture-time signal: only when the visit's timeline has ONE dominant gap (two bursts).
 * Interleaved shooting (before A, after A, before B, …) has no dominant gap → no signal.
 */
export function stagesFromTimes(inputs: readonly StageInput[], t: Thresholds["pairing"]): Map<string, "BEFORE" | "AFTER"> {
  const timed = inputs.filter((i) => i.capturedAt).sort((a, b) => a.capturedAt!.getTime() - b.capturedAt!.getTime());
  const result = new Map<string, "BEFORE" | "AFTER">();
  if (timed.length < 2) return result;

  const gaps = timed.slice(1).map((x, i) => ({ at: i + 1, minutes: (x.capturedAt!.getTime() - timed[i]!.capturedAt!.getTime()) / 60_000 }));
  const sorted = [...gaps].sort((a, b) => b.minutes - a.minutes);
  const largest = sorted[0]!;
  const second = sorted[1]?.minutes ?? 0;
  const dominant = largest.minutes >= t.min_time_gap_minutes && largest.minutes >= t.time_gap_dominance_ratio * Math.max(second, 1e-9);
  if (!dominant) return result;

  timed.forEach((x, i) => result.set(x.imageId, i < largest.at ? "BEFORE" : "AFTER"));
  return result;
}

export function classifyStages(inputs: readonly StageInput[], t: Thresholds["pairing"]): Map<string, StageResult> {
  const byTime = stagesFromTimes(inputs, t);
  const out = new Map<string, StageResult>();
  for (const i of inputs) {
    const name = stageFromFilename(i.filename);
    const time = byTime.get(i.imageId) ?? null;
    const signals = { filename: name, time, conflict: false };

    if (name === "DURING") {
      out.set(i.imageId, { stage: "DURING", certainty: "SINGLE", signals });
    } else if (name && time && name !== time) {
      out.set(i.imageId, { stage: "UNKNOWN", certainty: "NONE", signals: { ...signals, conflict: true } });
    } else if (name && time) {
      out.set(i.imageId, { stage: name, certainty: "STRONG", signals });
    } else if (name || time) {
      out.set(i.imageId, { stage: (name ?? time)!, certainty: "SINGLE", signals });
    } else {
      out.set(i.imageId, { stage: "UNKNOWN", certainty: "NONE", signals });
    }
  }
  return out;
}
