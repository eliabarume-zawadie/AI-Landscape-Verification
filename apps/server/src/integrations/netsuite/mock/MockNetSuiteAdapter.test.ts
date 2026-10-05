import { describe, expect, it } from "vitest";
import { loadVerificationConfigFromDir } from "../../../config/verificationConfig";
import { CONFIG_DIR } from "../../../test/helpers";
import { IntegrationError } from "../NetSuiteAdapter";
import { MockNetSuiteAdapter } from "./MockNetSuiteAdapter";
import { MOCK_SCENARIOS } from "./scenarios";

const write = (key: string) => ({
  idempotencyKey: key,
  decision: "APPROVE" as const,
  reviewerName: "R",
  decidedAt: new Date(),
  processingRunId: null,
  serviceDecisions: {},
});

describe("mock scenarios", () => {
  const config = loadVerificationConfigFromDir(CONFIG_DIR);

  it("covers all ten demonstration cases from the master prompt", () => {
    const cases = MOCK_SCENARIOS.map((s) => s.demoCase).filter(Boolean).sort((a, b) => a! - b!);
    expect(cases).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("has unique external IDs and unique image refs", () => {
    const ids = MOCK_SCENARIOS.map((s) => s.externalId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of MOCK_SCENARIOS) {
      const refs = [...s.images, ...(s.imagesAddedLater ?? [])].map((i) => i.ref);
      expect(new Set(refs).size, s.externalId).toBe(refs.length);
    }
  });

  it("only uses evidence types defined in the service registry", () => {
    for (const s of MOCK_SCENARIOS) {
      for (const img of [...s.images, ...(s.imagesAddedLater ?? [])]) {
        for (const [service, types] of Object.entries(img.signals ?? {})) {
          const def = config.registry.get(service);
          for (const t of types) {
            expect(def.evidence_types.map((e) => e.type), `${s.externalId}/${img.ref}/${service}`).toContain(t);
          }
        }
      }
    }
  });

  it("includes a 170-image location", () => {
    expect(Math.max(...MOCK_SCENARIOS.map((s) => s.images.length))).toBe(170);
  });
});

describe("MockNetSuiteAdapter", () => {
  it("lists the queue with received times in the past", async () => {
    const ns = new MockNetSuiteAdapter();
    const q = await ns.getQueue();
    expect(q).toHaveLength(MOCK_SCENARIOS.length);
    expect(q.every((i) => i.receivedAt.getTime() < Date.now())).toBe(true);
  });

  it("returns image refs with resolvable mock locators", async () => {
    const ns = new MockNetSuiteAdapter();
    const refs = await ns.getImages("NS-DEMO-001");
    expect(refs).toHaveLength(8);
    expect(ns.findImageSpec(refs[0]!.locator)?.spec.ref).toBe(refs[0]!.externalRef);
  });

  it("adds late images on the second fetch", async () => {
    const ns = new MockNetSuiteAdapter();
    expect(await ns.getImages("NS-DEMO-010")).toHaveLength(2);
    expect(await ns.getImages("NS-DEMO-010")).toHaveLength(4);
  });

  it("injects transient failures the configured number of times", async () => {
    const ns = new MockNetSuiteAdapter();
    for (let i = 0; i < 2; i++) {
      await expect(ns.getImages("NS-DEMO-015")).rejects.toMatchObject({ category: "TRANSIENT" });
    }
    expect(await ns.getImages("NS-DEMO-015")).toHaveLength(2);
  });

  it("makes writes idempotent and removes decided items from the queue", async () => {
    const ns = new MockNetSuiteAdapter();
    expect((await ns.updateVerification("NS-DEMO-001", write("k1"))).alreadyApplied).toBe(false);
    expect((await ns.updateVerification("NS-DEMO-001", write("k1"))).alreadyApplied).toBe(true);
    expect((await ns.getQueue()).map((i) => i.externalId)).not.toContain("NS-DEMO-001");
  });

  it("fails sync for the NetSuite-failure demo case, then succeeds", async () => {
    const ns = new MockNetSuiteAdapter();
    for (let i = 0; i < 3; i++) {
      await expect(ns.updateVerification("NS-DEMO-007", write("k7"))).rejects.toBeInstanceOf(IntegrationError);
    }
    expect((await ns.updateVerification("NS-DEMO-007", write("k7"))).alreadyApplied).toBe(false);
  });

  it("reports unknown records as validation errors", async () => {
    await expect(new MockNetSuiteAdapter().getLocation("NOPE")).rejects.toMatchObject({ category: "NETSUITE_VALIDATION" });
  });
});
