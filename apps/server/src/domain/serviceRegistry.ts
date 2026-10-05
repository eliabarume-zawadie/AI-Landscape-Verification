import type {
  ClientProfile,
  ServiceDefinition,
  ServiceRuleSet,
} from "@alvip/shared";

export class ServiceRegistry {
  private readonly byCode: ReadonlyMap<string, ServiceDefinition>;

  constructor(readonly ruleSet: ServiceRuleSet) {
    this.byCode = new Map(ruleSet.services.map((s) => [s.code, s]));
  }

  get version(): string {
    return this.ruleSet.version;
  }

  has(code: string): boolean {
    return this.byCode.has(code);
  }

  get(code: string): ServiceDefinition {
    const svc = this.byCode.get(code);
    if (!svc) throw new Error(`Unknown service "${code}" in rule set ${this.version}`);
    return svc;
  }

  list(): readonly ServiceDefinition[] {
    return this.ruleSet.services;
  }
}

/** Problems that make a client profile unusable with a given rule set. */
export function validateClientProfileAgainstRegistry(
  profile: ClientProfile,
  registry: ServiceRegistry,
): string[] {
  const problems: string[] = [];
  for (const code of profile.required_services) {
    if (!registry.has(code)) problems.push(`required service "${code}" is not defined`);
  }
  for (const [code, override] of Object.entries(profile.service_overrides)) {
    if (!registry.has(code)) {
      problems.push(`service_overrides references unknown service "${code}"`);
      continue;
    }
    const svc = registry.get(code);
    for (const comp of override.required_components ?? []) {
      if (!svc.components?.includes(comp)) {
        problems.push(`${code}: "${comp}" is not a component of this service`);
      }
    }
  }
  return problems.map((p) => `${profile.client}: ${p}`);
}

/** The rules that actually apply to one service for one client. */
export interface EffectiveServiceRules {
  code: string;
  displayName: string;
  requiresBeforeAfter: boolean;
  minimumConfidenceForAssistance: number;
  /** True when a rule (service default or client) forces human review regardless of evidence. */
  humanReviewRequiredByRule: boolean;
  humanReviewReasons: string[];
  requiredComponents: string[];
  definition: ServiceDefinition;
}

/**
 * Resolve effective rules.
 *
 * Precedence for before/after: client per-service override → client-wide setting → service default.
 * Confidence thresholds: a client override can only make a service STRICTER, never looser
 * (conservative default; documented as assumption in IMPLEMENTATION_PLAN).
 * Human-review flags are OR-ed: any rule requiring review wins.
 */
export function resolveServiceRules(
  registry: ServiceRegistry,
  profile: ClientProfile,
  serviceCode: string,
): EffectiveServiceRules {
  const def = registry.get(serviceCode);
  const override = profile.service_overrides[serviceCode] ?? {};

  const requiresBeforeAfter =
    override.requires_before_after ?? profile.before_after_required ?? def.requires_before_after;

  const minimumConfidenceForAssistance = Math.max(
    def.minimum_confidence_for_assistance,
    override.minimum_confidence_for_assistance ?? 0,
  );

  const humanReviewReasons: string[] = [];
  if (def.default_human_review) humanReviewReasons.push(`service ${def.code} defaults to human review`);
  if (profile.always_human_review) humanReviewReasons.push(`client ${profile.client} requires human review`);
  if (override.always_human_review) {
    humanReviewReasons.push(`client ${profile.client} requires human review for ${def.code}`);
  }

  return {
    code: def.code,
    displayName: def.display_name,
    requiresBeforeAfter,
    minimumConfidenceForAssistance,
    humanReviewRequiredByRule: humanReviewReasons.length > 0,
    humanReviewReasons,
    requiredComponents: override.required_components ?? def.components ?? [],
    definition: def,
  };
}

/**
 * Decide which services a work item must be verified for.
 * Services supplied by the source system (NetSuite) win; the client profile is the fallback.
 * Unknown codes are returned separately so they can be routed to the exception lane
 * rather than silently dropped.
 */
export function resolveRequiredServices(
  registry: ServiceRegistry,
  profile: ClientProfile,
  fromSource: readonly string[] | undefined,
): { services: string[]; unknown: string[]; source: "SOURCE_SYSTEM" | "CLIENT_PROFILE" } {
  const useSource = fromSource !== undefined && fromSource.length > 0;
  const candidates = useSource ? fromSource : profile.required_services;
  const unique = [...new Set(candidates)];
  return {
    services: unique.filter((c) => registry.has(c)),
    unknown: unique.filter((c) => !registry.has(c)),
    source: useSource ? "SOURCE_SYSTEM" : "CLIENT_PROFILE",
  };
}
