import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError } from "../../config/env";
import { loadVerificationConfigFromDir } from "../../config/verificationConfig";
import type { DbHandle } from "../../db/client";
import { CONFIG_DIR, createTestDb, REPO_ROOT, testEnv } from "../../test/helpers";
import { createIntegrations } from "../index";
import { AnthropicVisionProvider } from "./anthropic/AnthropicVisionProvider";
import { MockVisionProvider } from "./mock/MockVisionProvider";
import { OpenAIVisionProvider } from "./openai/OpenAIVisionProvider";
import { IMAGE_ANALYSIS_PROMPT, loadPrompt, registerPrompt, renderImageAnalysisPrompt } from "./prompts";
import { VisionProviderError, type ImageAnalysisRequest } from "./VisionProvider";
import path from "node:path";

const { registry } = loadVerificationConfigFromDir(CONFIG_DIR);
const PROMPTS = path.join(REPO_ROOT, "prompts");

describe("image analysis prompt", () => {
  const prompt = loadPrompt(PROMPTS, IMAGE_ANALYSIS_PROMPT);
  const text = renderImageAnalysisPrompt(prompt, ["mowing", "landscape_fertilization"].map((s) => registry.get(s)));

  it("includes the PRD §60 hallucination rules", () => {
    for (const rule of [
      "Never claim evidence that is not visible",
      "Never infer work that cannot be seen",
      "are NOT evidence that a service was completed",
      "is NOT evidence of fertilization",
      "Do not assume a before/after relationship",
      "not_assessable",
    ]) {
      expect(text).toContain(rule);
    }
  });

  it("renders requested services with evidence types, polarity and safety notes", () => {
    expect(text).toContain("### mowing — Mowing");
    expect(text).toContain("`uncut_section_visible` (counts AGAINST");
    expect(text).toContain("`healthy_lawn_appearance` (context only");
    expect(text).toContain("Healthy or green grass does NOT prove fertilization.");
    expect(text).not.toContain("### edging");
    expect(text).not.toContain("{{SERVICES}}");
  });

  it("fails clearly for a missing prompt version", () => {
    expect(() => loadPrompt(PROMPTS, { name: "image_analysis", version: "v99" })).toThrow(ConfigError);
  });

  describe("registration", () => {
    let h: DbHandle;
    beforeAll(async () => {
      h = await createTestDb({ seedConfig: false });
    });
    afterAll(async () => {
      await h.close();
    });

    it("is idempotent, and refuses an edited prompt under the same version", async () => {
      await registerPrompt(h.db, prompt);
      await registerPrompt(h.db, prompt);
      await expect(registerPrompt(h.db, { ...prompt, template: `${prompt.template}\nextra`, contentHash: "different" })).rejects.toThrow(
        /modified after it was first used/,
      );
    });
  });
});

// ------------------------------------------------------------------ Claude adapter

type CreateArgs = Record<string, unknown> & { messages: { content: { type: string; source?: { data: string } }[] }[] };

function stubClient(respond: (args: CreateArgs) => unknown) {
  const calls: CreateArgs[] = [];
  const client = {
    beta: {
      messages: {
        create: async (args: CreateArgs) => {
          calls.push(args);
          const r = respond(args);
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  } as unknown as Pick<Anthropic, "beta">;
  return { client, calls };
}

const request: ImageAnalysisRequest = {
  image: { imageId: "img-1", externalRef: "REF-1", bytes: Buffer.from("jpeg-bytes"), mediaType: "image/jpeg" },
  services: ["mowing"],
  prompt: "SYSTEM PROMPT",
  promptLabel: "image_analysis_v1@abc",
  outputSchema: { type: "object" },
};
const pricing = { "claude-opus-5-5": { input_per_mtok: 4, output_per_mtok: 20 }, "claude-opus-4-8": { input_per_mtok: 5, output_per_mtok: 25 } };
const message = (over: Record<string, unknown> = {}) => ({
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: '{"image_relevant": true}' }],
  usage: { input_tokens: 2000, output_tokens: 300 },
  ...over,
});

describe("AnthropicVisionProvider", () => {
  it("sends one image with the JSON schema, effort, and default refusal fallback", async () => {
    const { client, calls } = stubClient(() => message());
    const p = new AnthropicVisionProvider({ model: "claude-opus-5-5", effort: "high", fallbacks: true, pricing, client });
    const r = await p.analyzeImage(request);

    const args = calls[0]!;
    expect(args).toMatchObject({
      model: "claude-opus-5-5",
      system: "SYSTEM PROMPT",
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema", schema: { type: "object" } } },
    });
    expect(args.messages[0]!.content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg" } });
    expect(args.messages[0]!.content[0]!.source!.data).toBe(Buffer.from("jpeg-bytes").toString("base64"));
    expect(r.output).toEqual({ image_relevant: true });
    expect(r.usage.costUsd).toBeCloseTo((2000 * 4 + 300 * 20) / 1e6);
    expect(p.info.external).toBe(true);
  });

  it("omits fallbacks when disabled", async () => {
    const { client, calls } = stubClient(() => message());
    await new AnthropicVisionProvider({ model: "claude-opus-5-5", effort: "medium", fallbacks: false, pricing, client }).analyzeImage(request);
    expect(calls[0]!.fallbacks).toBeUndefined();
    expect(calls[0]!.betas).toBeUndefined();
  });

  it("records the model that actually served the request (fallback) and prices it", async () => {
    const { client } = stubClient(() => message({ model: "claude-opus-4-8" }));
    const r = await new AnthropicVisionProvider({ model: "claude-opus-5-5", effort: "high", fallbacks: true, pricing, client }).analyzeImage(request);
    expect(r.servedModel).toBe("claude-opus-4-8");
    expect(r.usage.costUsd).toBeCloseTo((2000 * 5 + 300 * 25) / 1e6);
  });

  it("leaves cost blank for an unpriced model instead of guessing", async () => {
    const { client } = stubClient(() => message({ model: "claude-unknown" }));
    const r = await new AnthropicVisionProvider({ model: "claude-opus-5-5", effort: "high", fallbacks: true, pricing, client }).analyzeImage(request);
    expect(r.usage.costUsd).toBeUndefined();
  });

  it("reports a refusal as refused, not as output", async () => {
    const { client } = stubClient(() =>
      message({ stop_reason: "refusal", content: [], stop_details: { type: "refusal", category: "other", explanation: "declined" } }),
    );
    const r = await new AnthropicVisionProvider({ model: "claude-opus-5-5", effort: "high", fallbacks: true, pricing, client }).analyzeImage(request);
    expect(r.refused).toEqual({ category: "other", explanation: "declined" });
    expect(r.output).toBeNull();
  });

  it("passes non-JSON and truncated output through for the validator to reject", async () => {
    const text = await new AnthropicVisionProvider({
      model: "claude-opus-5-5",
      effort: "high",
      fallbacks: false,
      pricing,
      client: stubClient(() => message({ content: [{ type: "text", text: "not json" }] })).client,
    }).analyzeImage(request);
    expect(text.output).toBe("not json");

    const truncated = await new AnthropicVisionProvider({
      model: "claude-opus-5-5",
      effort: "high",
      fallbacks: false,
      pricing,
      client: stubClient(() => message({ stop_reason: "max_tokens" })).client,
    }).analyzeImage(request);
    expect(truncated.output).toMatchObject({ __truncated: true });
  });

  it("maps SDK errors onto retry categories", async () => {
    const fail = async (err: Error) =>
      new AnthropicVisionProvider({ model: "m", effort: "high", fallbacks: false, pricing, client: stubClient(() => err).client })
        .analyzeImage(request)
        .catch((e: VisionProviderError) => e.kind);
    const sdkError = <T extends object>(cls: { prototype: T }) => Object.assign(Object.create(cls.prototype) as T & Error, { message: "x" });

    expect(await fail(sdkError(Anthropic.AuthenticationError))).toBe("AUTHENTICATION");
    expect(await fail(sdkError(Anthropic.RateLimitError))).toBe("RATE_LIMIT");
    expect(await fail(sdkError(Anthropic.BadRequestError))).toBe("INVALID_REQUEST");
    expect(await fail(sdkError(Anthropic.InternalServerError))).toBe("TRANSIENT");
    expect(await fail(new Error("socket hang up"))).toBe("TRANSIENT");
  });
});

// ------------------------------------------------------------------ OpenAI adapter

function stubOpenAI(respond: () => unknown) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (args: Record<string, unknown>) => {
          calls.push(args);
          const r = respond();
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  } as unknown as Pick<OpenAI, "chat">;
  return { client, calls };
}
const completion = (message: Record<string, unknown>, finishReason = "stop") => ({
  model: "gpt-test-served",
  choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content: null, refusal: null, ...message } }],
  usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
});
const openaiPricing = { "gpt-test-served": { input_per_mtok: 2, output_per_mtok: 8 } };
const openai = (respond: () => unknown, pricingTable: Record<string, { input_per_mtok: number; output_per_mtok: number }> = {}) =>
  new OpenAIVisionProvider({ model: "gpt-test", pricing: pricingTable, client: stubOpenAI(respond).client });

describe("OpenAIVisionProvider", () => {
  it("sends the image as a data URL with a strict JSON schema", async () => {
    const { client, calls } = stubOpenAI(() => completion({ content: '{"image_relevant": false}' }));
    const p = new OpenAIVisionProvider({ model: "gpt-test", pricing: openaiPricing, client });
    const r = await p.analyzeImage(request);

    expect(calls[0]).toMatchObject({
      model: "gpt-test",
      response_format: { type: "json_schema", json_schema: { name: "image_analysis", schema: { type: "object" }, strict: true } },
    });
    const messages = calls[0]!.messages as { role: string; content: unknown }[];
    expect(messages[0]).toEqual({ role: "system", content: "SYSTEM PROMPT" });
    const image = (messages[1]!.content as { type: string; image_url?: { url: string; detail: string } }[])[0]!;
    expect(image.image_url!.url).toBe(`data:image/jpeg;base64,${Buffer.from("jpeg-bytes").toString("base64")}`);
    expect(image.image_url!.detail).toBe("high");

    expect(r).toMatchObject({ output: { image_relevant: false }, servedModel: "gpt-test-served" });
    expect(r.usage.costUsd).toBeCloseTo((1000 * 2 + 200 * 8) / 1e6);
    expect(p.info).toMatchObject({ provider: "openai", model: "gpt-test", external: true });
  });

  it("reports refusals and content filtering as refused", async () => {
    const refusal = await openai(() => completion({ refusal: "Cannot help with that." })).analyzeImage(request);
    expect(refusal).toMatchObject({ output: null, refused: { explanation: "Cannot help with that." } });
    expect(refusal.usage.costUsd).toBeUndefined();

    const filtered = await openai(() => completion({ content: "" }, "content_filter")).analyzeImage(request);
    expect(filtered.refused).toMatchObject({ category: "content_filter" });
  });

  it("passes non-JSON and truncated output through for the validator to reject", async () => {
    expect((await openai(() => completion({ content: "nope" })).analyzeImage(request)).output).toBe("nope");
    const cut = await openai(() => completion({ content: '{"a":' }, "length")).analyzeImage(request);
    expect(cut.output).toMatchObject({ __truncated: true });
  });

  it("maps SDK errors onto retry categories", async () => {
    const fail = async (err: Error) => openai(() => err).analyzeImage(request).catch((e: VisionProviderError) => e.kind);
    const sdkError = <T extends object>(cls: { prototype: T }) => Object.assign(Object.create(cls.prototype) as T & Error, { message: "x" });
    expect(await fail(sdkError(OpenAI.AuthenticationError))).toBe("AUTHENTICATION");
    expect(await fail(sdkError(OpenAI.RateLimitError))).toBe("RATE_LIMIT");
    expect(await fail(sdkError(OpenAI.BadRequestError))).toBe("INVALID_REQUEST");
    expect(await fail(sdkError(OpenAI.InternalServerError))).toBe("TRANSIENT");
    expect(await fail(new Error("ECONNRESET"))).toBe("TRANSIENT");
  });
});

// ------------------------------------------------------------------ selection

function withEnvKeys<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  for (const k of Object.keys(saved)) process.env[k] = "test-key-not-real";
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const real = (extra: Record<string, string> = {}) =>
  testEnv({ MOCK_AI: "false", ALLOW_EXTERNAL_AI_IMAGE_PROCESSING: "true", ...extra });

describe("vision provider selection", () => {
  it("uses the mock in mock mode", () => {
    expect(createIntegrations(testEnv()).vision).toBeInstanceOf(MockVisionProvider);
  });

  it("defaults to Anthropic (claude-opus-5-5) when mocks are off", () => {
    expect(testEnv().VISION_PROVIDER).toBe("anthropic");
    const v = withEnvKeys(() => createIntegrations(real()).vision);
    expect(v).toBeInstanceOf(AnthropicVisionProvider);
    expect(v.info).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", external: true });
  });

  it("switches to OpenAI with an explicit model", () => {
    const v = withEnvKeys(() => createIntegrations(real({ VISION_PROVIDER: "openai", VISION_MODEL: "my-openai-vision-model" })).vision);
    expect(v).toBeInstanceOf(OpenAIVisionProvider);
    expect(v.info).toMatchObject({ provider: "openai", model: "my-openai-vision-model" });
  });

  it("refuses OpenAI without a model rather than guessing one", () => {
    expect(() => withEnvKeys(() => createIntegrations(real({ VISION_PROVIDER: "openai" })))).toThrow(/set VISION_MODEL/);
  });

  it("lets VISION_MODEL override the Anthropic default", () => {
    const v = withEnvKeys(() => createIntegrations(real({ VISION_MODEL: "claude-sonnet-5-5" })).vision);
    expect(v.info.model).toBe("claude-sonnet-5-5");
  });

  it("rejects unknown providers", () => {
    expect(() => testEnv({ VISION_PROVIDER: "someone-else" })).toThrow(/VISION_PROVIDER/);
  });

  it.each(["anthropic", "openai"])("never sends images to %s without explicit approval", (provider) => {
    expect(() => createIntegrations(testEnv({ MOCK_AI: "false", VISION_PROVIDER: provider, VISION_MODEL: "x" }))).toThrow(
      /ALLOW_EXTERNAL_AI_IMAGE_PROCESSING/,
    );
  });
});
