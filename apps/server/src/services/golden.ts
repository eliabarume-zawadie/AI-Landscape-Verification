import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { GOLDEN_CASE_TAGS, type GoldenCaseTag, type GoldenExpected, type GoldenStatus, type Role } from "@alvip/shared";
import { recordAudit, type Actor } from "../audit/audit";
import type { Db } from "../db/client";
import {
  clients,
  goldenExampleImages,
  goldenExamples,
  humanReviews,
  imageAnalysis,
  images,
  locations,
  locationServices,
  serviceAssessments,
  services,
  users,
} from "../db/schema";
import type { ImageProvider } from "../integrations/images/ImageProvider";
import { MOCK_IMAGE_LOCATOR_PREFIX } from "../integrations/netsuite/mock/MockNetSuiteAdapter";
import { MOCK_SCENARIOS } from "../integrations/netsuite/mock/scenarios";
import type { StorageProvider } from "../integrations/storage/StorageProvider";
import { LocationNotFoundError } from "./locationTransitions";
import { serviceDecisionsFor } from "./netsuiteSync";

/**
 * Golden dataset (PRD §55): labelled examples the evaluation runner scores the AI against.
 *
 * Rules:
 *  - The label ("expected" per service) is set by a person. Drafts start from the reviewer's
 *    decision, but the reviewer may have been wrong: a team lead confirms the truth.
 *  - Only APPROVED examples are evaluated. Approval needs a team lead other than the person
 *    who created the example (an admin may approve their own; that is audited as such).
 *  - Approved content is frozen by a DB trigger. Corrections: retire + create a new example.
 *  - Photos are copied into storage under golden/…, outside image retention, so evaluations
 *    are repeatable (document this against the retention policy, U14).
 */

export class GoldenError extends Error {
  override name = "GoldenError";
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "INVALID" | "STATE" | "FORBIDDEN",
  ) {
    super(message);
  }
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const goldenKey = (exampleId: string, ordinal: number, hash: string) => `golden/${exampleId}/${String(ordinal).padStart(4, "0")}-${hash.slice(0, 16)}`;

interface NewImage {
  externalRef: string;
  filename: string | null;
  capturedAt: Date | null;
  contentType: string | null;
  bytes: Buffer;
}

interface NewExample {
  title: string;
  clientId: string;
  source: "FROM_LOCATION" | "IMPORT" | "DEMO";
  sourceLocationId?: string | null;
  sourceReviewId?: string | null;
  services: string[];
  expected: Record<string, GoldenExpected>;
  tags: GoldenCaseTag[];
  reviewerDecision?: string | null;
  reason?: string | null;
  notes?: string | null;
  status?: GoldenStatus;
  images: NewImage[];
}

async function insertExample(db: Db, storage: StorageProvider, actor: Actor, ex: NewExample) {
  if (ex.images.length === 0) throw new GoldenError("An example needs at least one photo", "INVALID");
  const createdBy = actor.type === "USER" ? actor.id : null;
  const approved = ex.status === "APPROVED";
  // Bytes first (outside the transaction): an aborted insert leaves only unreferenced objects.
  const [row] = await db
    .insert(goldenExamples)
    .values({
      title: ex.title,
      clientId: ex.clientId,
      source: ex.source,
      sourceLocationId: ex.sourceLocationId ?? null,
      sourceReviewId: ex.sourceReviewId ?? null,
      services: ex.services,
      expected: ex.expected,
      tags: ex.tags,
      reviewerDecision: ex.reviewerDecision ?? null,
      reason: ex.reason ?? null,
      notes: ex.notes ?? null,
      status: "DRAFT",
      createdBy,
    })
    .returning();
  const rows = [];
  for (const [i, img] of ex.images.entries()) {
    const hash = sha256(img.bytes);
    const key = goldenKey(row!.id, i + 1, hash);
    await storage.put(key, img.bytes, img.contentType ?? "application/octet-stream");
    rows.push({ exampleId: row!.id, ordinal: i + 1, externalRef: img.externalRef, filename: img.filename, capturedAt: img.capturedAt, sha256: hash, contentType: img.contentType, storageKey: key });
  }
  await db.insert(goldenExampleImages).values(rows);
  await recordAudit(db, {
    eventType: "GOLDEN_EXAMPLE_CREATED",
    actor,
    entityType: "golden_examples",
    entityId: row!.id,
    ...(ex.sourceLocationId ? { locationId: ex.sourceLocationId } : {}),
    data: { source: ex.source, services: ex.services, expected: ex.expected, tags: ex.tags, images: rows.length },
  });
  if (approved) {
    await db.update(goldenExamples).set({ status: "APPROVED", approvedAt: new Date(), approvedBy: createdBy }).where(eq(goldenExamples.id, row!.id));
    await recordAudit(db, { eventType: "GOLDEN_EXAMPLE_APPROVED", actor, entityType: "golden_examples", entityId: row!.id, data: { source: ex.source, automatic: true } });
  }
  return row!.id;
}

function toExpected(d: string): GoldenExpected {
  return d === "APPROVE" ? "APPROVE" : "REJECT";
}

/** Case tags suggested from what the pipeline saw. The lead reviews them before approving. */
async function suggestTags(db: Db, locationId: string, runId: string | null, svc: string[], review: typeof humanReviews.$inferSelect): Promise<GoldenCaseTag[]> {
  const tags = new Set<GoldenCaseTag>();
  if (svc.length > 1) tags.add("MULTIPLE_SERVICES");
  if (runId) {
    const assessed = await db.select({ status: serviceAssessments.status }).from(serviceAssessments).where(eq(serviceAssessments.runId, runId));
    if (assessed.some((a) => a.status === "CONTRADICTORY")) tags.add("CONTRADICTION");
    const analysis = await db
      .select({ usable: imageAnalysis.usable, dup: imageAnalysis.duplicateKind, stage: imageAnalysis.stage })
      .from(imageAnalysis)
      .where(eq(imageAnalysis.runId, runId));
    if (analysis.some((a) => a.usable === false)) tags.add("POOR_QUALITY");
    if (analysis.some((a) => a.dup)) tags.add("DUPLICATES");
    const before = analysis.some((a) => a.stage === "BEFORE");
    const after = analysis.some((a) => a.stage === "AFTER");
    if (before && after) tags.add("BEFORE_AFTER");
    if (!before) tags.add("MISSING_BEFORE");
    if (!after) tags.add("MISSING_AFTER");
  }
  const rec = review.aiRecommendation;
  if (rec === "NEEDS_HUMAN_REVIEW") tags.add("AMBIGUOUS");
  if (!review.isOverride && rec === "RECOMMEND_APPROVE" && review.decision === "APPROVE") tags.add("CLEAR_APPROVAL");
  if (!review.isOverride && rec === "RECOMMEND_REJECT" && review.decision === "REJECT") tags.add("CLEAR_REJECTION");
  void locationId;
  return GOLDEN_CASE_TAGS.filter((t) => tags.has(t));
}

/** Draft example from a decided location: photos copied, truth prefilled from the decision. */
export async function createFromLocation(db: Db, storage: StorageProvider, actor: Actor & { type: "USER" }, locationId: string, opts: { title?: string } = {}) {
  const [loc] = await db
    .select({ id: locations.id, externalId: locations.externalId, name: locations.name, clientId: locations.clientId, runId: locations.currentRunId })
    .from(locations)
    .where(eq(locations.id, locationId));
  if (!loc) throw new LocationNotFoundError(`Location ${locationId} not found`);
  const [review] = await db
    .select()
    .from(humanReviews)
    .where(and(eq(humanReviews.locationId, locationId), inArray(humanReviews.decision, ["APPROVE", "REJECT"])))
    .orderBy(desc(humanReviews.submittedAt))
    .limit(1);
  if (!review) throw new GoldenError("Only decided locations can become examples: decide it first", "STATE");
  const svc = (await db.select({ code: locationServices.serviceCode }).from(locationServices).where(eq(locationServices.locationId, locationId)).orderBy(asc(locationServices.serviceCode))).map(
    (r) => r.code,
  );
  const imgs = await db
    .select()
    .from(images)
    .where(and(eq(images.locationId, locationId), isNotNull(images.storageKey), isNull(images.purgedAt)))
    .orderBy(asc(images.ordinal), asc(images.externalRef));
  const copies: NewImage[] = [];
  for (const i of imgs) {
    const bytes = await storage.get(i.storageKey!);
    if (bytes) copies.push({ externalRef: i.externalRef, filename: i.filename, capturedAt: i.capturedAt, contentType: i.contentType, bytes });
  }
  if (copies.length === 0) throw new GoldenError("The photos of this location are no longer stored (retention), so it can't become an example", "STATE");

  const decisions = serviceDecisionsFor(review);
  const expected = Object.fromEntries(svc.map((s) => [s, toExpected(decisions[s] ?? review.decision)])) as Record<string, GoldenExpected>;
  return db.transaction(async (tx) =>
    insertExample(tx, storage, actor, {
      title: opts.title?.trim() || `${loc.externalId}${loc.name ? ` · ${loc.name}` : ""}`,
      clientId: loc.clientId,
      source: "FROM_LOCATION",
      sourceLocationId: loc.id,
      sourceReviewId: review.id,
      services: svc,
      expected,
      tags: await suggestTags(tx, loc.id, review.runId ?? loc.runId, svc, review),
      reviewerDecision: review.decision,
      reason: review.reasonText ?? null,
      images: copies,
    }),
  );
}

export interface DraftUpdate {
  title?: string;
  expected?: Record<string, GoldenExpected>;
  tags?: GoldenCaseTag[];
  reason?: string | null;
  notes?: string | null;
}

async function loadExample(db: Db, id: string) {
  const [ex] = await db.select().from(goldenExamples).where(eq(goldenExamples.id, id));
  if (!ex) throw new GoldenError("Example not found", "NOT_FOUND");
  return ex;
}

export async function updateDraft(db: Db, actor: Actor & { type: "USER" }, id: string, u: DraftUpdate) {
  const ex = await loadExample(db, id);
  if (ex.status !== "DRAFT") throw new GoldenError("Approved and retired examples can't be edited. Retire it and create a corrected one.", "STATE");
  const svc = ex.services as string[];
  if (u.expected) {
    const keys = Object.keys(u.expected);
    if (keys.some((k) => !svc.includes(k))) throw new GoldenError("Expected results can only be set for the example's services", "INVALID");
  }
  const expected = { ...(ex.expected as Record<string, GoldenExpected>), ...(u.expected ?? {}) };
  await db
    .update(goldenExamples)
    .set({
      ...(u.title !== undefined ? { title: u.title.trim() } : {}),
      expected,
      ...(u.tags ? { tags: [...new Set(u.tags)] } : {}),
      ...(u.reason !== undefined ? { reason: u.reason?.trim() || null } : {}),
      ...(u.notes !== undefined ? { notes: u.notes?.trim() || null } : {}),
    })
    .where(eq(goldenExamples.id, id));
  await recordAudit(db, { eventType: "GOLDEN_EXAMPLE_UPDATED", actor, entityType: "golden_examples", entityId: id, data: { ...u } });
}

export async function approveExample(db: Db, actor: Actor & { type: "USER" }, role: Role, id: string) {
  const ex = await loadExample(db, id);
  if (ex.status !== "DRAFT") throw new GoldenError(`This example is already ${ex.status.toLowerCase()}`, "STATE");
  const svc = ex.services as string[];
  const expected = ex.expected as Record<string, string>;
  if (svc.length === 0 || svc.some((s) => expected[s] !== "APPROVE" && expected[s] !== "REJECT")) {
    throw new GoldenError("Set the correct result (approve or reject) for every service first", "INVALID");
  }
  const selfApproved = ex.createdBy === actor.id;
  if (selfApproved && role !== "ADMIN") {
    throw new GoldenError("Another team lead must approve this example (a second pair of eyes on the label)", "FORBIDDEN");
  }
  await db.update(goldenExamples).set({ status: "APPROVED", approvedBy: actor.id, approvedAt: new Date() }).where(eq(goldenExamples.id, id));
  await recordAudit(db, { eventType: "GOLDEN_EXAMPLE_APPROVED", actor, entityType: "golden_examples", entityId: id, data: { selfApproved, expected } });
}

export async function retireExample(db: Db, actor: Actor & { type: "USER" }, id: string, reason: string) {
  if (!reason.trim()) throw new GoldenError("Say why the example is retired", "INVALID");
  const ex = await loadExample(db, id);
  if (ex.status === "RETIRED") throw new GoldenError("Already retired", "STATE");
  await db.update(goldenExamples).set({ status: "RETIRED", retiredBy: actor.id, retiredAt: new Date(), retireReason: reason.trim() }).where(eq(goldenExamples.id, id));
  await recordAudit(db, { eventType: "GOLDEN_EXAMPLE_RETIRED", actor, entityType: "golden_examples", entityId: id, data: { reason: reason.trim() } });
}

export async function listExamples(db: Db, opts: { status?: GoldenStatus } = {}) {
  const creator = sql<string | null>`(select display_name from users u where u.id = ${goldenExamples.createdBy})`;
  const approver = sql<string | null>`(select display_name from users u where u.id = ${goldenExamples.approvedBy})`;
  const imageCount = sql<number>`(select count(*) from golden_example_images gi where gi.example_id = ${goldenExamples.id})`.mapWith(Number);
  return db
    .select({
      id: goldenExamples.id,
      title: goldenExamples.title,
      clientName: clients.displayName,
      source: goldenExamples.source,
      services: goldenExamples.services,
      expected: goldenExamples.expected,
      tags: goldenExamples.tags,
      reviewerDecision: goldenExamples.reviewerDecision,
      status: goldenExamples.status,
      createdAt: goldenExamples.createdAt,
      createdBy: creator,
      approvedBy: approver,
      approvedAt: goldenExamples.approvedAt,
      imageCount,
    })
    .from(goldenExamples)
    .innerJoin(clients, eq(clients.id, goldenExamples.clientId))
    .where(opts.status ? eq(goldenExamples.status, opts.status) : undefined)
    .orderBy(desc(goldenExamples.createdAt));
}

export async function getExample(db: Db, id: string) {
  const ex = await loadExample(db, id);
  const [client] = await db.select({ name: clients.displayName, code: clients.code }).from(clients).where(eq(clients.id, ex.clientId));
  const imgs = await db
    .select({ id: goldenExampleImages.id, ordinal: goldenExampleImages.ordinal, externalRef: goldenExampleImages.externalRef, filename: goldenExampleImages.filename, capturedAt: goldenExampleImages.capturedAt })
    .from(goldenExampleImages)
    .where(eq(goldenExampleImages.exampleId, id))
    .orderBy(asc(goldenExampleImages.ordinal));
  const names = new Map(
    (await db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, [ex.createdBy, ex.approvedBy, ex.retiredBy].filter((x): x is string => !!x).concat("00000000-0000-0000-0000-000000000000")))).map((u) => [u.id, u.name]),
  );
  const svcNames = new Map((await db.select({ code: services.code, name: services.displayName }).from(services)).map((s) => [s.code, s.name]));
  return {
    ...ex,
    clientName: client?.name ?? null,
    clientCode: client?.code ?? null,
    serviceNames: Object.fromEntries((ex.services as string[]).map((s) => [s, svcNames.get(s) ?? s])),
    createdByName: ex.createdBy ? (names.get(ex.createdBy) ?? null) : null,
    approvedByName: ex.approvedBy ? (names.get(ex.approvedBy) ?? null) : null,
    retiredByName: ex.retiredBy ? (names.get(ex.retiredBy) ?? null) : null,
    images: imgs,
  };
}

export async function exampleImageBytes(db: Db, storage: StorageProvider, imageId: string) {
  const [img] = await db.select({ key: goldenExampleImages.storageKey }).from(goldenExampleImages).where(eq(goldenExampleImages.id, imageId));
  if (!img) return null;
  return storage.get(img.key);
}

// ---------------------------------------------------------------- demo examples (mock data)

/**
 * The intended truth for the mock scenarios: what a careful reviewer should decide from
 * those photos. Scenarios that test data/integration failures (unknown client, no photos,
 * provider outage) are not AI cases and are left out.
 */
export const DEMO_TRUTH: Record<string, { expected: Record<string, GoldenExpected>; tags: GoldenCaseTag[] }> = {
  "NS-DEMO-001": { expected: { mowing: "APPROVE", edging: "APPROVE", shrub_pruning: "APPROVE" }, tags: ["CLEAR_APPROVAL", "BEFORE_AFTER", "MULTIPLE_SERVICES"] },
  "NS-DEMO-002": { expected: { mowing: "APPROVE", edging: "APPROVE", weed_removal: "APPROVE", shrub_pruning: "APPROVE" }, tags: ["BEFORE_AFTER", "MULTIPLE_SERVICES"] },
  "NS-DEMO-003": { expected: { weed_removal: "REJECT" }, tags: ["AMBIGUOUS", "MISSING_BEFORE"] },
  "NS-DEMO-004": { expected: { mowing: "REJECT" }, tags: ["CONTRADICTION", "BEFORE_AFTER"] },
  "NS-DEMO-005": { expected: { landscape_maintenance: "REJECT", trash_debris_leaves_removal: "REJECT" }, tags: ["POOR_QUALITY", "MULTIPLE_SERVICES"] },
  "NS-DEMO-006": { expected: { mowing: "APPROVE" }, tags: ["DUPLICATES", "BEFORE_AFTER"] },
  "NS-DEMO-007": { expected: { mowing: "APPROVE", edging: "APPROVE", shrub_pruning: "APPROVE" }, tags: ["CLEAR_APPROVAL", "BEFORE_AFTER", "MULTIPLE_SERVICES"] },
  "NS-DEMO-009": { expected: { mowing: "APPROVE" }, tags: ["AMBIGUOUS"] },
  "NS-DEMO-010": { expected: { mowing: "APPROVE", edging: "APPROVE" }, tags: ["MISSING_BEFORE", "MULTIPLE_SERVICES"] },
  "NS-DEMO-011": { expected: { mowing: "APPROVE", landscape_fertilization: "REJECT", weed_removal: "APPROVE" }, tags: ["DIFFICULT_CONDITIONS", "BEFORE_AFTER", "MULTIPLE_SERVICES"] },
};

/** Create APPROVED demo examples from the mock scenarios (once). Marked source DEMO. */
export async function seedDemoExamples(db: Db, storage: StorageProvider, imagesProvider: ImageProvider, actor: Actor) {
  const existing = new Set(
    (await db.select({ title: goldenExamples.title }).from(goldenExamples).where(eq(goldenExamples.source, "DEMO"))).map((r) => r.title),
  );
  let created = 0;
  for (const scenario of MOCK_SCENARIOS) {
    const truth = DEMO_TRUTH[scenario.externalId];
    if (!truth) continue;
    const title = `Demo: ${scenario.title} (${scenario.externalId})`;
    if (existing.has(title)) continue;
    const [client] = await db.select({ id: clients.id }).from(clients).where(eq(clients.code, scenario.clientCode));
    if (!client) throw new GoldenError(`Client ${scenario.clientCode} is not configured`, "INVALID");
    const imgs: NewImage[] = [];
    for (const spec of scenario.images) {
      const got = await imagesProvider.fetch(`${MOCK_IMAGE_LOCATOR_PREFIX}${scenario.externalId}/${spec.ref}`);
      imgs.push({ externalRef: spec.ref, filename: spec.filename ?? null, capturedAt: spec.capturedAt ? new Date(spec.capturedAt) : null, contentType: got.contentType ?? null, bytes: got.bytes });
    }
    await db.transaction((tx) =>
      insertExample(tx, storage, actor, {
        title,
        clientId: client.id,
        source: "DEMO",
        services: Object.keys(truth.expected),
        expected: truth.expected,
        tags: truth.tags,
        notes: scenario.expected,
        status: "APPROVED",
        images: imgs,
      }),
    );
    created++;
  }
  return { created };
}

export { insertExample as _insertExampleForImport };
export type { NewExample, NewImage };
