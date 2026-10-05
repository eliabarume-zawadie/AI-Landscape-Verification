import type { Env } from "../config/env";
import type { DbHandle } from "../db/client";
import { MockImageProvider } from "../integrations/images/mock/MockImageProvider";
import { MockNetSuiteAdapter } from "../integrations/netsuite/mock/MockNetSuiteAdapter";
import { MockVisionProvider } from "../integrations/vision/mock/MockVisionProvider";
import { MOCK_SCENARIOS, type MockScenario } from "../integrations/netsuite/mock/scenarios";
import { PgQueue } from "../integrations/queue/PgQueue";
import { MemoryStorageProvider } from "../integrations/storage/LocalStorageProvider";
import type { Logger } from "../pipeline/jobHandler";
import type { Worker } from "../pipeline/worker";
import { createWorker, type Runtime } from "../runtime";
import { ingestQueue } from "../services/ingest";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { CONFIG_DIR, createTestDb, testEnv } from "./helpers";

export const silentLog: Logger = { info() {}, warn() {}, error() {} };

export interface Harness {
  h: DbHandle;
  env: Env;
  netsuite: MockNetSuiteAdapter;
  storage: MemoryStorageProvider;
  vision: MockVisionProvider;
  queue: PgQueue;
  runtime: Runtime;
  worker: Worker;
  ingest(): ReturnType<typeof ingestQueue>;
  close(): Promise<void>;
}

/** Fresh DB + mock NetSuite + queue with zero backoff (retries are immediately due). */
export async function createHarness(
  opts: { scenarios?: MockScenario[]; env?: Record<string, string> } = {},
): Promise<Harness> {
  const h = await createTestDb();
  const env = testEnv({ NETSUITE_POLL_INTERVAL_SEC: "0", RETENTION_SWEEP_INTERVAL_SEC: "0", ...opts.env });
  const netsuite = new MockNetSuiteAdapter(opts.scenarios ?? MOCK_SCENARIOS);
  const queue = new PgQueue(h.db, { baseMs: 0, capMs: 0 }, () => 0);
  const images = new MockImageProvider(opts.scenarios ?? MOCK_SCENARIOS);
  const storage = new MemoryStorageProvider();
  const vision = new MockVisionProvider(opts.scenarios ?? MOCK_SCENARIOS, loadVerificationConfigFromDir(CONFIG_DIR).registry);
  const runtime: Runtime = { queue, integrations: { netsuite, images, storage, vision } };
  const worker = createWorker(env, h.db, runtime, silentLog, { pollNetSuite: false });
  return {
    h,
    env,
    netsuite,
    storage,
    vision,
    queue,
    runtime,
    worker,
    ingest: () => ingestQueue({ db: h.db, netsuite, queue, actor: { type: "SYSTEM", id: "test" } }),
    close: () => h.close(),
  };
}

export function scenario(externalId: string): MockScenario {
  const s = MOCK_SCENARIOS.find((x) => x.externalId === externalId);
  if (!s) throw new Error(`no scenario ${externalId}`);
  return s;
}
