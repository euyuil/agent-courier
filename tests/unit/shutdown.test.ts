import test from 'node:test';
import assert from 'node:assert/strict';
import { closeInOrder } from '../../src/application/shutdown.js';

test('shutdown completes every remaining cleanup step and exposes only a safe error',async()=>{
  const calls:string[]=[];
  await assert.rejects(closeInOrder([
    async()=>{calls.push('ingress');throw new Error('SYNTHETIC_PRIVATE_CLOSE_DETAIL');},
    ()=>{calls.push('courier');},()=>{calls.push('database');throw new Error('other private detail');},()=>{calls.push('lock');},
  ]),error=>{
    assert.ok(error instanceof Error);assert.equal(error.message,'state_unknown');
    assert.equal(JSON.stringify(error).includes('SYNTHETIC_PRIVATE_CLOSE_DETAIL'),false);return true;
  });
  assert.deepEqual(calls,['ingress','courier','database','lock']);
});
