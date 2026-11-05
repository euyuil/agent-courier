import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply } from '../../src/adapters/dingtalk/reply-parser.js';
test('explicit numbered commands distinguish answers, permissions, supplements and ambiguous words',()=>{
  assert.deepEqual(parseReply('/答复 Q123 full text answer',true),{kind:'reply',code:'Q123',text:'full text answer'});
  assert.deepEqual(parseReply('/批准 P123 O1',true),{kind:'permission',code:'P123',decision:'approve',optionCode:'O1'});
  assert.deepEqual(parseReply('/批准 P123 allow-once',true),{kind:'permission',code:'P123',decision:'approve',optionCode:'allow-once'});
  assert.deepEqual(parseReply('/拒绝 P123',true),{kind:'permission',code:'P123',decision:'deny'});
  assert.deepEqual(parseReply('/补充 同意',true),{kind:'ordinary',text:'同意'});
  for(const word of ['同意','好','是','否','不同意','yes','no'])assert.equal(parseReply(word,true).kind,'ambiguous');
  assert.equal(parseReply('同意',false).kind,'ordinary');assert.equal(parseReply('/批准',true).kind,'invalid');
});
