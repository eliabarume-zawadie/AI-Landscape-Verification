import { describe, expect, it } from "vitest";
import { clientProfileSchema, serviceRuleSetSchema, type ClientProfile } from "@alvip/shared";
import { loadVerificationConfigFromDir } from "../config/verificationConfig";
import { CONFIG_DIR } from "../test/helpers";
import {
  resolveRequiredServices,
  resolveServiceRules,
  ServiceRegistry,
  validateClientProfileAgainstRegistry,
} from "./serviceRegistry";

const config = loadVerificationConfigFromDir(CONFIG_DIR);
const registry = config.registry;

const profile = (over: Partial<ClientProfile> = {}): ClientProfile =>
  clientProfileSchema.parse({ client: "T", display_name: "Test", ...over });

describe("shipped configuration", () => {
  it("defines all nine PRD services", () => {
    expect(registry.list().map((s) => s.code).sort()).toEqual(
      [
        "dead_brown_grass",
        "edging",
        "landscape_fertilization",
        "landscape_maintenance",
        "mowing",
        "shrub_pruning",
        "trash_debris_leaves_removal",
        "tree_trimming_pruning",
        "weed_removal",
      ].sort(),
    );
  });

  it("marks equipment as insufficient on its own wherever it can be reported", () => {
    for (const svc of registry.list()) {
      if (svc.evidence_types.some((e) => e.type === "equipment_present")) {
        expect(svc.insufficient_alone, svc.code).toContain("equipment_present");
      }
    }
  });

  it("never lets healthy grass count as fertilization evidence", () => {
    const fert = registry.get("landscape_fertilization");
    const healthy = fert.evidence_types.find((e) => e.type === "healthy_lawn_appearance");
    expect(healthy?.polarity).toBe("context");
    expect(fert.insufficient_alone).toContain("healthy_lawn_appearance");
    expect(fert.default_human_review).toBe(true);
  });

  it("treats 'weeds reduced' and 'dead grass observed' as context, not support", () => {
    const weeds = registry.get("weed_removal").evidence_types.find((e) => e.type === "weeds_reduced");
    const dead = registry.get("dead_brown_grass").evidence_types.find((e) => e.type === "dead_brown_grass_observed");
    expect(weeds?.polarity).toBe("context");
    expect(dead?.polarity).toBe("context");
  });

  it("ships thresholds flagged as provisional", () => {
    expect(config.thresholds.provisional).toBe(true);
  });

  it("loads the demo client profiles", () => {
    expect([...config.clientProfiles.keys()].sort()).toEqual(["DEMO_CLIENT_A", "DEMO_CLIENT_B", "DEMO_CLIENT_C"]);
  });
});

describe("schema safety invariants", () => {
  it("rejects a client profile that disables the equipment rule", () => {
    const r = clientProfileSchema.safeParse({
      client: "X",
      display_name: "X",
      equipment_alone_is_insufficient: false,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a service that turns off human review on contradiction", () => {
    const svc = { ...registry.get("mowing"), requires_human_if_contradiction: false };
    expect(serviceRuleSetSchema.safeParse({ version: "x", services: [svc] }).success).toBe(false);
  });

  it("rejects insufficient_alone entries that reference unknown evidence types", () => {
    const svc = { ...registry.get("mowing"), insufficient_alone: ["nope"] };
    expect(serviceRuleSetSchema.safeParse({ version: "x", services: [svc] }).success).toBe(false);
  });

  it("rejects components that are not defined services", () => {
    const svc = { ...registry.get("landscape_maintenance"), components: ["mowing", "ghost"] };
    const r = serviceRuleSetSchema.safeParse({ version: "x", services: [svc, registry.get("mowing")] });
    expect(r.success).toBe(false);
  });
});

describe("validateClientProfileAgainstRegistry", () => {
  it("reports unknown services and components", () => {
    const problems = validateClientProfileAgainstRegistry(
      profile({
        required_services: ["mowing", "snow_removal"],
        service_overrides: { landscape_maintenance: { required_components: ["mowing", "irrigation"] } },
      }),
      registry,
    );
    expect(problems).toHaveLength(2);
    expect(problems.join()).toMatch(/snow_removal/);
    expect(problems.join()).toMatch(/irrigation/);
  });
});

describe("resolveServiceRules", () => {
  it("uses the service default when the client says nothing", () => {
    const r = resolveServiceRules(registry, profile(), "mowing");
    expect(r.requiresBeforeAfter).toBe(true);
    expect(r.humanReviewRequiredByRule).toBe(false);
  });

  it("applies client-wide before/after, then per-service override", () => {
    const p = profile({
      before_after_required: false,
      service_overrides: { edging: { requires_before_after: true } },
    });
    expect(resolveServiceRules(registry, p, "mowing").requiresBeforeAfter).toBe(false);
    expect(resolveServiceRules(registry, p, "edging").requiresBeforeAfter).toBe(true);
  });

  it("lets client overrides make confidence thresholds stricter but never looser", () => {
    const base = registry.get("mowing").minimum_confidence_for_assistance;
    const stricter = resolveServiceRules(
      registry,
      profile({ service_overrides: { mowing: { minimum_confidence_for_assistance: 0.99 } } }),
      "mowing",
    );
    const looser = resolveServiceRules(
      registry,
      profile({ service_overrides: { mowing: { minimum_confidence_for_assistance: 0.1 } } }),
      "mowing",
    );
    expect(stricter.minimumConfidenceForAssistance).toBe(0.99);
    expect(looser.minimumConfidenceForAssistance).toBe(base);
  });

  it("forces human review for fertilization even if the client does not ask for it", () => {
    const r = resolveServiceRules(registry, profile(), "landscape_fertilization");
    expect(r.humanReviewRequiredByRule).toBe(true);
    expect(r.humanReviewReasons.join()).toMatch(/defaults to human review/);
  });

  it("forces human review when the client requires it", () => {
    const r = resolveServiceRules(registry, profile({ always_human_review: true }), "mowing");
    expect(r.humanReviewRequiredByRule).toBe(true);
  });

  it("uses client-selected components for landscape maintenance", () => {
    const p = config.clientProfiles.get("DEMO_CLIENT_B")!;
    const r = resolveServiceRules(registry, p, "landscape_maintenance");
    expect(r.requiredComponents).toEqual(["mowing", "edging", "trash_debris_leaves_removal"]);
  });

  it("throws for unknown services", () => {
    expect(() => resolveServiceRules(registry, profile(), "snow_removal")).toThrow(/Unknown service/);
  });
});

describe("resolveRequiredServices", () => {
  const p = profile({ required_services: ["mowing", "edging"] });

  it("prefers services supplied by the source system", () => {
    const r = resolveRequiredServices(registry, p, ["weed_removal", "weed_removal"]);
    expect(r).toEqual({ services: ["weed_removal"], unknown: [], source: "SOURCE_SYSTEM" });
  });

  it("falls back to the client profile", () => {
    expect(resolveRequiredServices(registry, p, []).services).toEqual(["mowing", "edging"]);
    expect(resolveRequiredServices(registry, p, undefined).source).toBe("CLIENT_PROFILE");
  });

  it("surfaces unknown codes instead of dropping them silently", () => {
    const r = resolveRequiredServices(registry, p, ["mowing", "snow_removal"]);
    expect(r.services).toEqual(["mowing"]);
    expect(r.unknown).toEqual(["snow_removal"]);
  });
});

describe("ServiceRegistry", () => {
  it("exposes the rule-set version", () => {
    expect(new ServiceRegistry(registry.ruleSet).version).toBe("services-v1");
  });
});
