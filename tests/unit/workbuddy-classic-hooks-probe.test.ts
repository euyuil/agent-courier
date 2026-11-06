import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureClassicHookObservation,hookRecordsName,summarizeClassicHooks } from '../probes/workbuddy-classic-hooks.js';

function fixture() {
  const cwd=mkdtempSync(join(tmpdir(),"courier-hook unit-'")),session='synthetic-session',run='synthetic-run',body='CourierOwnedContext-abcd';
  configureClassicHookObservation(cwd);
  const settings=JSON.parse(readFileSync(join(cwd,'.codebuddy','settings.local.json'),'utf8')) as {hooks:Record<string,{hooks:{command:string;allowedEnvVars:string[]}[]}[]>};
  const call=(event:string,extra:Record<string,unknown>={})=>{
    const config=settings.hooks[event]![0]!.hooks[0]!;
    assert.deepEqual(config.allowedEnvVars,['PATH']);
    const stdout=execFileSync('/bin/sh',['-c','exec '+config.command],{cwd,input:JSON.stringify({cwd,hook_event_name:event,session_id:session,generation_id:run,...extra}),
      env:{PATH:process.env['PATH']??''},encoding:'utf8',timeout:5000,killSignal:'SIGKILL'});
    assert.equal(stdout,'');
  };
  const complete=()=>{call('UserPromptSubmit');call('Stop',{last_assistant_message:body});call('FinalStop',{final_stop_reason:'completed'});};
  return {cwd,session,run,body,call,complete,close:()=>rmSync(cwd,{recursive:true,force:true})};
}

test('classic Hook observer preserves native identity relationships without retaining text, paths or session details',()=>{
  const f=fixture();
  try {
    f.call('UserPromptSubmit',{prompt:'fixture-private-prompt',session:{secret:'fixture-private-session'},transcript_path:'fixture-private-transcript'});
    f.call('Stop',{last_assistant_message:f.body});f.call('FinalStop',{final_stop_reason:'completed'});
    const text=readFileSync(join(f.cwd,hookRecordsName),'utf8'),rows=text.trimEnd().split('\n');assert.equal(rows.length,3);
    for(const value of [f.cwd,f.session,f.run,f.body,'fixture-private'])assert.equal(text.includes(value),false);
    assert.equal(statSync(join(f.cwd,hookRecordsName)).mode&0o077,0);
    const report=summarizeClassicHooks(f.cwd,f.session,f.run,f.body);
    assert.equal(report['status'],'observed');assert.equal(report['stopBodyMatched'],true);assert.equal(report['sessionObjectProvided'],true);
    assert.equal(report['perMessageIdentityObserved'],false);assert.equal(report['fragmentIdentityObserved'],false);
    assert.equal(summarizeClassicHooks(f.cwd,'foreign-session',f.run,f.body)['status'],'unverified');
  }finally{f.close();}
});

test('classic Hook observer ignores foreign directories and malformed input and never overwrites configured files',()=>{
  const f=fixture();
  try {
    f.call('Stop',{cwd:'foreign-directory',last_assistant_message:'fixture-private-body'});
    assert.equal(existsSync(join(f.cwd,hookRecordsName)),false);
    assert.equal(summarizeClassicHooks(f.cwd,f.session,f.run,f.body)['status'],'unverified');
    assert.throws(()=>configureClassicHookObservation(f.cwd),{message:'private_configuration_required'});
    f.complete();assert.equal(summarizeClassicHooks(f.cwd,f.session,f.run,f.body)['status'],'observed');
  }finally{f.close();}
});

test('ambiguous Stop events, incomplete records and unknown fields cannot certify a native completion snapshot',()=>{
  const f=fixture();
  try {
    f.complete();const path=join(f.cwd,hookRecordsName),original=readFileSync(path,'utf8');
    const rows=original.trimEnd().split('\n'),stop=rows.find(line=>JSON.parse(line).event==='Stop')!;
    writeFileSync(path,original+stop+'\n');assert.equal(summarizeClassicHooks(f.cwd,f.session,f.run,f.body)['status'],'unverified');
    writeFileSync(path,original.trimEnd());assert.equal(summarizeClassicHooks(f.cwd,f.session,f.run,f.body)['reason'],'hook_records_incomplete');
    const changed=JSON.parse(rows[0]!);changed.privateState='fixture-private-state';rows[0]=JSON.stringify(changed);
    writeFileSync(path,rows.join('\n')+'\n');assert.equal(summarizeClassicHooks(f.cwd,f.session,f.run,f.body)['status'],'unverified');
  }finally{f.close();}
});
