import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReceipt } from '../../src/adapters/harness/receipt.js';
import type { Receipt } from '../../src/adapters/harness/port.js';
test('rejection requires definite nonacceptance and accepted receipts must retain original correlation',()=>{
  const invalid=[{status:'rejected',errorCode:'stale_run'}, {status:'rejected',errorCode:'SYNTHETIC_SECRET',definitelyNotAccepted:true},
    {status:'accepted',sessionRef:'other',runRef:'run',receiptEvidence:'synthetic'}, {status:'accepted',sessionRef:'original',receiptEvidence:'synthetic'},
    {status:'accepted',sessionRef:'original',runRef:42,receiptEvidence:'synthetic'},
    {status:'accepted',sessionRef:'original',runRef:'run',receiptEvidence:42}];
  for(const item of invalid)assert.equal(normalizeReceipt(item as Receipt,{sessionRef:'original',requiresRun:true}).status,'unknown');
  assert.deepEqual(normalizeReceipt({status:'rejected',errorCode:'stale_run',definitelyNotAccepted:true}),{status:'rejected',errorCode:'stale_run',definitelyNotAccepted:true});
});
