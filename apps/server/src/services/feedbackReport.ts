import { aliasedTable, and, count, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import type { OverrideReasonCode } from "@alvip/shared";
import type { Db } from "../db/client";
import { clients, feedback, images, locations, users } from "../db/schema";

/**
 * Reviewer feedback for team leads and evaluation (PRD §30). Read-only: feedback is input to
 * the golden dataset (Phase 13) after a lead validates it — never applied to production
 * behaviour directly.
 */
export interface FeedbackFilter {
  from?: Date;
  to?: Date;
  reasonCode?: OverrideReasonCode;
  serviceCode?: string;
  reviewerId?: string;
  overridesOnly?: boolean;
}

function where(f: FeedbackFilter): SQL | undefined {
  const c: SQL[] = [];
  if (f.from) c.push(gte(feedback.createdAt, f.from));
  if (f.to) c.push(lt(feedback.createdAt, f.to));
  if (f.reasonCode) c.push(eq(feedback.reasonCode, f.reasonCode));
  if (f.serviceCode) c.push(eq(feedback.serviceCode, f.serviceCode));
  if (f.reviewerId) c.push(eq(feedback.reviewerId, f.reviewerId));
  if (f.overridesOnly) c.push(eq(feedback.isOverride, true));
  return c.length ? and(...c) : undefined;
}

const reviewer = aliasedTable(users, "reviewer");

export async function listFeedback(db: Db, f: FeedbackFilter, page: { limit: number; offset: number }) {
  return db
    .select({
      id: feedback.id,
      createdAt: feedback.createdAt,
      reviewId: feedback.reviewId,
      locationId: feedback.locationId,
      locationExternalId: locations.externalId,
      locationName: locations.name,
      clientName: clients.displayName,
      runId: feedback.runId,
      reviewerId: feedback.reviewerId,
      reviewerName: reviewer.displayName,
      serviceCode: feedback.serviceCode,
      imageId: feedback.imageId,
      imageRef: images.externalRef,
      aiRecommendation: feedback.aiRecommendation,
      aiStatus: feedback.aiStatus,
      aiConfidence: feedback.aiConfidence,
      humanDecision: feedback.humanDecision,
      isOverride: feedback.isOverride,
      reasonCode: feedback.reasonCode,
      reasonText: feedback.reasonText,
    })
    .from(feedback)
    .innerJoin(locations, eq(locations.id, feedback.locationId))
    .innerJoin(clients, eq(clients.id, locations.clientId))
    .innerJoin(reviewer, eq(reviewer.id, feedback.reviewerId))
    .leftJoin(images, eq(images.id, feedback.imageId))
    .where(where(f))
    .orderBy(desc(feedback.createdAt), desc(feedback.id))
    .limit(page.limit)
    .offset(page.offset);
}

/** Counts by reason and by service over the same filter. */
export async function summarizeFeedback(db: Db, f: FeedbackFilter) {
  const [total, byReason, byService] = await Promise.all([
    db.select({ n: count() }).from(feedback).where(where(f)),
    db.select({ key: feedback.reasonCode, n: count() }).from(feedback).where(where(f)).groupBy(feedback.reasonCode).orderBy(desc(count())),
    db.select({ key: feedback.serviceCode, n: count() }).from(feedback).where(where(f)).groupBy(feedback.serviceCode).orderBy(desc(count())),
  ]);
  return { total: total[0]?.n ?? 0, byReason, byService };
}

export type FeedbackRow = Awaited<ReturnType<typeof listFeedback>>[number];

/**
 * RFC 4180 quoting, and cells that a spreadsheet would run as a formula (= + - @, tab, CR)
 * are prefixed with an apostrophe: reviewer notes are free text.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const CSV_COLUMNS: (keyof FeedbackRow)[] = [
  "createdAt",
  "locationExternalId",
  "clientName",
  "serviceCode",
  "imageRef",
  "aiRecommendation",
  "aiStatus",
  "aiConfidence",
  "humanDecision",
  "isOverride",
  "reasonCode",
  "reasonText",
  "reviewerName",
  "reviewId",
  "runId",
  "imageId",
];

export function feedbackCsv(rows: FeedbackRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
