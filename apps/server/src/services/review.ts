import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { AiRecommendation, OverrideReasonCode, ReviewDecision, Role, ServiceAssessmentStatus } from "@alvip/shared";
import { recordAudit } from "../audit/audit";
import type { Db } from "../db/client";
import { auditEvents, feedback, humanReviews, images, locations, serviceAssessments } from "../db/schema";
import { hasRole, type AuthUser } from "./auth";
import { LocationNotFoundError, transitionLocation } from "./locationTransitions";

export class ReviewValidationError extends Error {
  override name = "ReviewValidationError";
  constructor(
    message: string,
    readonly code: "REASON_REQUIRED" | "FORBIDDEN" | "NOT_FAST_LANE" | "INVALID",
  ) {
    super(message);
  }
}

export interface ReviewInput {
  locationId: string;
  decision: ReviewDecision;
  /** Optional per-service decisions (APPROVE/REJECT) when the reviewer differentiates. */
  serviceDecisions?: Record<string, "APPROVE" | "REJECT">;
  reasonCode?: OverrideReasonCode;
  reasonText?: string;
  /** Image IDs the reviewer looked at (client-reported; full views are also audited server-side). */
  evidenceViewed?: string[];
  /** Photos the reviewer flagged as the ones the feedback is about (PRD §30 "relevant image"). */
  relevantImageIds?: string[];
  openedAt?: Date;
  /** Set by the Fast Lane batch confirmation. */
  batch?: boolean;
}

export interface AiSnapshot {
  runId: string | null;
  recommendation: AiRecommendation | null;
  riskLevel: string | null;
  services: Record<string, { status: ServiceAssessmentStatus; confidence: string }>;
}

/** What the AI said for the location's current run, frozen into the review record. */
export async function loadAiSnapshot(db: Db, locationId: string): Promise<AiSnapshot> {
  const [loc] = await db
    .select({ currentRunId: locations.currentRunId, recommendation: locations.aiRecommendation, risk: locations.riskLevel })
    .from(locations)
    .where(eq(locations.id, locationId));
  if (!loc) throw new LocationNotFoundError(`Location ${locationId} not found`);
  const services: AiSnapshot["services"] = {};
  if (loc.currentRunId) {
    for (const a of await db.select().from(serviceAssessments).where(eq(serviceAssessments.runId, loc.currentRunId))) {
      services[a.serviceCode] = { status: a.status, confidence: a.confidenceLevel };
    }
  }
  return { runId: loc.currentRunId, recommendation: loc.recommendation, riskLevel: loc.risk, services };
}

/**
 * Where the human disagrees with the AI (PRD §25, §29). Each conflict requires a
 * structured reason. NEEDS_HUMAN_REVIEW is not an opinion, so it cannot be overridden;
 * but approving while any service is not SUPPORTED always counts as going against the
 * evidence.
 */
export function findConflicts(decision: ReviewDecision, ai: AiSnapshot, serviceDecisions: Record<string, "APPROVE" | "REJECT"> = {}): string[] {
  return findConflictDetails(decision, ai, serviceDecisions).map((c) => c.message);
}

export interface Conflict {
  /** null = the location-level recommendation. */
  service: string | null;
  message: string;
}

export function findConflictDetails(decision: ReviewDecision, ai: AiSnapshot, serviceDecisions: Record<string, "APPROVE" | "REJECT"> = {}): Conflict[] {
  const out: Conflict[] = [];
  if (decision === "ESCALATE") return out;
  if (decision === "APPROVE" && ai.recommendation === "RECOMMEND_REJECT") out.push({ service: null, message: "Approved against an AI recommendation to reject" });
  if (decision === "REJECT" && ai.recommendation === "RECOMMEND_APPROVE") out.push({ service: null, message: "Rejected against an AI recommendation to approve" });
  for (const [service, a] of Object.entries(ai.services)) {
    const human = serviceDecisions[service] ?? decision;
    if (human === "APPROVE" && a.status !== "SUPPORTED") out.push({ service, message: `Approved ${service} although the AI assessed it ${a.status}` });
    if (human === "REJECT" && a.status === "SUPPORTED" && a.confidence === "HIGH") out.push({ service, message: `Rejected ${service} although the AI found strong support` });
  }
  return out;
}

/**
 * PRD §30 feedback rows: one per service the reviewer disagreed on (or one location-level
 * row when the disagreement was only with the overall recommendation, or when feedback is
 * given while agreeing), times each flagged photo.
 */
export function feedbackTargets(conflicts: Conflict[], relevantImageIds: string[]): { service: string | null; imageId: string | null }[] {
  const services = [...new Set(conflicts.map((c) => c.service).filter((s): s is string => s !== null))];
  const targets = services.length ? services : [null];
  const imgs = relevantImageIds.length ? relevantImageIds : [null];
  return targets.flatMap((service) => imgs.map((imageId) => ({ service, imageId })));
}

/**
 * Record a human decision (PRD §24–25). Immutable review record + state transition +
 * audit, in one transaction. Approval is only possible here — never from the pipeline.
 */
export async function submitReview(db: Db, user: AuthUser & { ip?: string }, input: ReviewInput) {
  const ai = await loadAiSnapshot(db, input.locationId);
  const [loc] = await db.select({ status: locations.status, lane: locations.lane }).from(locations).where(eq(locations.id, input.locationId));
  if (!loc) throw new LocationNotFoundError(`Location ${input.locationId} not found`);

  if (loc.status === "ESCALATED" && !hasRole(user.role, "TEAM_LEAD")) {
    throw new ReviewValidationError("Escalated locations are decided by a team lead", "FORBIDDEN");
  }
  if (input.decision === "ESCALATE" && loc.status === "ESCALATED") {
    throw new ReviewValidationError("Location is already escalated", "INVALID");
  }
  if (input.serviceDecisions) {
    for (const s of Object.keys(input.serviceDecisions)) {
      if (!(s in ai.services) && ai.runId) throw new ReviewValidationError(`Unknown service ${s} for this location`, "INVALID");
    }
    if (input.decision === "APPROVE" && Object.values(input.serviceDecisions).includes("REJECT")) {
      throw new ReviewValidationError("Cannot approve the location while rejecting a required service", "INVALID");
    }
  }

  const conflictDetails = findConflictDetails(input.decision, ai, input.serviceDecisions);
  const conflicts = conflictDetails.map((c) => c.message);
  if (conflicts.length > 0 && !input.reasonCode) {
    throw new ReviewValidationError(`A reason is required: ${conflicts.join("; ")}`, "REASON_REQUIRED");
  }
  if (input.reasonCode === "OTHER" && !input.reasonText?.trim()) {
    throw new ReviewValidationError("Describe the reason when choosing OTHER", "REASON_REQUIRED");
  }
  const relevantImageIds = [...new Set(input.relevantImageIds ?? [])];
  if (relevantImageIds.length > 0) {
    if (!input.reasonCode) throw new ReviewValidationError("Give a reason for the flagged photos", "REASON_REQUIRED");
    const own = await db
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.locationId, input.locationId), inArray(images.id, relevantImageIds)));
    if (own.length !== relevantImageIds.length) throw new ReviewValidationError("Flagged photos must belong to this location", "INVALID");
  }

  const to = input.decision === "APPROVE" ? "APPROVED" : input.decision === "REJECT" ? "REJECTED" : "ESCALATED";
  const actor = { type: "USER" as const, id: user.id, ip: user.ip };

  return db.transaction(async (tx) => {
    // Evidence the reviewer actually opened during this review (server-side record).
    const viewed = input.openedAt
      ? (
          await tx
            .select({ entityId: auditEvents.entityId })
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.locationId, input.locationId),
                eq(auditEvents.eventType, "EVIDENCE_VIEWED"),
                eq(auditEvents.actorId, user.id),
                gte(auditEvents.occurredAt, input.openedAt),
              ),
            )
        ).map((r) => r.entityId!)
      : [];

    await transitionLocation(tx, {
      locationId: input.locationId,
      to,
      actor,
      expectedFrom: ["HUMAN_REVIEW", "ESCALATED"],
      lane: to === "ESCALATED" ? "HUMAN_REVIEW" : null,
      reason: `human decision: ${input.decision}`,
      ...(ai.runId ? { runId: ai.runId } : {}),
    });

    const [review] = await tx
      .insert(humanReviews)
      .values({
        locationId: input.locationId,
        runId: ai.runId,
        reviewerId: user.id,
        decision: input.decision,
        serviceDecisions: input.serviceDecisions ?? {},
        aiRecommendation: ai.recommendation,
        aiSnapshot: { ...ai, lane: loc.lane, batch: input.batch ?? false },
        isOverride: conflicts.length > 0,
        reasonCode: input.reasonCode ?? null,
        reasonText: input.reasonText?.trim() || null,
        evidenceViewed: [...new Set([...(input.evidenceViewed ?? []), ...viewed])],
        openedAt: input.openedAt ?? null,
      })
      .returning();

    // Feedback (PRD §30): captured whenever a reason is given. Stored for evaluation only.
    let feedbackRows = 0;
    if (input.reasonCode) {
      const rows = feedbackTargets(conflictDetails, relevantImageIds).map(({ service, imageId }) => ({
        reviewId: review!.id,
        locationId: input.locationId,
        runId: ai.runId,
        reviewerId: user.id,
        serviceCode: service,
        imageId,
        aiRecommendation: ai.recommendation,
        aiStatus: service ? (ai.services[service]?.status ?? null) : null,
        aiConfidence: service ? ((ai.services[service]?.confidence as "HIGH" | "MEDIUM" | "LOW" | undefined) ?? null) : null,
        humanDecision: (service ? input.serviceDecisions?.[service] : undefined) ?? input.decision,
        isOverride: conflicts.length > 0,
        reasonCode: input.reasonCode!,
        reasonText: input.reasonText?.trim() || null,
      }));
      await tx.insert(feedback).values(rows);
      feedbackRows = rows.length;
    }

    await recordAudit(tx, {
      eventType: "HUMAN_DECISION",
      actor,
      entityType: "human_reviews",
      entityId: review!.id,
      locationId: input.locationId,
      ...(ai.runId ? { runId: ai.runId } : {}),
      data: {
        decision: input.decision,
        aiRecommendation: ai.recommendation,
        reviewSeconds: input.openedAt ? Math.round((Date.now() - input.openedAt.getTime()) / 1000) : null,
        batch: input.batch ?? false,
        feedbackRows,
      },
    });
    if (conflicts.length > 0) {
      await recordAudit(tx, {
        eventType: "HUMAN_OVERRIDE",
        actor,
        entityType: "human_reviews",
        entityId: review!.id,
        locationId: input.locationId,
        ...(ai.runId ? { runId: ai.runId } : {}),
        data: { conflicts, reasonCode: input.reasonCode, reasonText: input.reasonText ?? null, relevantImageIds },
      });
    }
    return { review: review!, conflicts, status: to, feedbackRows };
  });
}

/** Log that a reviewer opened a location (PRD §41). Returns the server timestamp. */
export async function openReview(db: Db, user: AuthUser & { ip?: string }, locationId: string): Promise<Date> {
  const [loc] = await db.select({ status: locations.status, runId: locations.currentRunId }).from(locations).where(eq(locations.id, locationId));
  if (!loc) throw new LocationNotFoundError(`Location ${locationId} not found`);
  const openedAt = new Date();
  await recordAudit(db, {
    eventType: "REVIEW_OPENED",
    actor: { type: "USER", id: user.id, ip: user.ip },
    entityType: "locations",
    entityId: locationId,
    locationId,
    ...(loc.runId ? { runId: loc.runId } : {}),
    data: { status: loc.status },
  });
  return openedAt;
}

/**
 * Fast Lane batch confirmation (PRD §36, §53 level 3). Only Fast Lane locations the AI
 * recommended approving; each becomes its own human review record.
 */
export async function confirmFastLane(db: Db, user: AuthUser & { ip?: string }, locationIds: string[], openedAt?: Date) {
  const rows = await db
    .select({ id: locations.id, lane: locations.lane, status: locations.status, rec: locations.aiRecommendation })
    .from(locations)
    .where(inArray(locations.id, locationIds));
  const bad = locationIds.filter((id) => {
    const r = rows.find((x) => x.id === id);
    return !r || r.lane !== "FAST" || r.status !== "HUMAN_REVIEW" || r.rec !== "RECOMMEND_APPROVE";
  });
  if (bad.length > 0) throw new ReviewValidationError(`Not confirmable from the Fast Lane: ${bad.join(", ")}`, "NOT_FAST_LANE");
  const results = [];
  for (const id of locationIds) {
    results.push(await submitReview(db, user, { locationId: id, decision: "APPROVE", batch: true, ...(openedAt ? { openedAt } : {}) }));
  }
  return results;
}

/** Oldest location awaiting this user in a lane (PRD §35 default ordering). */
export async function nextLocation(db: Db, role: Role, opts: { lane?: "HUMAN_REVIEW" | "FAST"; excludeId?: string }): Promise<string | null> {
  const statuses = hasRole(role, "TEAM_LEAD") ? (["HUMAN_REVIEW", "ESCALATED"] as const) : (["HUMAN_REVIEW"] as const);
  const conditions = [inArray(locations.status, [...statuses])];
  if (opts.lane) conditions.push(eq(locations.lane, opts.lane));
  if (opts.excludeId) conditions.push(sql`${locations.id} <> ${opts.excludeId}`);
  const [row] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(...conditions))
    .orderBy(asc(locations.receivedAt))
    .limit(1);
  return row?.id ?? null;
}

export async function reviewHistory(db: Db, locationId: string) {
  const reviews = await db.select().from(humanReviews).where(eq(humanReviews.locationId, locationId)).orderBy(desc(humanReviews.submittedAt));
  const fb = reviews.length
    ? await db
        .select({
          reviewId: feedback.reviewId,
          serviceCode: feedback.serviceCode,
          imageId: feedback.imageId,
          imageRef: images.externalRef,
          aiStatus: feedback.aiStatus,
          humanDecision: feedback.humanDecision,
          reasonCode: feedback.reasonCode,
        })
        .from(feedback)
        .leftJoin(images, eq(images.id, feedback.imageId))
        .where(eq(feedback.locationId, locationId))
    : [];
  return reviews.map((r) => ({ ...r, feedback: fb.filter((f) => f.reviewId === r.id) }));
}

