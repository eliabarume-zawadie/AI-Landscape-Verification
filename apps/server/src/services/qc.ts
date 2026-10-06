import { aliasedTable, and, desc, eq, sql } from "drizzle-orm";
import { recordAudit, type Actor } from "../audit/audit";
import type { Db } from "../db/client";
import { clients, humanReviews, locations, qcSamples, users } from "../db/schema";
import { wilson } from "../domain/evaluation";

/**
 * Quality-control sampling (PRD §71: "continuously sample … for human quality control").
 * A share of approvals is re-checked by a second team lead. QC never changes the original
 * decision (it is immutable and may already be in NetSuite); a disagreement is recorded,
 * audited, and flagged for follow-up — and is the real-world signal of false approvals.
 */

export class QcError extends Error {
  override name = "QcError";
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "FORBIDDEN" | "STATE" | "INVALID",
  ) {
    super(message);
  }
}

export interface QcRates {
  /** Share of Fast Lane batch confirmations sampled (0–1). */
  fastLane: number;
  /** Share of other approvals sampled (0–1). */
  approvals: number;
  random?: () => number;
}

/** Inside the decision transaction. Only approvals are sampled: false approval is the costly error. */
export async function maybeSampleForQc(tx: Db, review: typeof humanReviews.$inferSelect, batch: boolean, rates: QcRates): Promise<boolean> {
  if (review.decision !== "APPROVE") return false;
  const rate = batch ? rates.fastLane : rates.approvals;
  if (rate <= 0 || (rates.random ?? Math.random)() >= rate) return false;
  await tx.insert(qcSamples).values({ locationId: review.locationId, reviewId: review.id, reason: batch ? "FAST_LANE" : "RANDOM" }).onConflictDoNothing();
  await recordAudit(tx, { eventType: "QC_SAMPLED", actor: { type: "SYSTEM", id: "qc-sampler" }, entityType: "qc_samples", entityId: review.id, locationId: review.locationId, data: { reason: batch ? "FAST_LANE" : "RANDOM", rate } });
  return true;
}

const reviewer = aliasedTable(users, "reviewer");
const checker = aliasedTable(users, "checker");

export async function listQc(db: Db, status: "PENDING" | "DONE" | undefined) {
  return db
    .select({
      id: qcSamples.id,
      locationId: qcSamples.locationId,
      externalId: locations.externalId,
      name: locations.name,
      clientName: clients.displayName,
      reason: qcSamples.reason,
      sampledAt: qcSamples.sampledAt,
      status: qcSamples.status,
      decision: humanReviews.decision,
      aiRecommendation: humanReviews.aiRecommendation,
      reviewerId: humanReviews.reviewerId,
      reviewerName: reviewer.displayName,
      decidedAt: humanReviews.submittedAt,
      verdict: qcSamples.verdict,
      correctDecision: qcSamples.correctDecision,
      note: qcSamples.note,
      checkedByName: checker.displayName,
      checkedAt: qcSamples.checkedAt,
    })
    .from(qcSamples)
    .innerJoin(humanReviews, eq(humanReviews.id, qcSamples.reviewId))
    .innerJoin(locations, eq(locations.id, qcSamples.locationId))
    .innerJoin(clients, eq(clients.id, locations.clientId))
    .innerJoin(reviewer, eq(reviewer.id, humanReviews.reviewerId))
    .leftJoin(checker, eq(checker.id, qcSamples.checkedBy))
    .where(status ? eq(qcSamples.status, status) : undefined)
    .orderBy(desc(qcSamples.sampledAt))
    .limit(500);
}

export async function completeQc(db: Db, actor: Actor & { type: "USER" }, id: string, input: { verdict: "CONFIRMED" | "DISAGREE"; correctDecision?: "APPROVE" | "REJECT"; note?: string }) {
  const [s] = await db
    .select({ id: qcSamples.id, status: qcSamples.status, locationId: qcSamples.locationId, reviewerId: humanReviews.reviewerId, decision: humanReviews.decision })
    .from(qcSamples)
    .innerJoin(humanReviews, eq(humanReviews.id, qcSamples.reviewId))
    .where(eq(qcSamples.id, id));
  if (!s) throw new QcError("QC sample not found", "NOT_FOUND");
  if (s.status !== "PENDING") throw new QcError("This sample was already checked", "STATE");
  if (s.reviewerId === actor.id) throw new QcError("Quality control must be done by someone other than the original reviewer", "FORBIDDEN");
  if (input.verdict === "DISAGREE" && (!input.correctDecision || input.correctDecision === s.decision || !input.note?.trim())) {
    throw new QcError("Say what the correct decision is and why", "INVALID");
  }
  await db.transaction(async (tx) => {
    await tx
      .update(qcSamples)
      .set({ status: "DONE", checkedBy: actor.id, checkedAt: new Date(), verdict: input.verdict, correctDecision: input.verdict === "DISAGREE" ? input.correctDecision! : s.decision, note: input.note?.trim() || null })
      .where(and(eq(qcSamples.id, id), eq(qcSamples.status, "PENDING")));
    await recordAudit(tx, {
      eventType: "QC_COMPLETED",
      actor,
      entityType: "qc_samples",
      entityId: id,
      locationId: s.locationId,
      data: { verdict: input.verdict, originalDecision: s.decision, correctDecision: input.correctDecision ?? s.decision, note: input.note ?? null },
    });
  });
}

/** QC disagreement rates by sample reason (and optionally per client). */
export async function qcStats(db: Db, minSample: number) {
  const rows = await db
    .select({
      reason: qcSamples.reason,
      clientName: clients.displayName,
      done: sql<number>`count(*) filter (where ${qcSamples.status} = 'DONE')`.mapWith(Number),
      disagree: sql<number>`count(*) filter (where ${qcSamples.verdict} = 'DISAGREE')`.mapWith(Number),
      pending: sql<number>`count(*) filter (where ${qcSamples.status} = 'PENDING')`.mapWith(Number),
    })
    .from(qcSamples)
    .innerJoin(locations, eq(locations.id, qcSamples.locationId))
    .innerJoin(clients, eq(clients.id, locations.clientId))
    .groupBy(qcSamples.reason, clients.displayName);
  const sum = (filter: (r: (typeof rows)[number]) => boolean) => {
    const sel = rows.filter(filter);
    const done = sel.reduce((a, r) => a + r.done, 0);
    const disagree = sel.reduce((a, r) => a + r.disagree, 0);
    return { checked: done, disagree, pending: sel.reduce((a, r) => a + r.pending, 0), rate: done ? disagree / done : null, ci95: wilson(disagree, done), smallSample: done < minSample };
  };
  return {
    overall: sum(() => true),
    fastLane: sum((r) => r.reason === "FAST_LANE"),
    random: sum((r) => r.reason === "RANDOM"),
    byClient: Object.fromEntries([...new Set(rows.map((r) => r.clientName))].map((c) => [c, sum((r) => r.clientName === c)])),
  };
}
