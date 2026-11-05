import type { DisplayPolicy } from '../config/schema.js';
export interface HarnessOperation {
  id: string; bindingId: string; inputId?: string; runId?: string; pendingInputId?: string;
  kind: 'create' | 'load' | 'start' | 'steer' | 'answer'; expectedRunRef?: string;
  status: 'prepared' | 'dispatching' | 'accepted' | 'rejected' | 'unknown'; startedAt?: number; resultCode?: string; evidenceRef?: string;
}
export type RunStatus = 'submitting' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'unknown' | 'not_started';
export interface Run {
  id: string; courierSessionId: string; bindingId: string; initialInputId: string; harnessRunRef?: string;
  status: RunStatus; revision: number; policySnapshot: DisplayPolicy; completionEvidenceRef?: string; startedAt?: number; finishedAt?: number;
}
export const activeStates = ['submitting', 'running', 'waiting_input', 'unknown'] as const;
export function terminal(status: RunStatus): boolean { return status === 'completed' || status === 'failed' || status === 'not_started'; }
