import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { DbHandle } from "../../db/client";
import { verificationJobs } from "../../db/schema";
import { createTestDb } from "../../test/helpers";
import { PgQueue } from "./PgQueue";
import { LeaseLostError } from "./QueueProvider";

let h: DbHandle;
let q: PgQueue;
const LEASE = 60_000;

beforeAll(async () => {
  h = await createTestDb({ seedConfig: false });
  q = new PgQueue(h.db, { baseMs: 10_000, capMs: 60_000 }, () => 0);
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.delete(verificationJobs);
});

const job = (key: string, extra: Partial<Parameters<PgQueue["enqueue"]>[0]> = {}) => ({
  type: "T",
  payload: { key },
  idempotencyKey: key,
  ...extra,
});

const expireLeases = () => h.db.execute(sql`update verification_jobs set locked_until = now() - interval '1 second' where status = 'RUNNING'`);

describe("PgQueue", () => {
  it("enqueues idempotently by key", async () => {
    const a = await q.enqueue(job("k1"));
    const b = await q.enqueue(job("k1"));
    expect(a.created).toBe(true);
    expect(b).toEqual({ jobId: a.jobId, created: false });
  });

  it("claims by priority, then oldest first, and never hands out a claimed job twice", async () => {
    await q.enqueue(job("old", { runAt: new Date(Date.now() - 60_000) }));
    await q.enqueue(job("new", { runAt: new Date(Date.now() - 1_000) }));
    await q.enqueue(job("urgent", { priority: 5 }));
    await q.enqueue(job("future", { runAt: new Date(Date.now() + 3_600_000) }));

    const first = await q.claim("w1", ["T"], 2, LEASE);
    expect(first.map((j) => j.payload.key)).toEqual(["urgent", "old"]);
    expect(first[0]!.attempts).toBe(1);

    const second = await q.claim("w2", ["T"], 10, LEASE);
    expect(second.map((j) => j.payload.key)).toEqual(["new"]);
    expect(await q.claim("w3", ["T"], 10, LEASE)).toEqual([]);
  });

  it("only claims registered job types", async () => {
    await q.enqueue(job("x", { type: "OTHER" }));
    expect(await q.claim("w", ["T"], 10, LEASE)).toEqual([]);
  });

  it("requires the lease holder to complete or heartbeat", async () => {
    await q.enqueue(job("k"));
    const [j] = await q.claim("w1", ["T"], 1, LEASE);
    await expect(q.complete(j!.id, "intruder")).rejects.toThrow(LeaseLostError);
    await expect(q.heartbeat(j!.id, "intruder", LEASE)).rejects.toThrow(LeaseLostError);
    await q.heartbeat(j!.id, "w1", LEASE);
    await q.complete(j!.id, "w1");
    const [row] = await h.db.select().from(verificationJobs).where(eq(verificationJobs.id, j!.id));
    expect(row!.status).toBe("SUCCEEDED");
    expect(row!.completedAt).not.toBeNull();
  });

  it("retries transient failures with backoff", async () => {
    await q.enqueue(job("k"));
    const [j] = await q.claim("w1", ["T"], 1, LEASE);
    expect(await q.fail(j!.id, "w1", { message: "timeout", category: "TRANSIENT" })).toBe("RETRY");
    const [row] = await h.db
      .select({ status: verificationJobs.status, delayed: sql<boolean>`${verificationJobs.runAt} > now() + interval '4 seconds'` })
      .from(verificationJobs)
      .where(eq(verificationJobs.id, j!.id));
    expect(row).toEqual({ status: "PENDING", delayed: true });
    expect(await q.claim("w1", ["T"], 1, LEASE)).toEqual([]); // not due yet
  });

  it("dead-letters non-retryable failures immediately", async () => {
    await q.enqueue(job("k"));
    const [j] = await q.claim("w1", ["T"], 1, LEASE);
    expect(await q.fail(j!.id, "w1", { message: "bad creds", category: "AUTHENTICATION" })).toBe("DEAD");
    const [row] = await h.db.select().from(verificationJobs).where(eq(verificationJobs.id, j!.id));
    expect(row!.status).toBe("DEAD");
    expect(row!.lastErrorCategory).toBe("AUTHENTICATION");
  });

  it("dead-letters after max attempts", async () => {
    const zero = new PgQueue(h.db, { baseMs: 0, capMs: 0 }, () => 0);
    await zero.enqueue(job("k", { maxAttempts: 2 }));
    let [j] = await zero.claim("w", ["T"], 1, LEASE);
    expect(await zero.fail(j!.id, "w", { message: "e", category: "TRANSIENT" })).toBe("RETRY");
    [j] = await zero.claim("w", ["T"], 1, LEASE);
    expect(j!.attempts).toBe(2);
    expect(await zero.fail(j!.id, "w", { message: "e", category: "TRANSIENT" })).toBe("DEAD");
  });

  it("recovers expired leases: requeues, or dead-letters when attempts are exhausted", async () => {
    await q.enqueue(job("retryable", { maxAttempts: 3 }));
    await q.enqueue(job("exhausted", { maxAttempts: 1 }));
    await q.claim("crashed-worker", ["T"], 10, LEASE);
    expect((await q.recoverExpiredLeases()).requeued).toBe(0); // leases still valid

    await expireLeases();
    const { requeued, dead } = await q.recoverExpiredLeases();
    expect(requeued).toBe(1);
    expect(dead.map((d) => d.payload.key)).toEqual(["exhausted"]);

    const [again] = await q.claim("w2", ["T"], 10, LEASE);
    expect(again!.payload.key).toBe("retryable");
    expect(again!.attempts).toBe(2);
  });

  it("lets enqueue join a caller's transaction (rolled back together)", async () => {
    await expect(
      h.db.transaction(async (tx) => {
        await q.enqueue(job("tx-job"), tx);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const rows = await h.db.select().from(verificationJobs).where(eq(verificationJobs.idempotencyKey, "tx-job"));
    expect(rows).toHaveLength(0);
  });
});
