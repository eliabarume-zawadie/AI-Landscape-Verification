export const JOB_TYPES = {
  PROCESS_LOCATION: "PROCESS_LOCATION",
  NETSUITE_SYNC: "NETSUITE_SYNC",
} as const;

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
