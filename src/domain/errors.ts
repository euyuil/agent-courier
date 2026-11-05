export const errorCodes = [
  'unconfigured', 'auth_required', 'resume_unsupported', 'session_missing', 'writer_occupied',
  'capability_unverified', 'steer_unsupported', 'steer_rejected', 'stale_run', 'request_invalid',
  'interaction_blocked', 'output_unsupported', 'state_unknown', 'configuration_invalid',
  'storage_unavailable', 'instance_locked', 'recovery_interrupted', 'protocol_conflict',
  'input_unsupported', 'route_unavailable', 'text_too_long', 'delivery_failed', 'content_missing', 'run_failed',
] as const;
export type ErrorCode = typeof errorCodes[number];
export class CourierError extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}
export function safeCode(error: unknown): ErrorCode {
  return error instanceof CourierError ? error.code : 'state_unknown';
}
