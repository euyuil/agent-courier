import { evidenceValid, requiredCapabilities, type CapabilityName } from '../../domain/capabilities.js';
import { CourierError } from '../../domain/errors.js';
import type { ProbeReport } from './port.js';

export function assertAdmission(report: ProbeReport, now: number,
  capabilities: readonly CapabilityName[] = requiredCapabilities): void {
  if (report.authenticationStatus !== 'authenticated') throw new CourierError('auth_required');
  for (const capability of capabilities) {
    const states = capability === 'timelySteer' ? ['running', 'waiting_input'] : [];
    if (report.capabilities[capability] !== 'supported' || !report.evidenceRefs.some(evidence => evidenceValid(evidence, report, now, capability, states))) {
      throw new CourierError(capability === 'timelySteer' ? 'steer_unsupported' : 'capability_unverified');
    }
  }
}
