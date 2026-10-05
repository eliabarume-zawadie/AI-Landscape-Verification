import Anthropic from "@anthropic-ai/sdk";
import {
  VisionProviderError,
  type ImageAnalysisRequest,
  type PairComparisonRequest,
  type ProviderResponse,
  type VisionImageInput,
  type VisionProvider,
  type VisionProviderInfo,
} from "../VisionProvider";

export interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
}

export interface AnthropicVisionOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Server-side refusal fallback ("default" routing). The served model is recorded either way. */
  fallbacks: boolean;
  pricing: Record<string, ModelPricing>;
  /** Injected for tests; defaults to a client that resolves credentials from the environment. */
  client?: Pick<Anthropic, "beta">;
}

/**
 * Claude vision adapter. One image per request with a JSON-schema output format; the
 * pipeline validates the result. Disabled unless explicitly configured (see
 * integrations/index.ts) because it sends client images to a third-party API (U9).
 */
export class AnthropicVisionProvider implements VisionProvider {
  readonly info: VisionProviderInfo;
  private readonly client: Pick<Anthropic, "beta">;

  constructor(private readonly opts: AnthropicVisionOptions) {
    // SDK retries 408/409/429/5xx itself (default 2); our job queue retries beyond that.
    this.client = opts.client ?? new Anthropic();
    this.info = {
      provider: "anthropic",
      model: opts.model,
      modelVersion: `effort=${opts.effort};fallbacks=${opts.fallbacks ? "default" : "off"}`,
      external: true,
    };
  }

  analyzeImage(req: ImageAnalysisRequest): Promise<ProviderResponse> {
    return this.send(req.prompt, req.outputSchema, [
      imageBlock(req.image),
      { type: "text", text: "Analyse this photograph according to the instructions and return the JSON object." },
    ]);
  }

  comparePair(req: PairComparisonRequest): Promise<ProviderResponse> {
    return this.send(req.prompt, req.outputSchema, [
      { type: "text", text: `${req.labels?.[0] ?? "BEFORE"} photo:` },
      imageBlock(req.before),
      { type: "text", text: `${req.labels?.[1] ?? "AFTER"} photo:` },
      imageBlock(req.after),
      { type: "text", text: "Compare the two photographs according to the instructions and return the JSON object." },
    ]);
  }

  private async send(
    system: string,
    schema: Record<string, unknown>,
    content: Anthropic.Beta.BetaContentBlockParam[],
  ): Promise<ProviderResponse> {
    const started = Date.now();
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.opts.model,
        max_tokens: 16000,
        ...(this.opts.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        output_config: { effort: this.opts.effort, format: { type: "json_schema", schema } },
        system,
        messages: [{ role: "user", content }],
      });
    } catch (err) {
      throw mapError(err);
    }

    const latencyMs = Date.now() - started;
    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd: this.cost(response.model, response.usage.input_tokens, response.usage.output_tokens),
    };

    if (response.stop_reason === "refusal") {
      const details = (response as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
      return {
        output: null,
        servedModel: response.model,
        refused: { category: details?.category ?? null, explanation: details?.explanation ?? null },
        usage,
        latencyMs,
      };
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let output: unknown = text;
    try {
      output = JSON.parse(text);
    } catch {
      // Left as text: the validator in the pipeline records it as malformed.
    }
    if (response.stop_reason === "max_tokens") output = { __truncated: true, text: text.slice(0, 200) };
    return { output, servedModel: response.model, usage, latencyMs };
  }

  private cost(model: string, input: number, output: number): number | undefined {
    const p = this.opts.pricing[model];
    if (!p) return undefined; // unknown model: cost left blank rather than guessed
    return (input * p.input_per_mtok + output * p.output_per_mtok) / 1_000_000;
  }
}

function imageBlock(image: VisionImageInput): Anthropic.Beta.BetaContentBlockParam {
  return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.bytes.toString("base64") } };
}

/** Map SDK errors onto the PRD §78 categories (most specific first). */
function mapError(err: unknown): VisionProviderError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new VisionProviderError(`Anthropic auth failed: ${err.message}`, "AUTHENTICATION");
  }
  if (err instanceof Anthropic.RateLimitError) return new VisionProviderError(`Anthropic rate limited: ${err.message}`, "RATE_LIMIT");
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.UnprocessableEntityError) {
    return new VisionProviderError(`Anthropic rejected the request: ${err.message}`, "INVALID_REQUEST");
  }
  if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIConnectionError) {
    return new VisionProviderError(`Anthropic API error: ${err.message}`, "TRANSIENT");
  }
  return new VisionProviderError(`Anthropic call failed: ${(err as Error)?.message ?? String(err)}`, "TRANSIENT");
}
