import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { ROLLOUT_MODES, type RolloutMode } from "@alvip/shared";
import { recordAudit, type Actor } from "../audit/audit";
import { loadActiveConfig } from "../config/configStore";
import type { Env } from "../config/env";
import type { Db } from "../db/client";
import { clients, evaluationRuns, locations, locationServices, rolloutSettings, services, users } from "../db/schema";

/**
 * Controlled rollout (PRD §71, §90). Each client has a rollout mode (ROLLOUT_MODES); a row
 * with clientId null is the default for clients without their own. History is append-only.
 *
 * The environment stays the ceiling and the safety switch:
 *   AUTOMATION_LEVEL 0 → nothing above MANUAL;  1–2 → nothing above ASSIST;  3 → FAST_TRACK allowed.
 *   SHADOW_MODE=true   → every AI-enabled client runs in SHADOW (global kill switch).
 * Levels 4–5 (automated final decisions) do not exist as a mode and stay disabled in code.
 */

const RANK: Record<RolloutMode, number> = { MANUAL: 0, SHADOW: 1, ASSIST: 2, FAST_TRACK: 3 };
const ALL_SERVICES = "*";

export class RolloutError extends Error {
  override name = "RolloutError";
  constructor(
    message: string,
    readonly code: "INVALID" | "ABOVE_CEILING" | "VALIDATION_REQUIRED",
  ) {
    super(message);
  }
}

export function ceilingFromEnv(env: Pick<Env, "AUTOMATION_LEVEL">): RolloutMode {
  if (env.AUTOMATION_LEVEL <= 0) return "MANUAL";
  if (env.AUTOMATION_LEVEL < 3) return "ASSIST";
  return "FAST_TRACK";
}

/** The mode actually applied: the configured mode, capped by the ceiling, shadow switch on top. */
export function applyEnv(configured: RolloutMode, env: Pick<Env, "AUTOMATION_LEVEL" | "SHADOW_MODE">): RolloutMode {
  const ceiling = ceilingFromEnv(env);
  const capped = RANK[configured] <= RANK[ceiling] ? configured : ceiling;
  return env.SHADOW_MODE && capped !== "MANUAL" ? "SHADOW" : capped;
}

/** Highest PRD §53 automation level each mode can use. */
export const LEVEL_OF: Record<RolloutMode, number> = { MANUAL: 0, SHADOW: 1, ASSIST: 2, FAST_TRACK: 3 };

/** The automation level actually in force for a run: the mode's level, never above the server's. */
export function levelFor(mode: RolloutMode, env: Pick<Env, "AUTOMATION_LEVEL">): number {
  return Math.min(env.AUTOMATION_LEVEL, LEVEL_OF[mode]);
}

export interface EffectiveRollout {
  mode: RolloutMode;
  configuredMode: RolloutMode;
  fastTrackServices: string[];
  source: "CLIENT" | "DEFAULT" | "ENVIRONMENT";
  validated: boolean;
  reason: string | null;
  setAt: Date | null;
  setByName: string | null;
  aiEnabled: boolean;
  shadow: boolean;
}

type Row = typeof rolloutSettings.$inferSelect & { setByName: string | null };

function fromEnv(env: Pick<Env, "AUTOMATION_LEVEL" | "SHADOW_MODE">): Omit<Row, "id" | "createdAt"> & { createdAt: null } {
  return { clientId: null, mode: ceilingFromEnv(env), fastTrackServices: [ALL_SERVICES], reason: "Environment default (no rollout setting yet)", evaluationRunId: null, validated: false, setBy: null, setByName: null, createdAt: null };
}

function effective(row: (Omit<Row, "id" | "createdAt"> & { createdAt: Date | null }), source: EffectiveRollout["source"], env: Pick<Env, "AUTOMATION_LEVEL" | "SHADOW_MODE">): EffectiveRollout {
  const mode = applyEnv(row.mode, env);
  return {
    mode,
    configuredMode: row.mode,
    fastTrackServices: mode === "FAST_TRACK" ? (row.fastTrackServices as string[]) : [],
    source,
    validated: row.validated,
    reason: row.reason,
    setAt: row.createdAt,
    setByName: row.setByName,
    aiEnabled: mode !== "MANUAL",
    shadow: mode === "SHADOW",
  };
}

async function latestRows(db: Db): Promise<Row[]> {
  // Newest row per client (and for the default, clientId null).
  return (await db
    .select({ r: rolloutSettings, setByName: users.displayName })
    .from(rolloutSettings)
    .leftJoin(users, eq(users.id, rolloutSettings.setBy))
    .where(
      sql`${rolloutSettings.createdAt} = (select max(r2.created_at) from rollout_settings r2 where r2.client_id is not distinct from ${rolloutSettings.clientId})`,
    )).map(({ r, setByName }) => ({ ...r, setByName }));
}

export async function rolloutFor(db: Db, env: Pick<Env, "AUTOMATION_LEVEL" | "SHADOW_MODE">, clientId: string): Promise<EffectiveRollout> {
  const rows = await latestRows(db);
  const own = rows.find((r) => r.clientId === clientId);
  if (own) return effective(own, "CLIENT", env);
  const def = rows.find((r) => r.clientId === null);
  if (def) return effective(def, "DEFAULT", env);
  return effective(fromEnv(env), "ENVIRONMENT", env);
}

/** May a location with these required services use the Fast Lane under this rollout? */
export function fastLaneAllowed(r: EffectiveRollout, requiredServices: string[]): boolean {
  if (r.mode !== "FAST_TRACK") return false;
  return r.fastTrackServices.includes(ALL_SERVICES) || requiredServices.every((s) => r.fastTrackServices.includes(s));
}

export async function listRollout(db: Db, env: Env) {
  const rows = await latestRows(db);
  const cl = await db.select({ id: clients.id, code: clients.code, name: clients.displayName }).from(clients).orderBy(clients.displayName);
  const def = rows.find((r) => r.clientId === null);
  return {
    ceiling: ceilingFromEnv(env),
    shadowSwitch: env.SHADOW_MODE,
    default: def ? effective(def, "DEFAULT", env) : effective(fromEnv(env), "ENVIRONMENT", env),
    clients: await Promise.all(cl.map(async (c) => ({ ...c, rollout: await rolloutFor(db, env, c.id) }))),
  };
}

export async function rolloutHistory(db: Db, clientId: string | null) {
  return db
    .select({
      id: rolloutSettings.id,
      mode: rolloutSettings.mode,
      fastTrackServices: rolloutSettings.fastTrackServices,
      reason: rolloutSettings.reason,
      validated: rolloutSettings.validated,
      evaluationRunId: rolloutSettings.evaluationRunId,
      setByName: users.displayName,
      createdAt: rolloutSettings.createdAt,
    })
    .from(rolloutSettings)
    .leftJoin(users, eq(users.id, rolloutSettings.setBy))
    .where(clientId ? eq(rolloutSettings.clientId, clientId) : isNull(rolloutSettings.clientId))
    .orderBy(desc(rolloutSettings.createdAt))
    .limit(50);
}

export interface RolloutChange {
  clientId: string | null;
  mode: RolloutMode;
  fastTrackServices?: string[];
  reason: string;
  evaluationRunId?: string;
  /** Required to enable FAST_TRACK without validation evidence; recorded as such. */
  acknowledgeNoValidation?: boolean;
}

/**
 * Is the evaluation run usable evidence? It must have finished on real (non-demo) examples of
 * this client — at least the minimum sample — with zero false approvals in its sample.
 * This is a floor, not a business threshold: the business still decides (PRD §54).
 */
async function validates(db: Db, runId: string, clientName: string | null): Promise<boolean> {
  const [run] = await db.select().from(evaluationRuns).where(eq(evaluationRuns.id, runId));
  if (!run || run.status !== "SUCCEEDED" || !run.summary) return false;
  const s = run.summary as { examples: number; demoExamples: number; minSample: number; byClient: Record<string, { samples: number; falseApprovals: number }>; overall: { samples: number; falseApprovals: number } };
  if (s.examples - s.demoExamples < 1) return false;
  const scope = clientName ? s.byClient[clientName] : s.overall;
  return !!scope && scope.samples >= s.minSample && scope.falseApprovals === 0;
}

export async function setRollout(db: Db, env: Env, actor: Actor & { type: "USER" }, c: RolloutChange) {
  if (!ROLLOUT_MODES.includes(c.mode)) throw new RolloutError("Unknown mode", "INVALID");
  if (!c.reason.trim()) throw new RolloutError("Record the business reason for the change", "INVALID");
  const ceiling = ceilingFromEnv(env);
  if (RANK[c.mode] > RANK[ceiling]) {
    throw new RolloutError(`AUTOMATION_LEVEL=${env.AUTOMATION_LEVEL} in the server settings allows at most ${ceiling}. Raise it there first.`, "ABOVE_CEILING");
  }
  let clientName: string | null = null;
  if (c.clientId) {
    const [cl] = await db.select({ name: clients.displayName }).from(clients).where(eq(clients.id, c.clientId));
    if (!cl) throw new RolloutError("Unknown client", "INVALID");
    clientName = cl.name;
  }
  const fastTrack = c.mode === "FAST_TRACK" ? [...new Set(c.fastTrackServices ?? [])] : [];
  if (c.mode === "FAST_TRACK") {
    if (fastTrack.length === 0) throw new RolloutError("Choose the services that may use the Fast Lane", "INVALID");
    const known = new Set((await db.select({ code: services.code }).from(services)).map((s) => s.code));
    const unknown = fastTrack.filter((s) => !known.has(s));
    if (unknown.length) throw new RolloutError(`Unknown service: ${unknown.join(", ")}`, "INVALID");
  }
  const validated = c.evaluationRunId ? await validates(db, c.evaluationRunId, clientName) : false;
  if (c.mode === "FAST_TRACK" && !validated && !c.acknowledgeNoValidation) {
    throw new RolloutError(
      "No evaluation on real examples supports fast track for this scope. Confirm that the business approves enabling it anyway; this is recorded.",
      "VALIDATION_REQUIRED",
    );
  }

  const before = c.clientId ? await rolloutFor(db, env, c.clientId) : (await listRollout(db, env)).default;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(rolloutSettings)
      .values({ clientId: c.clientId, mode: c.mode, fastTrackServices: fastTrack, reason: c.reason.trim(), evaluationRunId: c.evaluationRunId ?? null, validated, setBy: actor.id })
      .returning();

    // Rollback (PRD §71): locations waiting in the Fast Lane that no longer qualify go back
    // to normal review at once.
    const others = c.clientId ? [] : (await latestRows(tx)).map((r) => r.clientId).filter((x): x is string => !!x);
    const waiting = await tx
      .select({ id: locations.id, clientId: locations.clientId })
      .from(locations)
      .where(
        and(
          eq(locations.lane, "FAST"),
          eq(locations.status, "HUMAN_REVIEW"),
          c.clientId ? eq(locations.clientId, c.clientId) : others.length ? notInArray(locations.clientId, others) : undefined,
        ),
      );
    const now = effective({ ...row!, setByName: null }, c.clientId ? "CLIENT" : "DEFAULT", env);
    const moved: string[] = [];
    for (const w of waiting) {
      const svc = (await tx.select({ code: locationServices.serviceCode }).from(locationServices).where(eq(locationServices.locationId, w.id))).map((r) => r.code);
      if (!fastLaneAllowed(now, svc)) moved.push(w.id);
    }
    if (moved.length) await tx.update(locations).set({ lane: "HUMAN_REVIEW" }).where(inArray(locations.id, moved));

    await recordAudit(tx, {
      eventType: "ROLLOUT_CHANGED",
      actor,
      entityType: "rollout_settings",
      entityId: row!.id,
      data: {
        clientId: c.clientId,
        from: before.configuredMode,
        to: c.mode,
        fastTrackServices: fastTrack,
        reason: c.reason.trim(),
        evaluationRunId: c.evaluationRunId ?? null,
        validated,
        acknowledgedWithoutValidation: c.mode === "FAST_TRACK" && !validated,
        movedOutOfFastLane: moved.length,
      },
    });
    return { setting: row!, movedOutOfFastLane: moved.length, effective: now };
  });
}

/** Minimum sample from the active thresholds, for the rollout page. */
export async function minSample(db: Db) {
  return (await loadActiveConfig(db)).thresholds.metrics.min_sample_size;
}
