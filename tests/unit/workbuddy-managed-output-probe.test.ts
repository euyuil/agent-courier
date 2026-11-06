import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedOutputExperiment } from '../probes/workbuddy-managed-output.js';

test('managed output observations reject remote or decorated diagnostic targets before creating state or a Harness',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'courier-managed-output-')),workspace=join(directory,'uncreated');
  try{
    for(const target of ['https://127.0.0.1','http://example.invalid','http://127.0.0.1?token=synthetic','http://synthetic@127.0.0.1']){
      const report=await managedOutputExperiment(target,workspace,'question-steer');assert.equal(report['status'],'unverified');
      assert.equal(report['contextPrepared'],undefined);assert.equal(existsSync(workspace),false);
      assert.doesNotMatch(JSON.stringify(report),/example\.invalid|token|127\.0\.0\.1|uncreated/);
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});
