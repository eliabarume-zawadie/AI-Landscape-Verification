import { readFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, type Env } from "../config/env";
import { AnthropicVisionProvider, type ModelPricing } from "./vision/anthropic/AnthropicVisionProvider";
import { MockVisionProvider } from "./vision/mock/MockVisionProvider";
import type { VisionProvider } from "./vision/VisionProvider";
import type { ImageProvider } from "./images/ImageProvider";
import { MockImageProvider } from "./images/mock/MockImageProvider";
import { MockNetSuiteAdapter } from "./netsuite/mock/MockNetSuiteAdapter";
import type { NetSuiteAdapter } from "./netsuite/NetSuiteAdapter";
import { LocalStorageProvider } from "./storage/LocalStorageProvider";
import type { StorageProvider } from "./storage/StorageProvider";

export interface Integrations {
  netsuite: NetSuiteAdapter;
  images: ImageProvider;
  storage: StorageProvider;
  vision: VisionProvider;
}

/**
 * Select adapter implementations from configuration. Production adapters that depend
 * on unknown integration details refuse to start instead of guessing (plan §13).
 */
export function createIntegrations(env: Env): Integrations {
  return {
    netsuite: createNetSuiteAdapter(env),
    images: createImageProvider(env),
    storage: new LocalStorageProvider(env.STORAGE_DIR),
    vision: createVisionProvider(env),
  };
}

function createVisionProvider(env: Env): VisionProvider {
  if (env.MOCK_AI) return new MockVisionProvider();
  if (env.VISION_PROVIDER !== "anthropic") {
    throw new ConfigError("MOCK_AI=false requires VISION_PROVIDER (supported: anthropic).");
  }
  if (!env.ALLOW_EXTERNAL_AI_IMAGE_PROCESSING) {
    throw new ConfigError(
      "VISION_PROVIDER=anthropic sends client images to a third-party API. Set " +
        "ALLOW_EXTERNAL_AI_IMAGE_PROCESSING=true only after data-processing approval (IMPLEMENTATION_PLAN U9).",
    );
  }
  const pricing = JSON.parse(readFileSync(path.join(env.CONFIG_DIR, "model-pricing.json"), "utf8")) as {
    models: Record<string, ModelPricing>;
  };
  return new AnthropicVisionProvider({
    model: env.VISION_MODEL,
    effort: env.VISION_EFFORT,
    fallbacks: env.VISION_FALLBACKS,
    pricing: pricing.models,
  });
}

function createNetSuiteAdapter(env: Env): NetSuiteAdapter {
  if (env.MOCK_NETSUITE) return new MockNetSuiteAdapter();
  throw new ConfigError(
    "Production NetSuite adapter is not implemented yet: it is blocked on NetSuite record types, " +
      "field IDs, auth method, and image storage details (IMPLEMENTATION_PLAN unknowns U1–U6). " +
      "Set MOCK_NETSUITE=true for development.",
  );
}

function createImageProvider(env: Env): ImageProvider {
  if (env.MOCK_IMAGES) return new MockImageProvider();
  throw new ConfigError(
    "Production image provider is not implemented yet: where images live and how they are " +
      "authenticated is unknown (IMPLEMENTATION_PLAN U4). Set MOCK_IMAGES=true for development.",
  );
}
