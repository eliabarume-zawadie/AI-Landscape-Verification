export const JOB_TYPES = {
  PROCESS_LOCATION: "PROCESS_LOCATION",
  NETSUITE_SYNC: "NETSUITE_SYNC",
  EVALUATION_RUN: "EVALUATION_RUN",
} as const;

export interface EvaluationRunPayload {
  evaluationRunId: string;
}

export interface NetSuiteSyncPayload {
  locationId: string;
  reviewId: string;
}

export interface ProcessLocationPayload {
  locationId: string;
  reason: string;
  note?: string;
  requestedBy?: string;
}
