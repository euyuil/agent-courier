import type { FakeOptions } from './fake-harness.js';
export const scenarios: Record<string, FakeOptions> = {
  timely: { steerMode: 'timely' }, queued: { steerMode: 'queued' }, late: { steerMode: 'late' },
  unsupported: { steerMode: 'unsupported' }, writerOccupied: { writerOccupied: true },
  eventBeforeReceipt: { deferReceipts: true }, unknown: { receiptStatus: 'unknown' },
};
