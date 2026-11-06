import test from 'node:test';
import assert from 'node:assert/strict';
import type { HarnessEvent } from '../../src/adapters/harness/events.js';
import { FormatterOutput } from '../../src/adapters/workbuddy-experimental/formatter-output.js';
import { formatterFullToolName } from '../../src/adapters/workbuddy-experimental/formatter.js';

function fixture() {
  const events:{type:HarnessEvent['eventType'];payload:Record<string,unknown>;key?:string}[]=[];let order=0;
  const output=new FormatterOutput((type,payload,key)=>events.push({type,payload:payload as Record<string,unknown>,...(key?{key}:{})}),()=>order++);
  const frame=(id:string,kind:string,text:string,status='in_progress',extra:Record<string,unknown>={})=>({sessionId:'own-session',update:{
    sessionUpdate:'tool_call',toolCallId:id,status,rawInput:{kind,text},_meta:{'codebuddy.ai/toolName':formatterFullToolName},...extra}});
  const done=(id:string,kind:string,text:string)=>({sessionId:'own-session',update:{sessionUpdate:'tool_call_update',toolCallId:id,status:'completed',
    rawOutput:{text:JSON.stringify([{type:'text',text:JSON.stringify({schemaVersion:1,kind,text})}])}}});
  return {output,events,frame,done};
}

test('typed formatter emits completed snapshots once, preserving repeated messages and initial logical order',()=>{
  const f=fixture();
  for(const [id,kind] of [['a','progress'],['b','progress'],['c','final']])f.output.accept(f.frame(id!,kind!,'same same'));
  assert.equal(f.events.filter(e=>e.type==='message.fragment').length,0);
  for(const [id,kind] of [['b','progress'],['a','progress'],['c','final']]) {
    const done=f.done(id!,kind!,'same same');f.output.accept(done);f.output.accept(done);
  }
  const starts=f.events.filter(e=>e.type==='message.started');assert.deepEqual(starts.map(e=>e.payload['logicalOrder']),[0,1,2]);
  assert.deepEqual(starts.map(e=>e.payload['messageId']),['formatter:a','formatter:b','formatter:c']);
  assert.equal(f.events.filter(e=>e.type==='message.fragment').length,3);
  assert.equal(f.events.filter(e=>e.type==='message.completed').length,3);assert.equal(f.output.finish(),true);
  assert.equal(f.events.some(e=>e.type==='run.completed'),false);
});

test('partial arguments are withheld and a mismatched, failed or missing formatter result closes the unfinished output empty',()=>{
  const f=fixture();f.output.accept(f.frame('a','progress','partial'));
  f.output.accept({...f.frame('a','progress','complete'),update:{...f.frame('a','progress','complete').update,sessionUpdate:'tool_call_update'}});
  f.output.accept(f.done('a','progress','complete'));assert.equal(f.events.find(e=>e.type==='message.fragment')!.payload['text'],'complete');
  for(const bad of ['mismatch','cancelled','missing']) {
    const g=fixture();g.output.accept(g.frame('a','final','original'));
    const result=bad==='mismatch'?g.output.accept(g.done('a','final','changed')):bad==='cancelled'?
      g.output.accept({sessionId:'own-session',update:{sessionUpdate:'tool_call_update',toolCallId:'a',status:'cancelled'}}):g.output.finish();
    assert.ok(result==='unsupported'||result===false);assert.equal(g.events.some(e=>e.type==='message.fragment'),false);
    assert.equal(g.events.find(e=>e.type==='message.completed')!.payload['finalFragmentIndex'],-1);assert.equal(g.output.finish(),false);
  }
});

test('unbound completions, ordinary text and member output cannot become typed user messages',()=>{
  const f=fixture();
  assert.equal(f.output.accept({sessionId:'own-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'private ordinary text'}}}),'ignored');
  const member=f.frame('member','final','private');member.update._meta={...member.update._meta,'codebuddy.ai/isTeamMember':true} as typeof member.update._meta;
  assert.equal(f.output.accept(member),'ignored');
  assert.equal(f.output.accept(f.done('orphan','final','private')),'ignored');assert.equal(f.events.length,0);
  assert.equal(f.output.finish(),false);
});

test('a changed completed formatter payload blocks subsequent typed output without rewriting the original',()=>{
  const f=fixture();f.output.accept(f.frame('a','final','original'));f.output.accept(f.done('a','final','original'));
  assert.equal(f.output.accept(f.done('a','final','changed')),'unsupported');
  f.output.accept(f.frame('b','final','later'));f.output.accept(f.done('b','final','later'));
  assert.deepEqual(f.events.filter(e=>e.type==='message.fragment').map(e=>e.payload['text']),['original']);assert.equal(f.output.finish(),false);
});

test('a failure contradicting a completed formatter call remains visible as an unsupported source',()=>{
  const f=fixture();f.output.accept(f.frame('a','final','original'));f.output.accept(f.done('a','final','original'));
  assert.equal(f.output.accept({sessionId:'own-session',update:{sessionUpdate:'tool_call_update',toolCallId:'a',status:'failed'}}),'unsupported');
  assert.equal(f.output.finish(),false);
  assert.deepEqual(f.events.filter(e=>e.type==='message.fragment').map(e=>e.payload['text']),['original']);
});
