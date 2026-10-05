export const JOB_TYPES = {
  PROCESS_LOCATION: "PROCESS_LOCATION",
} as const;

export interface ProcessLocationPayload {
  locationId: string;
  reason: string;
  note?: string;
  requestedBy?: string;
}
