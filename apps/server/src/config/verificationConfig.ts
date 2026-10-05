import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";
import {
  clientProfileSchema,
  serviceRuleSetSchema,
  thresholdsSchema,
  type ClientProfile,
  type Thresholds,
} from "@alvip/shared";
import {
  ServiceRegistry,
  validateClientProfileAgainstRegistry,
} from "../domain/serviceRegistry";
import { ConfigError } from "./env";

export interface VerificationConfig {
  registry: ServiceRegistry;
  thresholds: Thresholds;
  clientProfiles: Map<string, ClientProfile>;
  /** Content hashes so every processing run can record exactly which config it used. */
  hashes: { services: string; thresholds: string; clientProfiles: Map<string, string> };
}

export const SERVICES_FILE = "services.json";
export const THRESHOLDS_FILE = "thresholds.json";
export const CLIENT_PROFILES_DIR = "client-profiles";

/**
 * Load and cross-validate the file-based configuration that seeds the database.
 * At runtime the database holds the active versions; these files are the
 * reviewable source for initial versions.
 */
export function loadVerificationConfigFromDir(configDir: string): VerificationConfig {
  const servicesRaw = readJson(path.join(configDir, SERVICES_FILE));
  const ruleSet = parseOrThrow(serviceRuleSetSchema, servicesRaw, SERVICES_FILE);
  const registry = new ServiceRegistry(ruleSet);

  const thresholdsRaw = readJson(path.join(configDir, THRESHOLDS_FILE));
  const thresholds = parseOrThrow(thresholdsSchema, thresholdsRaw, THRESHOLDS_FILE);

  const clientProfiles = new Map<string, ClientProfile>();
  const profileHashes = new Map<string, string>();
  const profilesDir = path.join(configDir, CLIENT_PROFILES_DIR);
  for (const file of readdirSync(profilesDir).filter((f) => f.endsWith(".json")).sort()) {
    const raw = readJson(path.join(profilesDir, file));
    const profile = parseOrThrow(clientProfileSchema, raw, `${CLIENT_PROFILES_DIR}/${file}`);
    const problems = validateClientProfileAgainstRegistry(profile, registry);
    if (problems.length > 0) throw new ConfigError(problems.join("; "));
    if (clientProfiles.has(profile.client)) {
      throw new ConfigError(`Duplicate client profile for ${profile.client}`);
    }
    clientProfiles.set(profile.client, profile);
    profileHashes.set(profile.client, contentHash(profile));
  }

  return {
    registry,
    thresholds,
    clientProfiles,
    hashes: {
      services: contentHash(ruleSet),
      thresholds: contentHash(thresholds),
      clientProfiles: profileHashes,
    },
  };
}

/** Stable SHA-256 of a JSON value (keys sorted) — used to version config content. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`Cannot read ${file}: ${(err as Error).message}`);
  }
}

function parseOrThrow<T>(schema: ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`${label} is invalid: ${issues}`);
  }
  return result.data;
}
