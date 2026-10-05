import type { ErrorCategory, LocationStatus } from "@alvip/shared";
import { recordAudit, type Actor } from "../audit/audit";
import { ConfigError } from "../config/env";
import type { Db } from "../db/client";
import { systemErrors } from "../db/schema";
import { ImageFetchError } from "../integrations/images/ImageProvider";
import { IntegrationError } from "../integrations/netsuite/NetSuiteAdapter";
import { VisionProviderError } from "../integrations/vision/VisionProvider";

/** A permanent data problem with a work item (e.g. no images) — goes to the Exception Lane. */
export class WorkItemError extends Error {
  override name = "WorkItemError";
  constructor(
    message: string,
    readonly category: ErrorCategory,
    readonly errorStatus: LocationStatus,
  ) {
    super(message);
  }
}

export interface ClassifiedError {
  category: ErrorCategory;
  /** Location status to use if the failure is final. */
  errorStatus: LocationStatus;
  message: string;
}

/** Map any thrown value to a PRD §78 category and an Exception Lane status. */
export function classifyError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof WorkItemError) return { category: err.category, errorStatus: err.errorStatus, message };
  if (err instanceof IntegrationError) return { category: err.category, errorStatus: "INTEGRATION_ERROR", message };
  if (err instanceof ImageFetchError) {
    const category: ErrorCategory =
      err.kind === "TRANSIENT" ? "TRANSIENT" : err.kind === "FORBIDDEN" ? "AUTHENTICATION" : "INVALID_IMAGE";
    return { category, errorStatus: "IMAGE_ERROR", message };
  }
  if (err instanceof VisionProviderError) {
    const category: ErrorCategory =
      err.kind === "AUTHENTICATION" ? "AUTHENTICATION" : err.kind === "INVALID_REQUEST" ? "INTERNAL" : "MODEL_ERROR";
    return { category, errorStatus: "AI_ERROR", message };
  }
  if (err instanceof ConfigError) return { category: "CONFIGURATION", errorStatus: "INTEGRATION_ERROR", message };
  return { category: "INTERNAL", errorStatus: "INTEGRATION_ERROR", message };
}

export interface SystemErrorInput {
  category: ErrorCategory;
  source: string;
  message: string;
  details?: Record<string, unknown>;
  locationId?: string | null;
  runId?: string | null;
  jobId?: string | null;
  actor: Actor;
}

/** Record an error for the Exception Lane / ops views, with a matching audit event. */
export async function recordSystemError(db: Db, input: SystemErrorInput): Promise<void> {
  await db.insert(systemErrors).values({
    category: input.category,
    source: input.source,
    message: input.message.slice(0, 4000),
    details: input.details ?? null,
    locationId: input.locationId ?? null,
    runId: input.runId ?? null,
    jobId: input.jobId ?? null,
  });
  await recordAudit(db, {
    eventType: "ERROR",
    actor: input.actor,
    ...(input.locationId ? { locationId: input.locationId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    data: { category: input.category, source: input.source, message: input.message.slice(0, 500) },
  });
}
