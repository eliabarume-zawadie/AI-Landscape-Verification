/** Thin fetch wrapper: same-origin, session cookie, JSON. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "ERROR", data?.message ?? data?.error ?? res.statusText);
  return data as T;
}

export const imageUrl = (locationId: string, imageId: string, variant: "thumb" | "full" = "thumb") =>
  `/api/locations/${locationId}/images/${imageId}/content?variant=${variant}`;

// ---- response shapes (only the fields the UI uses)

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: "REVIEWER" | "TEAM_LEAD" | "ADMIN";
}

export interface LocationRow {
  id: string;
  externalId: string;
  name: string | null;
  client: string;
  status: string;
  lane: string | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | null;
  aiRecommendation: string | null;
  receivedAt: string;
  services: string[];
  imageCount: number;
}

export interface EvidenceItem {
  imageId: string;
  ref: string;
  role: string;
  evidenceType: string;
  strength: "HIGH" | "MEDIUM" | "LOW";
  observation: string;
}

export interface ServiceView {
  service: string;
  displayName: string;
  status: string;
  confidence: string;
  humanRequired: boolean;
  reasons: string[];
  explanation: string;
  components: Record<string, string> | null;
  supporting: EvidenceItem[];
  contradicting: EvidenceItem[];
  context: EvidenceItem[];
  contradictions: { supportingRef: string | null; contradictingRef: string | null; contradictingImageId: string | null; description: string }[];
  bundle: { imageId: string; ref: string; roles: string[] }[];
}

export interface PairView {
  id: string;
  status: string;
  beforeImageId: string;
  beforeRef: string | null;
  afterImageId: string;
  afterRef: string | null;
  sameAreaConfidence: string | null;
  notes: string | null;
  changes: { service: string; direction: string; strength: string; description: string }[];
}

export interface EvidenceResponse {
  runId: string | null;
  /** Shadow mode: the AI result is withheld from this user while the location is undecided. */
  aiHidden?: boolean;
  requiredServices?: { service: string; displayName: string }[];
  runNumber?: number;
  thresholdsProvisional?: boolean;
  recommendation: { value: string; explanation: string; lane: string } | null;
  risk: { level: string; factors: { factor: string; detail: string }[] } | null;
  bundle?: { totalImages: number; entries: { imageId: string; ref: string; rank: number; reasons: string[]; services: { service: string; role: string }[] }[] };
  pairs?: PairView[];
  services: ServiceView[];
}

export interface ImageItem {
  id: string;
  externalRef: string;
  filename: string | null;
  capturedAt: string | null;
  contentAvailable: boolean;
  inBundle: boolean;
  downloadError: string | null;
  analysis: {
    usable: boolean;
    issues: string[];
    isDuplicateRepresentative: boolean;
    duplicateKind: string | null;
    stage: string | null;
    analysisStatus: string | null;
    evidenceRank: number | null;
  } | null;
}

export interface LocationDetail {
  location: {
    id: string;
    externalId: string;
    name: string | null;
    client: string;
    clientName: string;
    serviceDate: string | null;
    status: string;
    lane: string | null;
    riskLevel: string | null;
    aiRecommendation: string | null;
    receivedAt: string;
    currentRunId: string | null;
  };
  services: { code: string }[];
  runs: { id: string; runNumber: number; status: string; reason: string; startedAt: string; completedAt: string | null; visionModel: string | null; promptVersion: string | null }[];
  audit: { id: number; occurredAt: string; eventType: string; actorType: string; actorName: string | null; data: Record<string, unknown> }[];
  openErrors: { id: string; category: string; message: string; occurredAt: string }[];
  shadow?: boolean;
  aiHidden?: boolean;
}

export interface KnowledgeNote {
  id: string;
  kind: string;
  title: string;
  body: string;
  source: string | null;
  clientId: string | null;
  clientName: string | null;
  serviceCode: string | null;
  serviceName: string | null;
  authorName: string | null;
  supersedesId: string | null;
  createdAt: string;
  archivedAt: string | null;
  archiveReason: string | null;
}

export interface NoteScopes {
  clients: { id: string; code: string; name: string }[];
  services: { code: string; name: string }[];
}

export interface FeedbackRow {
  id: string;
  createdAt: string;
  locationId: string;
  locationExternalId: string;
  locationName: string | null;
  clientName: string;
  reviewerName: string;
  serviceCode: string | null;
  imageId: string | null;
  imageRef: string | null;
  aiRecommendation: string | null;
  aiStatus: string | null;
  aiConfidence: string | null;
  humanDecision: string;
  isOverride: boolean;
  reasonCode: string;
  reasonText: string | null;
}

export interface FeedbackSummary {
  total: number;
  byReason: { key: string; n: number }[];
  byService: { key: string | null; n: number }[];
}

export interface NetSuiteWrite {
  id: string;
  reviewId: string | null;
  operation: "UPDATE_VERIFICATION" | "ADD_NOTE";
  status: "PENDING" | "IN_FLIGHT" | "SUCCEEDED" | "FAILED" | "DEAD";
  attempts: number;
  lastError: string | null;
  lastErrorCategory: string | null;
  createdAt: string;
  lastAttemptAt: string | null;
  syncedAt: string | null;
  remoteRef: string | null;
  alreadyApplied: boolean | null;
}

export interface Proportion {
  value: number | null;
  k: number;
  n: number;
  ci95: { low: number; high: number } | null;
}
export interface EvalMetrics {
  samples: number;
  correct: number;
  incorrect: number;
  falseApprovals: number;
  falseRejections: number;
  deferred: number;
  errors: number;
  falseApprovalRate: Proportion;
  falseRejectionRate: Proportion;
  precision: Proportion;
  recall: Proportion;
  accuracyWhenDecided: Proportion;
  deferralRate: Proportion;
  humanOverride: number;
  smallSample: boolean;
}
export interface EvalSummary {
  overall: EvalMetrics;
  location: EvalMetrics;
  byService: Record<string, EvalMetrics>;
  byClient: Record<string, EvalMetrics>;
  byTag: Record<string, EvalMetrics>;
  byImageQuality: Record<string, EvalMetrics>;
  byConfidence: Record<string, EvalMetrics>;
  coverage: { tag: string; examples: number }[];
  missingCoverage: string[];
  examples: number;
  demoExamples: number;
  durationMs: number;
  minSample: number;
}
export interface EvalRun {
  id: string;
  label: string | null;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  requestedAt: string;
  completedAt: string | null;
  exampleCount: number | null;
  versions: Record<string, string | number | null> | null;
  options: { includeDemo?: boolean; visionModel?: string; clientId?: string; tags?: string[] };
  costUsd: string | null;
  error: string | null;
  summary?: EvalSummary | null;
  overall?: EvalMetrics | null;
  demoExamples?: number | null;
}
export interface GoldenListItem {
  id: string;
  title: string;
  clientName: string;
  source: string;
  services: string[];
  expected: Record<string, string>;
  tags: string[];
  reviewerDecision: string | null;
  status: "DRAFT" | "APPROVED" | "RETIRED";
  createdAt: string;
  createdBy: string | null;
  approvedBy: string | null;
  imageCount: number;
}
