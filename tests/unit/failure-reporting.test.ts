import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnostic } from '../../src/application/diagnostics.js';
test('necessary failure descriptions state facts and safe next steps even when output errors are hidden',()=>{
  assert.match(diagnostic('writer_occupied','not_submitted').message,/写入权/);
  assert.match(diagnostic('session_missing').message,/原 Harness 会话/);
  assert.match(diagnostic('text_too_long').message,/未截断/);
  assert.equal(diagnostic('state_unknown').fact,'unknown');
});
