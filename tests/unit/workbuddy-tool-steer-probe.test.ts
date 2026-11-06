import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownSyntheticToolRunning,originalLongToolReady } from '../probes/workbuddy-tool-steer.js';

test('long-tool observation requires exactly one own delay process with the exact directory and duration',()=>{
  const root=mkdtempSync(join(tmpdir(),'courier-tool-proc-')),cwd=join(root,'workspace');mkdirSync(cwd);
  const process=(pid:string,directory:string,args:string[],comm='sleep')=>{
    const p=join(root,pid);mkdirSync(p);writeFileSync(join(p,'comm'),comm);symlinkSync(directory,join(p,'cwd'));
    writeFileSync(join(p,'cmdline'),args.join('\0')+'\0');
  };
  const args=['sleep','12'];
  try {
    process('1',cwd,args);process('2',join(root,'foreign'),args);process('3',cwd,['sleep','13']);
    process('4',cwd,['sleep','12','extra']);process('5',cwd,args,'other');
    assert.equal(ownSyntheticToolRunning(cwd,'12',root),true);
    assert.equal(ownSyntheticToolRunning(cwd,'14',root),false);
    assert.equal(ownSyntheticToolRunning(cwd,'',root),false);
    process('6',cwd,args);assert.equal(ownSyntheticToolRunning(cwd,'12',root),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('long-tool control requires the exact original Bash call and never uses a pending permission or another Run',()=>{
  const event={sessionId:'own',update:{sessionUpdate:'tool_call',toolCallId:'tool',rawInput:{command:'synthetic-command'},
    _meta:{'codebuddy.ai/requestId':'original-run','codebuddy.ai/toolName':'Bash'}}};
  const snapshot={sessionId:'own',isProcessing:true,returned:false,failed:false,pendingPermissions:0,pendingQuestions:0,events:[event]};
  assert.equal(originalLongToolReady(snapshot,'own','original-run','synthetic-command'),true);
  const directory=structuredClone(event);directory.update.rawInput.command="cd '/synthetic/owned' && synthetic-command";
  assert.equal(originalLongToolReady({...snapshot,events:[directory]},'own','original-run','synthetic-command','/synthetic/owned'),true);
  assert.equal(originalLongToolReady({...snapshot,events:[directory]},'own','original-run','synthetic-command','/synthetic/other'),false);
  directory.update.rawInput.command='synthetic-command && unexpected-command';
  assert.equal(originalLongToolReady({...snapshot,events:[directory]},'own','original-run','synthetic-command','/synthetic/owned'),false);
  const partial=structuredClone(event);partial.update.rawInput.command='synthetic-';
  const completed=structuredClone(event);completed.update.sessionUpdate='tool_call_update';
  assert.equal(originalLongToolReady({...snapshot,events:[partial]},'own','original-run','synthetic-command'),false);
  assert.equal(originalLongToolReady({...snapshot,events:[partial,completed]},'own','original-run','synthetic-command'),true);
  for(const change of [{sessionId:'foreign'},{isProcessing:false},{returned:true},{failed:true},{pendingPermissions:1},{pendingQuestions:1},{events:[]}])
    assert.equal(originalLongToolReady({...snapshot,...change},'own','original-run','synthetic-command'),false);
  assert.equal(originalLongToolReady(snapshot,'own','foreign-run','synthetic-command'),false);
  assert.equal(originalLongToolReady(snapshot,'own','original-run','other-command'),false);
  const executable=structuredClone(event);executable.update._meta['codebuddy.ai/toolName']='Read';
  assert.equal(originalLongToolReady({...snapshot,events:[executable]},'own','original-run','synthetic-command'),false);
  const second=structuredClone(event);second.update.toolCallId='another-tool';
  assert.equal(originalLongToolReady({...snapshot,events:[event,second]},'own','original-run','synthetic-command'),false);
  const internal=structuredClone(event);Object.assign(internal.update._meta,{'codebuddy.ai/isSubAgent':true});
  assert.equal(originalLongToolReady({...snapshot,events:[internal]},'own','original-run','synthetic-command'),false);
});
