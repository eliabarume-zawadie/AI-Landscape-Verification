import { z } from "zod";
import type { ServiceRegistry } from "./serviceRegistry";

/**
 * What a vision model may report about ONE image (PRD §16–17, §59).
 *
 * Observations only: there is deliberately no field for a service status, confidence
 * level, recommendation, or approval. Those are computed by the evidence and risk
 * engines from validated observations.
 */
export const AI_VISIBILITY_ISSUES = ["OBSTRUCTED", "TOO_DISTANT", "IRRELEVANT"] as const;
export type AiVisibilityIssue = (typeof AI_VISIBILITY_ISSUES)[number];

const rawObservation = z.object({
  service: z.string(),
  evidence_type: z.string(),
  strength: z.number(),
  description: z.string(),
});

/** Structural schema of a provider response (validated before any business rules). */
export const imageAnalysisOutputSchema = z.object({
  image_relevant: z.boolean(),
  visibility_issues: z.array(z.enum(AI_VISIBILITY_ISSUES)),
  scene_summary: z.string(),
  observations: z.array(rawObservation),
  not_assessable: z.array(z.object({ service: z.string(), reason: z.string() })),
});
export type ImageAnalysisOutput = z.infer<typeof imageAnalysisOutputSchema>;

export interface Observation {
  service: string;
  evidenceType: string;
  polarity: "positive" | "negative" | "context";
  /** Model-reported, 0–1, uncalibrated. Never shown to users as a percentage. */
  strength: number;
  description: string;
}

export interface ValidatedImageAnalysis {
  relevant: boolean;
  visibilityIssues: AiVisibilityIssue[];
  sceneSummary: string;
  observations: Observation[];
  notAssessable: { service: string; reason: string }[];
}

export type ValidationResult =
  | { ok: true; value: ValidatedImageAnalysis; warnings: string[] }
  | { ok: false; error: string };

const MAX_TEXT = 500;

/**
 * Validate a provider response against the structural schema AND the active service
 * registry. Entries that break business rules are dropped (with a warning) rather than
 * trusted: unknown or unrequested services, evidence types not defined for that service
 * (likely hallucinated categories), out-of-range strengths, and any evidence claimed
 * for an image the model itself marked irrelevant. A response that is not structurally
 * valid is rejected as a whole.
 */
export function validateImageAnalysis(
  raw: unknown,
  ctx: { registry: ServiceRegistry; requestedServices: readonly string[] },
): ValidationResult {
  const parsed = imageAnalysisOutputSchema.safeParse(typeof raw === "string" ? safeJson(raw) : raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }
  const out = parsed.data;
  const warnings: string[] = [];
  const requested = new Set(ctx.requestedServices);
  const best = new Map<string, Observation>();

  for (const o of out.observations) {
    const where = `${o.service}/${o.evidence_type}`;
    if (!requested.has(o.service) || !ctx.registry.has(o.service)) {
      warnings.push(`dropped ${where}: service not requested`);
      continue;
    }
    const def = ctx.registry.get(o.service).evidence_types.find((e) => e.type === o.evidence_type);
    if (!def) {
      warnings.push(`dropped ${where}: evidence type not defined for this service`);
      continue;
    }
    if (!Number.isFinite(o.strength) || o.strength < 0 || o.strength > 1) {
      warnings.push(`dropped ${where}: strength ${o.strength} outside 0–1`);
      continue;
    }
    if (!o.description.trim()) {
      warnings.push(`dropped ${where}: no description of what is visible`);
      continue;
    }
    if (!out.image_relevant) {
      warnings.push(`dropped ${where}: image marked irrelevant`);
      continue;
    }
    const key = `${o.service}:${o.evidence_type}`;
    const prev = best.get(key);
    if (!prev || o.strength > prev.strength) {
      best.set(key, {
        service: o.service,
        evidenceType: o.evidence_type,
        polarity: def.polarity,
        strength: o.strength,
        description: o.description.trim().slice(0, MAX_TEXT),
      });
    }
  }

  const visibilityIssues = [...new Set(out.visibility_issues)];
  if (!out.image_relevant && !visibilityIssues.includes("IRRELEVANT")) visibilityIssues.push("IRRELEVANT");

  return {
    ok: true,
    warnings,
    value: {
      relevant: out.image_relevant,
      visibilityIssues,
      sceneSummary: out.scene_summary.trim().slice(0, MAX_TEXT),
      observations: [...best.values()],
      notAssessable: out.not_assessable
        .filter((n) => requested.has(n.service))
        .map((n) => ({ service: n.service, reason: n.reason.trim().slice(0, MAX_TEXT) })),
    },
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { __unparseable: s.slice(0, 200) };
  }
}

/**
 * JSON Schema sent to providers that support structured output. Enums restrict
 * services/evidence types to what was requested; pairing validity is still checked
 * by validateImageAnalysis.
 */
export function imageAnalysisJsonSchema(registry: ServiceRegistry, services: readonly string[]): Record<string, unknown> {
  const evidenceTypes = [...new Set(services.flatMap((s) => registry.get(s).evidence_types.map((e) => e.type)))].sort();
  const serviceEnum = [...services].sort();
  return {
    type: "object",
    additionalProperties: false,
    required: ["image_relevant", "visibility_issues", "scene_summary", "observations", "not_assessable"],
    properties: {
      image_relevant: { type: "boolean" },
      visibility_issues: { type: "array", items: { type: "string", enum: [...AI_VISIBILITY_ISSUES] } },
      scene_summary: { type: "string" },
      observations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["service", "evidence_type", "strength", "description"],
          properties: {
            service: { type: "string", enum: serviceEnum },
            evidence_type: { type: "string", enum: evidenceTypes },
            strength: { type: "number" },
            description: { type: "string" },
          },
        },
      },
      not_assessable: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["service", "reason"],
          properties: { service: { type: "string", enum: serviceEnum }, reason: { type: "string" } },
        },
      },
    },
  };
}
