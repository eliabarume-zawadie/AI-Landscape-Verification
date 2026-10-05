import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MAX_ENABLED_AUTOMATION_LEVEL } from "@alvip/shared";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export const VISION_PROVIDERS = ["anthropic", "openai"] as const;
export type VisionProviderName = (typeof VISION_PROVIDERS)[number];
/** Default model per provider; undefined = must be configured explicitly. */
export const DEFAULT_VISION_MODEL: Record<VisionProviderName, string | undefined> = {
  anthropic: "claude-opus-5-5",
  openai: undefined,
};

const bool = (defaultValue: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === "true" || v === "1"));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** Postgres connection string. If unset (dev/test only), embedded PGlite is used. */
  DATABASE_URL: z.string().url().optional(),
  PGLITE_DATA_DIR: z.string().default(path.join(repoRoot, ".data", "pglite")),

  CONFIG_DIR: z.string().default(path.join(repoRoot, "config")),
  PROMPTS_DIR: z.string().default(path.join(repoRoot, "prompts")),

  SESSION_TTL_HOURS: z.coerce.number().positive().default(12),
  COOKIE_SECURE: bool(true),

  MOCK_NETSUITE: bool(true),
  MOCK_AI: bool(true),
  MOCK_IMAGES: bool(true),

  /** PRD §53. Values above MAX_ENABLED_AUTOMATION_LEVEL are refused at startup. */
  AUTOMATION_LEVEL: z.coerce.number().int().min(0).max(5).default(1),
  /** PRD §89: AI runs but its output is hidden from reviewers and recorded separately. */
  SHADOW_MODE: bool(false),

  /**
   * "embedded" runs the worker inside the API process (required with PGlite, which is
   * single-process). "off" for API-only instances when standalone workers run against Postgres.
   */
  WORKER_MODE: z.enum(["embedded", "off"]).default("embedded"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  JOB_LEASE_SEC: z.coerce.number().int().min(10).default(300),
  /** How often to pull the NetSuite queue. 0 disables automatic polling. */
  NETSUITE_POLL_INTERVAL_SEC: z.coerce.number().int().min(0).default(60),

  /** Private image storage root (local filesystem driver). */
  STORAGE_DIR: z.string().default(path.join(repoRoot, ".data", "images")),
  IMAGE_FETCH_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),

  /** Vision provider used when MOCK_AI=false. */
  VISION_PROVIDER: z.enum(VISION_PROVIDERS).default("anthropic"),
  /**
   * Model ID for the selected provider. Anthropic defaults to claude-opus-5-5; other
   * providers have no assumed default and must be set explicitly.
   */
  VISION_MODEL: z.string().min(1).optional(),
  /** Anthropic only: effort level. */
  VISION_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  /** Anthropic only: server-side refusal fallback. The served model is always recorded. */
  VISION_FALLBACKS: bool(true),
  VISION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  /** Long side of the copy sent to the vision model. */
  VISION_MAX_IMAGE_SIDE: z.coerce.number().int().min(256).max(4096).default(1568),
  /**
   * Explicit acknowledgement that client images may be sent to a third-party AI API.
   * Must stay false until the data-processing approval (plan unknown U9) exists.
   */
  ALLOW_EXTERNAL_AI_IMAGE_PROCESSING: bool(false),

  IMAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  /** How often the worker purges image bytes past retention. 0 disables. */
  RETENTION_SWEEP_INTERVAL_SEC: z.coerce.number().int().min(0).default(3600),
  METRICS_TIMEZONE: z.string().default("America/New_York"),

  // NetSuite (PRD §37). Never commit real values.
  NETSUITE_ACCOUNT_ID: z.string().optional(),
  NETSUITE_CONSUMER_KEY: z.string().optional(),
  NETSUITE_CONSUMER_SECRET: z.string().optional(),
  NETSUITE_TOKEN_ID: z.string().optional(),
  NETSUITE_TOKEN_SECRET: z.string().optional(),
  NETSUITE_API_BASE_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema> & { APP_VERSION: string; REPO_ROOT: string };

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Load the repo-root .env into process.env if present (real env vars take precedence). */
export function loadDotEnvFile(): void {
  const file = path.join(repoRoot, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Parse and validate the environment. Throws ConfigError on unsafe or invalid config. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Treat empty strings (common in .env files) as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid environment: ${issues}`);
  }
  const env = parsed.data;

  if (env.AUTOMATION_LEVEL > MAX_ENABLED_AUTOMATION_LEVEL) {
    throw new ConfigError(
      `AUTOMATION_LEVEL=${env.AUTOMATION_LEVEL} is not permitted. Levels above ` +
        `${MAX_ENABLED_AUTOMATION_LEVEL} require validated performance and explicit business approval (PRD §53–54).`,
    );
  }

  if (env.NODE_ENV === "production") {
    const mocks = (["MOCK_NETSUITE", "MOCK_AI", "MOCK_IMAGES"] as const).filter((k) => env[k]);
    if (mocks.length > 0) {
      throw new ConfigError(`Mock providers are not allowed in production: ${mocks.join(", ")}`);
    }
    if (!env.DATABASE_URL) {
      throw new ConfigError("DATABASE_URL is required in production (PGlite is dev/test only).");
    }
    if (!env.COOKIE_SECURE) {
      throw new ConfigError("COOKIE_SECURE must be true in production.");
    }
  }

  return { ...env, APP_VERSION: readAppVersion(), REPO_ROOT: repoRoot };
}

function readAppVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}
