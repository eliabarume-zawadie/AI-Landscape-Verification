import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError } from "../../config/env";
import { loadVerificationConfigFromDir } from "../../config/verificationConfig";
import type { DbHandle } from "../../db/client";
import { CONFIG_DIR, createTestDb, REPO_ROOT, testEnv } from "../../test/helpers";
import { createIntegrations } from "../index";
import { AnthropicVisionProvider } from "./anthropic/AnthropicVisionProvider";
import { MockVisionProvider } from "./mock/MockVisionProvider";
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

describe("vision provider selection", () => {
  it("uses the mock in mock mode", () => {
    expect(createIntegrations(testEnv()).vision).toBeInstanceOf(MockVisionProvider);
  });

  it("refuses to start without a configured provider when mocks are off", () => {
    expect(() => createIntegrations(testEnv({ MOCK_AI: "false" }))).toThrow(/VISION_PROVIDER/);
  });

  it("refuses to send images externally without explicit approval", () => {
    expect(() => createIntegrations(testEnv({ MOCK_AI: "false", VISION_PROVIDER: "anthropic" }))).toThrow(/ALLOW_EXTERNAL_AI_IMAGE_PROCESSING/);
  });

  it("builds the Claude adapter (default model claude-opus-5-5) when approved", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    try {
      const v = createIntegrations(
        testEnv({ MOCK_AI: "false", VISION_PROVIDER: "anthropic", ALLOW_EXTERNAL_AI_IMAGE_PROCESSING: "true" }),
      ).vision;
      expect(v).toBeInstanceOf(AnthropicVisionProvider);
      expect(v.info).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", external: true });
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
