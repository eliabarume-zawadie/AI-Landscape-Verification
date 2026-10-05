/**
 * Model-agnostic vision interface (PRD §16–17).
 *
 * Providers return raw OBSERVATION output only. They never return a service status,
 * recommendation, or approval — those are computed deterministically by the evidence
 * and risk engines. Every response is validated by the caller
 * (domain/observations.ts) before use; providers are not trusted to validate.
 */
export interface VisionProvider {
  readonly info: VisionProviderInfo;
  analyzeImage(request: ImageAnalysisRequest): Promise<ProviderResponse>;
  /** Compare a candidate before/after pair (PRD §19). Same output contract rules. */
  comparePair(request: PairComparisonRequest): Promise<ProviderResponse>;
}

export interface VisionProviderInfo {
  provider: string;
  model: string;
  /** Provider-specific version detail (e.g. effort level, adapter version). */
  modelVersion: string;
  /** True when images leave this system (third-party API). */
  external: boolean;
}

export interface VisionImageInput {
  imageId: string;
  /** Source-system reference; real providers ignore it, the mock uses it. */
  externalRef: string;
  bytes: Buffer;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}

export interface ImageAnalysisRequest {
  image: VisionImageInput;
  /** Service codes to look for (subset of the active registry). */
  services: string[];
  /** Fully rendered instructions from a versioned prompt template. */
  prompt: string;
  promptLabel: string;
  /** JSON Schema for structured output, where the provider supports it. */
  outputSchema: Record<string, unknown>;
}

export interface PairComparisonRequest {
  before: VisionImageInput;
  after: VisionImageInput;
  /** Labels shown before each photo; defaults to BEFORE / AFTER. */
  labels?: [string, string];
  services: string[];
  prompt: string;
  promptLabel: string;
  outputSchema: Record<string, unknown>;
}

export interface ProviderResponse {
  /** Untrusted: parsed JSON object, or raw text when the provider returned non-JSON. */
  output: unknown;
  /** The model that actually produced the output (may differ after a server-side fallback). */
  servedModel: string;
  /** Provider declined to answer (safety refusal) — not an error, not evidence. */
  refused?: { category: string | null; explanation: string | null };
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  latencyMs: number;
}

export class VisionProviderError extends Error {
  override name = "VisionProviderError";
  constructor(
    message: string,
    readonly kind: "TRANSIENT" | "RATE_LIMIT" | "AUTHENTICATION" | "INVALID_REQUEST",
  ) {
    super(message);
  }
}
