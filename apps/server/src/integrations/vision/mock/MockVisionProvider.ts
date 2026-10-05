import type { ServiceRegistry } from "../../../domain/serviceRegistry";
import { MOCK_SCENARIOS, type MockImageSpec, type MockScenario } from "../../netsuite/mock/scenarios";
import {
  VisionProviderError,
  type ImageAnalysisRequest,
  type PairComparisonRequest,
  type ProviderResponse,
  type VisionProvider,
} from "../VisionProvider";

/** Polarity is assigned from the service registry during validation, not by providers. */
const STRENGTH = 0.9;

/**
 * Scripted vision model for mock mode. Reports exactly the `signals` defined on each
 * mock image spec (and only for requested services) so the downstream engines can be
 * exercised deterministically. Supports:
 *   - scenario failures.vision = "OUTAGE"  → provider error on every call
 *   - scenario failures.vision = "MALFORMED" → non-JSON on every call
 *   - spec visionResponse: MALFORMED_ONCE | HALLUCINATED_TYPE | REFUSAL
 */
export class MockVisionProvider implements VisionProvider {
  readonly info = { provider: "mock", model: "mock-vision", modelVersion: "1", external: false };
  readonly calls: string[] = [];
  readonly pairCalls: MockPairCall[] = [];
  private readonly specs = new Map<string, { scenario: MockScenario; spec: MockImageSpec }>();
  private readonly malformedOnceSeen = new Set<string>();

  /** Optional service registry: lets comparePair tell positive from negative signals. */
  constructor(
    scenarios: MockScenario[] = MOCK_SCENARIOS,
    private readonly registry?: ServiceRegistry,
  ) {
    for (const scenario of scenarios) {
      for (const spec of [...scenario.images, ...(scenario.imagesAddedLater ?? [])]) this.specs.set(spec.ref, { scenario, spec });
    }
  }

  async analyzeImage(req: ImageAnalysisRequest): Promise<ProviderResponse> {
    const ref = req.image.externalRef;
    this.calls.push(ref);
    const found = this.specs.get(ref);
    const base = { servedModel: this.info.model, usage: { inputTokens: 1600, outputTokens: 180, costUsd: 0 }, latencyMs: 5 };
    if (!found) {
      return { ...base, output: notRelevant("No scripted scene for this image.") };
    }
    const { scenario, spec } = found;

    if (scenario.failures?.vision === "OUTAGE") {
      throw new VisionProviderError("Mock vision provider unavailable (simulated outage)", "TRANSIENT");
    }
    if (scenario.failures?.vision === "MALFORMED") return { ...base, output: "Sure! The lawn looks great." };
    if (spec.visionResponse === "REFUSAL") {
      return { ...base, output: null, refused: { category: null, explanation: "Simulated refusal" } };
    }
    if (spec.visionResponse === "MALFORMED_ONCE" && !this.malformedOnceSeen.has(ref)) {
      this.malformedOnceSeen.add(ref);
      return { ...base, output: '{"image_relevant": true, "observations": [ {"service": "mow' };
    }
    if (spec.stage === "unrelated") return { ...base, output: notRelevant("A street view with no landscaped area.") };

    const observations: { service: string; evidence_type: string; strength: number; description: string }[] = [];
    for (const service of req.services) {
      for (const type of spec.signals?.[service] ?? []) {
        observations.push({
          service,
          evidence_type: type,
          strength: STRENGTH,
          description: `${type.replaceAll("_", " ")} visible in the ${spec.scene.replaceAll("_", " ")} (${spec.stage} photo).`,
        });
      }
    }
    if (spec.visionResponse === "HALLUCINATED_TYPE" && req.services[0]) {
      observations.push({
        service: req.services[0],
        evidence_type: "service_definitely_completed",
        strength: 0.99,
        description: "The service was clearly completed.",
      });
    }
    const covered = new Set(observations.map((o) => o.service));
    return {
      ...base,
      output: {
        image_relevant: true,
        visibility_issues: [],
        scene_summary: `${spec.stage} photo of the ${spec.scene.replaceAll("_", " ")}.`,
        observations,
        not_assessable: req.services
          .filter((s) => !covered.has(s))
          .map((service) => ({ service, reason: "Nothing relevant to this service is visible." })),
      },
    };
  }

  /**
   * Same area = same mock scene. Per requested service: negative signal in the AFTER
   * photo → NO_VISIBLE_CHANGE (work not done there); negative before + positive after →
   * IMPROVED. Nothing else is reported.
   */
  async comparePair(req: PairComparisonRequest): Promise<ProviderResponse> {
    this.pairCalls.push({ before: req.before.externalRef, after: req.after.externalRef });
    const base = { servedModel: this.info.model, usage: { inputTokens: 3200, outputTokens: 200, costUsd: 0 }, latencyMs: 5 };
    const before = this.specs.get(req.before.externalRef);
    const after = this.specs.get(req.after.externalRef);
    if (!before || !after) {
      return { ...base, output: { same_area: false, same_area_confidence: 0.9, comparison_possible: false, changes: [], notes: "Unknown photos." } };
    }
    if (before.scenario.failures?.vision === "OUTAGE") {
      throw new VisionProviderError("Mock vision provider unavailable (simulated outage)", "TRANSIENT");
    }
    if (req.services.length === 0) {
      const same = before.spec.scene === after.spec.scene;
      return { ...base, output: { same_area: same, same_area_confidence: 0.93, notes: same ? "Same landmarks." : "Different landmarks." } };
    }
    if (before.spec.scene !== after.spec.scene) {
      return {
        ...base,
        output: {
          same_area: false,
          same_area_confidence: 0.92,
          comparison_possible: false,
          changes: [],
          notes: `Different landmarks: ${before.spec.scene.replaceAll("_", " ")} vs ${after.spec.scene.replaceAll("_", " ")}.`,
        },
      };
    }
    const polarity = (service: string, type: string) =>
      this.registry?.has(service) ? this.registry.get(service).evidence_types.find((e) => e.type === type)?.polarity : undefined;
    const has = (spec: MockImageSpec, service: string, p: string) => (spec.signals?.[service] ?? []).some((t) => polarity(service, t) === p);

    const changes = [];
    for (const service of req.services) {
      if (has(after.spec, service, "negative")) {
        changes.push({ service, direction: "NO_VISIBLE_CHANGE", strength: 0.85, description: `The ${service.replaceAll("_", " ")} area still needs work in the after photo.` });
      } else if (has(before.spec, service, "negative") && has(after.spec, service, "positive")) {
        changes.push({ service, direction: "IMPROVED", strength: 0.9, description: `Visible improvement for ${service.replaceAll("_", " ")} between the photos.` });
      }
    }
    return {
      ...base,
      output: {
        same_area: true,
        same_area_confidence: 0.95,
        comparison_possible: true,
        changes,
        notes: `Same ${before.spec.scene.replaceAll("_", " ")} landmarks in both photos.`,
      },
    };
  }
}

export interface MockPairCall {
  before: string;
  after: string;
}

function notRelevant(summary: string) {
  return { image_relevant: false, visibility_issues: ["IRRELEVANT"], scene_summary: summary, observations: [], not_assessable: [] };
}
