/**
 * Model-agnostic vision interface (PRD §16–17).
 *
 * Providers return OBSERVATIONS only. They never return a service status,
 * recommendation, or approval — those are computed deterministically by the
 * evidence and risk engines. Response schemas and validation arrive in Phase 4.
 */
export interface VisionProvider {
  readonly info: VisionProviderInfo;
  analyzeImages(request: ImageAnalysisRequest): Promise<ProviderResponse[]>;
  comparePair(request: PairComparisonRequest): Promise<ProviderResponse>;
}

export interface VisionProviderInfo {
  provider: string;
  model: string;
  modelVersion: string;
}

export interface VisionImageInput {
  imageId: string;
  bytes: Buffer;
  mediaType: string;
}

export interface ServiceContext {
  code: string;
  displayName: string;
  description: string;
  evidenceTypes: { type: string; description: string; polarity: "positive" | "negative" | "context" }[];
  safetyNotes: string[];
}

export interface ImageAnalysisRequest {
  images: VisionImageInput[];
  services: ServiceContext[];
  promptVersion: string;
}

export interface PairComparisonRequest {
  before: VisionImageInput;
  after: VisionImageInput;
  services: ServiceContext[];
  promptVersion: string;
}

/**
 * Raw provider output. `output` is untrusted and MUST be schema-validated by the
 * caller before use; malformed output is never treated as evidence.
 */
export interface ProviderResponse {
  imageId?: string;
  output: unknown;
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
