import { asc, eq } from "drizzle-orm";
import type { ClientProfile } from "@alvip/shared";
import { recordAudit, type Actor } from "../../audit/audit";
import type { ActiveConfig } from "../../config/configStore";
import { contradictions, evidence, imageAnalysis, images, serviceAssessments } from "../../db/schema";
import { assessLocation, type EvidenceImage, type ServiceAssessment, type StageInputs } from "../../domain/evidence";
import type { ValidatedImageAnalysis } from "../../domain/observations";
import { resolveServiceRules, type ServiceRegistry } from "../../domain/serviceRegistry";
import type { JobContext } from "../jobHandler";

/** Services the vision model must look for: required services plus their components. */
export function servicesToObserve(registry: ServiceRegistry, profile: ClientProfile, required: readonly string[]): string[] {
  const all = new Set(required);
  for (const s of required) for (const c of resolveServiceRules(registry, profile, s).requiredComponents) all.add(c);
  return [...all].sort();
}

/** Load a run's per-image analysis in the shape the evidence engine needs. */
export async function loadEvidenceImages(ctx: Pick<JobContext, "db">, runId: string): Promise<EvidenceImage[]> {
  const rows = await ctx.db
    .select({
      imageId: images.id,
      ref: images.externalRef,
      ordinal: images.ordinal,
      usable: imageAnalysis.usable,
      isRep: imageAnalysis.isDuplicateRepresentative,
      group: imageAnalysis.duplicateGroup,
      status: imageAnalysis.analysisStatus,
      observations: imageAnalysis.observations,
    })
    .from(imageAnalysis)
    .innerJoin(images, eq(images.id, imageAnalysis.imageId))
    .where(eq(imageAnalysis.runId, runId))
    .orderBy(asc(images.ordinal), asc(images.externalRef));

  return rows.map((r) => {
    const v = r.observations as ValidatedImageAnalysis | null;
    return {
      imageId: r.imageId,
      ref: r.ref,
      ordinal: r.ordinal,
      usable: r.usable ?? false,
      isRepresentative: r.isRep ?? false,
      duplicateGroup: r.group ?? r.imageId,
      analysisStatus: r.status,
      observations: v?.observations ?? [],
      notAssessable: v?.notAssessable ?? [],
    };
  });
}

/**
 * PRD §19: one assessment per required service, with its supporting, contradicting and
 * context evidence and any contradictions, persisted per run.
 */
export async function runEvidenceStage(
  ctx: JobContext,
  input: {
    locationId: string;
    runId: string;
    services: string[];
    config: ActiveConfig;
    profile: ClientProfile;
    stage: StageInputs;
    actor: Actor;
  },
): Promise<ServiceAssessment[]> {
  const evidenceImages = await loadEvidenceImages(ctx, input.runId);
  const assessments = assessLocation(
    { registry: input.config.registry, profile: input.profile, thresholds: input.config.thresholds, images: evidenceImages, stage: input.stage },
    input.services,
  );

  await ctx.db.transaction(async (tx) => {
    for (const a of assessments) {
      await tx.insert(serviceAssessments).values({
        runId: input.runId,
        serviceCode: a.service,
        status: a.status,
        confidenceLevel: a.confidence,
        internalScore: a.internalScore,
        humanRequired: a.humanRequired,
        reasons: a.reasons,
        explanation: a.explanation,
        components: a.components ?? null,
      });
      const rows = [
        ...a.supporting.map((i) => ({ i, role: "SUPPORTING" as const })),
        ...a.contradicting.map((i) => ({ i, role: "CONTRADICTING" as const })),
        ...a.context.map((i) => ({ i, role: "CONTEXT" as const })),
      ];
      if (rows.length > 0) {
        await tx.insert(evidence).values(
          rows.map(({ i, role }) => ({
            runId: input.runId,
            serviceCode: a.service,
            imageId: i.imageId,
            imagePairId: i.imagePairId ?? null,
            role,
            evidenceType: i.evidenceType,
            strength: i.strength,
            observation: i.description,
          })),
        );
      }
      if (a.contradictions.length > 0) {
        await tx.insert(contradictions).values(
          a.contradictions.map((c) => ({
            runId: input.runId,
            serviceCode: a.service,
            supportingImageId: c.supporting.imageId,
            contradictingImageId: c.contradicting.imageId,
            description: c.description,
          })),
        );
      }
    }
    await recordAudit(tx, {
      eventType: "EVIDENCE_GENERATED",
      actor: input.actor,
      locationId: input.locationId,
      runId: input.runId,
      data: {
        services: Object.fromEntries(assessments.map((a) => [a.service, { status: a.status, confidence: a.confidence, humanRequired: a.humanRequired, reasons: a.reasons }])),
        contradictions: assessments.reduce((n, a) => n + a.contradictions.length, 0),
        thresholdsVersion: input.config.thresholds.version,
        stageInputs: {
          beforeAfterEvaluated: input.stage.beforeAfterEstablished !== undefined,
          beforeAfterEstablished: input.stage.beforeAfterEstablished ? [...input.stage.beforeAfterEstablished].sort() : null,
          sceneCoverageEvaluated: input.stage.distinctScenes !== undefined,
          distinctAreas: input.stage.distinctScenes ?? null,
          baselineBeforePhotos: input.stage.beforeImageIds?.size ?? 0,
        },
      },
    });
  });
  return assessments;
}
