import type { ReviewDecision } from "@alvip/shared";

/**
 * Business-level view of NetSuite (PRD §38). Implementations map these to real
 * record types/field IDs via configuration — none are assumed here (unknowns U1–U6).
 */
export interface NetSuiteAdapter {
  readonly name: string;
  /** Work items currently awaiting verification. */
  getQueue(): Promise<NetSuiteQueueItem[]>;
  getLocation(externalId: string): Promise<NetSuiteLocation>;
  /** Service codes as known to ALVIP (mapping from NetSuite values is the adapter's job). */
  getRequiredServices(externalId: string): Promise<string[]>;
  getImages(externalId: string): Promise<NetSuiteImageRef[]>;
  /** Must be idempotent for the same idempotencyKey. */
  updateVerification(externalId: string, result: VerificationWrite): Promise<WriteAck>;
  addVerificationNote(externalId: string, note: VerificationNote): Promise<WriteAck>;
}

export interface NetSuiteQueueItem {
  externalId: string;
  clientCode: string;
  receivedAt: Date;
}

export interface NetSuiteLocation {
  externalId: string;
  externalLocationRef?: string;
  clientCode: string;
  name?: string;
  serviceDate?: Date;
  /**
   * Verification decision currently recorded in NetSuite, mapped by the adapter to ALVIP
   * terms ("APPROVE" | "REJECT"), or null when none. Read before every write so a decision
   * made in NetSuite directly is never overwritten (PRD §39).
   */
  existingVerificationStatus?: string | null;
  raw?: unknown;
}

export interface NetSuiteImageRef {
  externalRef: string;
  filename?: string;
  ordinal?: number;
  capturedAt?: Date;
  /** Opaque locator understood by the matching ImageProvider. */
  locator: string;
}

export interface VerificationWrite {
  idempotencyKey: string;
  decision: ReviewDecision;
  reviewerName: string;
  decidedAt: Date;
  processingRunId: string | null;
  serviceDecisions: Record<string, ReviewDecision>;
}

export interface VerificationNote {
  idempotencyKey: string;
  body: string;
}

export interface WriteAck {
  /** True when NetSuite already had this write (idempotent replay). */
  alreadyApplied: boolean;
  remoteRef?: string;
}

/** Thrown by adapters so callers can apply the PRD §78 retry policy. */
export class IntegrationError extends Error {
  override name = "IntegrationError";
  constructor(
    message: string,
    readonly category: "TRANSIENT" | "AUTHENTICATION" | "NETSUITE_VALIDATION" | "CONFIGURATION",
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
