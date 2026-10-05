import { z } from "zod";

/** Lower snake-case identifier, e.g. "mowing", "maintained_lawn". */
export const codeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "must be lower_snake_case");

const unitInterval = z.number().min(0).max(1);

/**
 * An evidence type the vision model is allowed to report for a service.
 * polarity:
 *   positive — can support the service
 *   negative — challenges the service (feeds contradiction detection)
 *   context  — informative only, never support on its own
 */
export const evidenceTypeSchema = z.object({
  type: codeSchema,
  description: z.string().min(1),
  polarity: z.enum(["positive", "negative", "context"]),
});
export type EvidenceTypeDefinition = z.infer<typeof evidenceTypeSchema>;

export const serviceDefinitionSchema = z
  .object({
    code: codeSchema,
    display_name: z.string().min(1),
    description: z.string().min(1),
    requires_before_after: z.boolean(),
    /** PRD §61: some services (fertilization) default to human review. */
    default_human_review: z.boolean().default(false),
    /** Provisional until calibrated (PRD §33). */
    minimum_confidence_for_assistance: unitInterval,
    /**
     * Contradictions always require a human (PRD §25). Kept as a field to
     * match the PRD's service model, but it cannot be configured off.
     */
    requires_human_if_contradiction: z.literal(true).default(true),
    evidence_types: z.array(evidenceTypeSchema).min(1),
    /**
     * Evidence types that may appear but can never support the service by
     * themselves (e.g. equipment_present, healthy_lawn_appearance).
     */
    insufficient_alone: z.array(codeSchema).default([]),
    /** Plain-language guardrails injected into vision prompts. */
    safety_notes: z.array(z.string().min(1)).default([]),
    /**
     * For broad services (landscape maintenance, PRD §63): the observable
     * component checks it decomposes into. Client profiles choose which are
     * required.
     */
    components: z.array(codeSchema).optional(),
  })
  .superRefine((svc, ctx) => {
    const types = new Set(svc.evidence_types.map((e) => e.type));
    if (types.size !== svc.evidence_types.length) {
      ctx.addIssue({ code: "custom", message: `${svc.code}: duplicate evidence type` });
    }
    for (const t of svc.insufficient_alone) {
      if (!types.has(t)) {
        ctx.addIssue({
          code: "custom",
          message: `${svc.code}: insufficient_alone references unknown evidence type "${t}"`,
        });
      }
    }
    if (!svc.evidence_types.some((e) => e.polarity === "positive") && !svc.components) {
      ctx.addIssue({
        code: "custom",
        message: `${svc.code}: needs at least one positive evidence type or components`,
      });
    }
  });
export type ServiceDefinition = z.infer<typeof serviceDefinitionSchema>;

export const serviceRuleSetSchema = z
  .object({
    version: z.string().min(1),
    services: z.array(serviceDefinitionSchema).min(1),
  })
  .superRefine((set, ctx) => {
    const codes = new Set<string>();
    for (const s of set.services) {
      if (codes.has(s.code)) {
        ctx.addIssue({ code: "custom", message: `duplicate service code "${s.code}"` });
      }
      codes.add(s.code);
    }
    for (const s of set.services) {
      for (const c of s.components ?? []) {
        if (!codes.has(c)) {
          ctx.addIssue({
            code: "custom",
            message: `${s.code}: component "${c}" is not a defined service`,
          });
        }
      }
    }
  });
export type ServiceRuleSet = z.infer<typeof serviceRuleSetSchema>;

export const serviceOverrideSchema = z.object({
  requires_before_after: z.boolean().optional(),
  minimum_confidence_for_assistance: unitInterval.optional(),
  always_human_review: z.boolean().optional(),
  /** For decomposed services: which components this client requires. */
  required_components: z.array(codeSchema).optional(),
  notes: z.string().optional(),
});
export type ServiceOverride = z.infer<typeof serviceOverrideSchema>;

export const clientProfileSchema = z.object({
  client: z.string().min(1),
  display_name: z.string().min(1),
  /** Default services when the work item itself does not specify any. */
  required_services: z.array(codeSchema).default([]),
  /** Applies to every service unless overridden per service. */
  before_after_required: z.boolean().optional(),
  /** Safety invariant (PRD §60, master prompt §53): cannot be disabled. */
  equipment_alone_is_insufficient: z.literal(true).default(true),
  always_human_review: z.boolean().default(false),
  image_requirements: z
    .object({
      min_usable_images: z.number().int().min(0).optional(),
      min_distinct_scenes: z.number().int().min(0).optional(),
    })
    .default({}),
  service_overrides: z.record(codeSchema, serviceOverrideSchema).default({}),
  priority: z.number().int().default(0),
  /** True until the business confirms these rules (unknown U7). */
  provisional: z.boolean().default(true),
});
export type ClientProfile = z.infer<typeof clientProfileSchema>;

/** All numeric business thresholds live here, versioned and flagged provisional. */
export const thresholdsSchema = z
  .object({
    version: z.string().min(1),
    provisional: z.boolean(),
    confidence_bands: z.object({ high: unitInterval, medium: unitInterval }),
    quality: z.object({
      min_usable_score: unitInterval,
      blur_laplacian_variance_min: z.number().positive(),
      dark_mean_luminance_max: z.number().min(0).max(255),
      bright_mean_luminance_min: z.number().min(0).max(255),
      min_dimension_px: z.number().int().positive(),
      /** Decoded formats accepted as evidence (sharp format names). */
      accepted_formats: z.array(z.string().min(1)).min(1),
      max_image_bytes: z.number().int().positive(),
      /** Decompression-bomb guard. */
      max_input_pixels: z.number().int().positive(),
    }),
    duplicates: z.object({
      /** Candidate filter: structural (dHash) distance, 0–64. */
      near_duplicate_hamming_max: z.number().int().min(0).max(64),
      /**
       * Confirmation: mean absolute pixel difference of 32×32 greyscale thumbnails (0–255).
       * Both signals must agree, so before/after photos of the same scene are not merged.
       */
      near_duplicate_mad_max: z.number().min(0).max(255),
    }),
    risk: z.object({ medium_at: unitInterval, high_at: unitInterval }),
    metrics: z.object({ min_sample_size: z.number().int().positive() }),
  })
  .superRefine((t, ctx) => {
    if (t.confidence_bands.medium >= t.confidence_bands.high) {
      ctx.addIssue({ code: "custom", message: "confidence_bands.medium must be < high" });
    }
    if (t.risk.medium_at >= t.risk.high_at) {
      ctx.addIssue({ code: "custom", message: "risk.medium_at must be < high_at" });
    }
    if (t.quality.dark_mean_luminance_max >= t.quality.bright_mean_luminance_min) {
      ctx.addIssue({ code: "custom", message: "dark max must be below bright min" });
    }
  });
export type Thresholds = z.infer<typeof thresholdsSchema>;
