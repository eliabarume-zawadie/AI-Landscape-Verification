import OpenAI from "openai";
import type { ModelPricing } from "../anthropic/AnthropicVisionProvider";
import {
  VisionProviderError,
  type ImageAnalysisRequest,
  type ProviderResponse,
  type VisionProvider,
  type VisionProviderInfo,
} from "../VisionProvider";

export interface OpenAIVisionOptions {
  /** Must be set explicitly (no default OpenAI model is assumed). */
  model: string;
  pricing: Record<string, ModelPricing>;
  /** Injected for tests; defaults to a client reading OPENAI_API_KEY / OPENAI_BASE_URL. */
  client?: Pick<OpenAI, "chat">;
}

/**
 * OpenAI vision adapter (Chat Completions + strict JSON-schema structured output).
 * Same contract as every provider: raw output in, validation happens in the pipeline.
 * OPENAI_BASE_URL can point the SDK at an OpenAI-compatible endpoint (e.g. Azure OpenAI
 * or a self-hosted model server) — its output is validated just the same.
 */
export class OpenAIVisionProvider implements VisionProvider {
  readonly info: VisionProviderInfo;
  private readonly client: Pick<OpenAI, "chat">;

  constructor(private readonly opts: OpenAIVisionOptions) {
    this.client = opts.client ?? new OpenAI();
    this.info = { provider: "openai", model: opts.model, modelVersion: "chat-completions;detail=high", external: true };
  }

  async analyzeImage(req: ImageAnalysisRequest): Promise<ProviderResponse> {
    const started = Date.now();
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await this.client.chat.completions.create({
        model: this.opts.model,
        messages: [
          { role: "system", content: req.prompt },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:${req.image.mediaType};base64,${req.image.bytes.toString("base64")}`, detail: "high" },
              },
              { type: "text", text: "Analyse this photograph according to the instructions and return the JSON object." },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "image_analysis", schema: req.outputSchema, strict: true },
        },
      });
    } catch (err) {
      throw mapError(err);
    }

    const latencyMs = Date.now() - started;
    const input = response.usage?.prompt_tokens;
    const output = response.usage?.completion_tokens;
    const usage = {
      ...(input !== undefined ? { inputTokens: input } : {}),
      ...(output !== undefined ? { outputTokens: output } : {}),
      ...(input !== undefined && output !== undefined ? costOf(this.opts.pricing[response.model], input, output) : {}),
    };

    const choice = response.choices[0];
    if (choice?.message.refusal) {
      return { output: null, servedModel: response.model, refused: { category: null, explanation: choice.message.refusal }, usage, latencyMs };
    }
    const text = choice?.message.content ?? "";
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Left as text: the pipeline's validator records it as malformed.
    }
    if (choice?.finish_reason === "length") parsed = { __truncated: true, text: text.slice(0, 200) };
    if (choice?.finish_reason === "content_filter") {
      return { output: null, servedModel: response.model, refused: { category: "content_filter", explanation: null }, usage, latencyMs };
    }
    return { output: parsed, servedModel: response.model, usage, latencyMs };
  }
}

function costOf(p: ModelPricing | undefined, input: number, output: number): { costUsd?: number } {
  // Unknown model: cost left blank rather than guessed.
  return p ? { costUsd: (input * p.input_per_mtok + output * p.output_per_mtok) / 1_000_000 } : {};
}

/** Map SDK errors onto the PRD §78 categories (most specific first). */
function mapError(err: unknown): VisionProviderError {
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new VisionProviderError(`OpenAI auth failed: ${err.message}`, "AUTHENTICATION");
  }
  if (err instanceof OpenAI.RateLimitError) return new VisionProviderError(`OpenAI rate limited: ${err.message}`, "RATE_LIMIT");
  if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.NotFoundError || err instanceof OpenAI.UnprocessableEntityError) {
    return new VisionProviderError(`OpenAI rejected the request: ${err.message}`, "INVALID_REQUEST");
  }
  if (err instanceof OpenAI.APIError) return new VisionProviderError(`OpenAI API error: ${err.message}`, "TRANSIENT");
  return new VisionProviderError(`OpenAI call failed: ${(err as Error)?.message ?? String(err)}`, "TRANSIENT");
}
