import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { ServiceDefinition } from "@alvip/shared";
import { ConfigError } from "../../config/env";
import type { Db } from "../../db/client";
import { promptVersions } from "../../db/schema";

/** PRD §58: prompts live in versioned files and are never edited in place. */
export interface PromptTemplate {
  name: string;
  version: string;
  template: string;
  contentHash: string;
}

export const IMAGE_ANALYSIS_PROMPT = { name: "image_analysis", version: "v1" } as const;

export function loadPrompt(promptsDir: string, ref: { name: string; version: string }): PromptTemplate {
  const file = path.join(promptsDir, `${ref.name}_${ref.version}.md`);
  let template: string;
  try {
    template = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  } catch (err) {
    throw new ConfigError(`Prompt ${ref.name}_${ref.version} not found at ${file}: ${(err as Error).message}`);
  }
  return { ...ref, template, contentHash: createHash("sha256").update(template).digest("hex") };
}

/** Prompt version label recorded on runs, e.g. "image_analysis_v1@3f2a9c1b". */
export const promptLabel = (p: PromptTemplate) => `${p.name}_${p.version}@${p.contentHash.slice(0, 8)}`;

/**
 * Register the prompt in prompt_versions. If the same name+version already exists with
 * different content, refuse: the file was edited in place instead of versioned.
 */
export async function registerPrompt(db: Db, p: PromptTemplate): Promise<void> {
  const [existing] = await db
    .select({ contentHash: promptVersions.contentHash })
    .from(promptVersions)
    .where(and(eq(promptVersions.name, p.name), eq(promptVersions.version, p.version)));
  if (existing) {
    if (existing.contentHash !== p.contentHash) {
      throw new ConfigError(
        `Prompt ${p.name}_${p.version} was modified after it was first used. Create ${p.name}_v<next>.md instead.`,
      );
    }
    return;
  }
  await db
    .insert(promptVersions)
    .values({ name: p.name, version: p.version, template: p.template, contentHash: p.contentHash })
    .onConflictDoNothing();
}

const POLARITY_LABEL = {
  positive: "can support the service",
  negative: "counts AGAINST the service (work missing or incomplete)",
  context: "context only — never enough on its own",
} as const;

/** Render the service section from the active rule set (definitions + safety notes). */
export function renderServicesSection(services: readonly ServiceDefinition[]): string {
  return services
    .map((s) => {
      const lines = [`### ${s.code} — ${s.display_name}`, s.description, "", "Evidence types:"];
      for (const e of s.evidence_types) lines.push(`- \`${e.type}\` (${POLARITY_LABEL[e.polarity]}): ${e.description}`);
      if (s.safety_notes.length > 0) {
        lines.push("", "Cautions:");
        for (const n of s.safety_notes) lines.push(`- ${n}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export function renderImageAnalysisPrompt(p: PromptTemplate, services: readonly ServiceDefinition[]): string {
  if (!p.template.includes("{{SERVICES}}")) throw new ConfigError(`Prompt ${p.name}_${p.version} lacks {{SERVICES}}`);
  return p.template.replace("{{SERVICES}}", renderServicesSection(services));
}
