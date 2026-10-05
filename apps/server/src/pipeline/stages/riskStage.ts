import { eq } from "drizzle-orm";
import type { AiRecommendation, ClientProfile, Lane } from "@alvip/shared";
import { recordAudit, type Actor } from "../../audit/audit";
import type { ActiveConfig } from "../../config/configStore";
import { imageAnalysis, riskAssessments } from "../../db/schema";
import type { ServiceAssessment } from "../../domain/evidence";
import type { QualityIssue } from "../../domain/quality";
import { assessRisk, chooseLane, recommend, type RiskResult } from "../../domain/risk";
import { resolveServiceRules } from "../../domain/serviceRegistry";
import type { JobContext } from "../jobHandler";

const UNREADABLE = new Set(["MISSING", "CORRUPT", "UNSUPPORTED_FORMAT", "TOO_LARGE"]);
const UNUSUAL = new Set(["IRRELEVANT", "OBSTRUCTED", "TOO_DISTANT"]);

/** PRD §24, §27, §36: risk level, AI recommendation and lane for a run. */
export async function runRiskStage(
  ctx: JobContext,
  input: { locationId: string; runId: string; assessments: ServiceAssessment[]; config: ActiveConfig; profile: ClientProfile; actor: Actor },
): Promise<{ risk: RiskResult; recommendation: AiRecommendation; recommendationExplanation: string; lane: Lane }> {
  const rows = await ctx.db
    .select({ usable: imageAnalysis.usable, isRep: imageAnalysis.isDuplicateRepresentative, issues: imageAnalysis.qualityIssues, status: imageAnalysis.analysisStatus })
    .from(imageAnalysis)
    .where(eq(imageAnalysis.runId, input.runId));
  const issues = (r: (typeof rows)[number]) => (r.issues as QualityIssue[]) ?? [];

  const risk = assessRisk({
    assessments: input.assessments,
    images: {
      total: rows.length,
      readable: rows.filter((r) => !issues(r).some((i) => UNREADABLE.has(i))).length,
      usable: rows.filter((r) => r.usable).length,
      duplicates: rows.filter((r) => r.isRep === false).length,
      unusualScene: rows.filter((r) => issues(r).some((i) => UNUSUAL.has(i))).length,
      analysisFailures: rows.filter((r) => r.status === "MALFORMED" || r.status === "REFUSED").length,
    },
    servicesRequiringBeforeAfter: input.assessments
      .map((a) => a.service)
      .filter((s) => resolveServiceRules(input.config.registry, input.profile, s).requiresBeforeAfter),
    clientRequiresHumanReview: input.profile.always_human_review,
    thresholds: input.config.thresholds,
  });
  const rec = recommend(input.assessments, risk);
  const lane = chooseLane({
    recommendation: rec.recommendation,
    risk: risk.level,
    automationLevel: ctx.env.AUTOMATION_LEVEL,
    shadowMode: ctx.env.SHADOW_MODE,
  });

  await ctx.db.transaction(async (tx) => {
    await tx.insert(riskAssessments).values({
      runId: input.runId,
      level: risk.level,
      internalScore: risk.internalScore,
      factors: { factors: risk.factors, recommendation: rec.recommendation, recommendationExplanation: rec.explanation, lane },
    });
    await recordAudit(tx, {
      eventType: "RISK_CALCULATED",
      actor: input.actor,
      locationId: input.locationId,
      runId: input.runId,
      data: {
        level: risk.level,
        factors: risk.factors.map((f) => f.factor),
        recommendation: rec.recommendation,
        lane,
        automationLevel: ctx.env.AUTOMATION_LEVEL,
        shadowMode: ctx.env.SHADOW_MODE,
        thresholdsVersion: input.config.thresholds.version,
      },
    });
  });
  return { risk, recommendation: rec.recommendation, recommendationExplanation: rec.explanation, lane };
}
