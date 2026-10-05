import {
  IntegrationError,
  type NetSuiteAdapter,
  type NetSuiteImageRef,
  type NetSuiteLocation,
  type NetSuiteQueueItem,
  type VerificationNote,
  type VerificationWrite,
  type WriteAck,
} from "../NetSuiteAdapter";
import { MOCK_SCENARIOS, type MockFailure, type MockImageSpec, type MockScenario } from "./scenarios";

export const MOCK_IMAGE_LOCATOR_PREFIX = "mock://";

/**
 * In-memory NetSuite stand-in driven by scenarios. Supports failure injection,
 * idempotent writes, and images that appear on a later fetch (reprocessing demo).
 */
export class MockNetSuiteAdapter implements NetSuiteAdapter {
  readonly name = "mock-netsuite";

  private readonly scenarios: Map<string, MockScenario>;
  private readonly failureCounts = new Map<string, number>();
  private readonly imageFetches = new Map<string, number>();
  readonly verificationWrites = new Map<string, { externalId: string; write: VerificationWrite }>();
  readonly notes = new Map<string, { externalId: string; note: VerificationNote }>();

  constructor(
    scenarios: MockScenario[] = MOCK_SCENARIOS,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.scenarios = new Map(scenarios.map((s) => [s.externalId, s]));
  }

  async getQueue(): Promise<NetSuiteQueueItem[]> {
    const decided = new Set([...this.verificationWrites.values()].map((w) => w.externalId));
    return [...this.scenarios.values()]
      .filter((s) => !decided.has(s.externalId))
      .map((s) => ({
        externalId: s.externalId,
        clientCode: s.clientCode,
        receivedAt: new Date(this.now().getTime() - s.receivedMinutesAgo * 60_000),
      }));
  }

  async getLocation(externalId: string): Promise<NetSuiteLocation> {
    const s = this.scenario(externalId);
    this.maybeFail(`${externalId}:getLocation`, s.failures?.getLocation);
    return {
      externalId,
      externalLocationRef: `LOC-${externalId}`,
      clientCode: s.clientCode,
      name: s.name,
      serviceDate: new Date(s.serviceDate),
      existingVerificationStatus: null,
      raw: { mock: true, demoCase: s.demoCase ?? null, title: s.title },
    };
  }

  async getRequiredServices(externalId: string): Promise<string[]> {
    return [...(this.scenario(externalId).requiredServices ?? [])];
  }

  async getImages(externalId: string): Promise<NetSuiteImageRef[]> {
    const s = this.scenario(externalId);
    this.maybeFail(`${externalId}:getImages`, s.failures?.getImages);
    const fetches = (this.imageFetches.get(externalId) ?? 0) + 1;
    this.imageFetches.set(externalId, fetches);
    const specs = fetches > 1 ? [...s.images, ...(s.imagesAddedLater ?? [])] : s.images;
    return specs.map((spec) => toRef(externalId, spec));
  }

  async updateVerification(externalId: string, result: VerificationWrite): Promise<WriteAck> {
    const s = this.scenario(externalId);
    if (this.verificationWrites.has(result.idempotencyKey)) return { alreadyApplied: true };
    this.maybeFail(`${externalId}:updateVerification`, s.failures?.updateVerification);
    this.verificationWrites.set(result.idempotencyKey, { externalId, write: result });
    return { alreadyApplied: false, remoteRef: `MOCK-VERIFY-${this.verificationWrites.size}` };
  }

  async addVerificationNote(externalId: string, note: VerificationNote): Promise<WriteAck> {
    this.scenario(externalId);
    if (this.notes.has(note.idempotencyKey)) return { alreadyApplied: true };
    this.notes.set(note.idempotencyKey, { externalId, note });
    return { alreadyApplied: false, remoteRef: `MOCK-NOTE-${this.notes.size}` };
  }

  /** Lookup used by the mock image/vision providers (Phases 3–4). */
  findImageSpec(locator: string): { scenario: MockScenario; spec: MockImageSpec } | null {
    if (!locator.startsWith(MOCK_IMAGE_LOCATOR_PREFIX)) return null;
    const [externalId, ref] = locator.slice(MOCK_IMAGE_LOCATOR_PREFIX.length).split("/");
    const scenario = externalId ? this.scenarios.get(externalId) : undefined;
    const spec = scenario && [...scenario.images, ...(scenario.imagesAddedLater ?? [])].find((i) => i.ref === ref);
    return scenario && spec ? { scenario, spec } : null;
  }

  private scenario(externalId: string): MockScenario {
    const s = this.scenarios.get(externalId);
    if (!s) throw new IntegrationError(`Mock NetSuite: record ${externalId} not found`, "NETSUITE_VALIDATION");
    return s;
  }

  private maybeFail(key: string, failure: MockFailure | undefined): void {
    if (!failure) return;
    if (failure.kind === "AUTHENTICATION") {
      throw new IntegrationError(`Mock NetSuite: authentication failed (${key})`, "AUTHENTICATION");
    }
    if (failure.kind === "VALIDATION") {
      throw new IntegrationError(`Mock NetSuite: validation error (${key})`, "NETSUITE_VALIDATION");
    }
    const count = this.failureCounts.get(key) ?? 0;
    if (count < failure.times) {
      this.failureCounts.set(key, count + 1);
      throw new IntegrationError(`Mock NetSuite: transient failure ${count + 1}/${failure.times} (${key})`, "TRANSIENT");
    }
  }
}

function toRef(externalId: string, spec: MockImageSpec): NetSuiteImageRef {
  return {
    externalRef: spec.ref,
    filename: spec.filename,
    ordinal: spec.ordinal,
    ...(spec.capturedAt ? { capturedAt: new Date(spec.capturedAt) } : {}),
    locator: `${MOCK_IMAGE_LOCATOR_PREFIX}${externalId}/${spec.ref}`,
  };
}
