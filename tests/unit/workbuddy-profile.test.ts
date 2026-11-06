import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionProfileSchema } from '../../src/config/real-profiles.js';
import { outputArtifactDigest,workbuddyConfiguration } from '../../src/adapters/workbuddy-experimental/profile.js';
import { contextFingerprint,evidenceValid,type CapabilityEvidence } from '../../src/domain/capabilities.js';

test('output implementation digest covers artifact names, rule bytes and producer bytes independently of enumeration order',()=>{
  const initial={producer:'pure formatter v1',rules:'output rules v1'},hash=outputArtifactDigest(initial);
  assert.equal(outputArtifactDigest({rules:initial.rules,producer:initial.producer}),hash);
  assert.notEqual(outputArtifactDigest({...initial,producer:'pure formatter v2'}),hash);
  assert.notEqual(outputArtifactDigest({...initial,rules:'output rules v2'}),hash);
  assert.notEqual(outputArtifactDigest({renamed:initial.producer,rules:initial.rules}),hash);
});

test('normal output configuration binds evidence to mode and packaged implementation and detects later source changes',()=>{
  const raw={endpoint:'http://127.0.0.1:1/api/v1/acp',cwd:'.',cliVersion:'synthetic',authorizationScope:[]};
  const plain=connectionProfileSchema.parse(raw),typed=connectionProfileSchema.parse({...raw,output:{mode:'courier-formatter'}});
  let artifacts={producer:'synthetic-code',rules:'synthetic-rules'};
  const text=workbuddyConfiguration('instance',plain,()=>artifacts),formatter=workbuddyConfiguration('instance',typed,()=>artifacts);
  assert.equal(text.typedFormatterOutput,undefined);assert.equal(text.formatterLaunch,undefined);
  assert.equal(formatter.typedFormatterOutput,true);assert.equal(formatter.formatterLaunch!.executable,process.execPath);
  assert.ok(formatter.formatterLaunch!.entrypoint.endsWith('/formatter-server.js'));
  assert.notEqual(text.contextFingerprint,formatter.contextFingerprint);
  const exclusive=connectionProfileSchema.parse({...raw,desktopDebugUrl:'http://127.0.0.1:2',ownership:{mode:'courier-exclusive',bootstrapSessionRef:'own-bootstrap'}});
  assert.notEqual(workbuddyConfiguration('instance',exclusive,()=>artifacts).contextFingerprint,text.contextFingerprint);
  assert.notEqual(workbuddyConfiguration('instance',{...exclusive,connectionRole:'context'},()=>artifacts).contextFingerprint,
    workbuddyConfiguration('instance',exclusive,()=>artifacts).contextFingerprint);
  const managed=workbuddyConfiguration('instance',{...exclusive,connectionRole:'managed'},()=>artifacts);
  assert.notEqual(managed.contextFingerprint,workbuddyConfiguration('instance',exclusive,()=>artifacts).contextFingerprint);
  assert.notEqual(managed.contextFingerprint,workbuddyConfiguration('instance',{...exclusive,connectionRole:'context'},()=>artifacts).contextFingerprint);
  const automatic={...typed,ownership:{mode:'courier-exclusive' as const},desktopDebugUrl:'http://127.0.0.1:2'};
  assert.notEqual(workbuddyConfiguration('instance',{...automatic,connectionRole:'managed'},()=>artifacts).contextFingerprint,
    workbuddyConfiguration('instance',{...exclusive,output:automatic.output,connectionRole:'managed'},()=>artifacts).contextFingerprint);
  assert.notEqual(workbuddyConfiguration('instance',{...automatic,bootstrapPermissionMode:'default'},()=>artifacts).contextFingerprint,
    workbuddyConfiguration('instance',automatic,()=>artifacts).contextFingerprint);
  assert.notEqual(workbuddyConfiguration('instance',{...typed,cliVersion:null},()=>artifacts).contextFingerprint,formatter.contextFingerprint);
  const legacy=contextFingerprint({targetRef:JSON.stringify(['instance',raw.endpoint,raw.cwd]),cliVersion:raw.cliVersion,
    transportKind:'workbuddy-acp',authorizationScope:[],limitProfile:null});
  assert.notEqual(text.contextFingerprint,legacy);
  const evidence:CapabilityEvidence={id:'proof',kind:'harness',adapterVersion:'1',productVersion:'synthetic',contextFingerprint:text.contextFingerprint,
    checkedAt:1,outcome:'passed',evidenceRef:'synthetic-only',scope:{typedVisibleOutput:{states:[],limitations:[]}}};
  assert.equal(evidenceValid(evidence,{...evidence,contextFingerprint:formatter.contextFingerprint},2,'typedVisibleOutput'),false);
  assert.equal(formatter.verifyOutputProfile(),true);
  artifacts={...artifacts,rules:'changed-rules'};
  assert.equal(formatter.verifyOutputProfile(),false);
  assert.notEqual(workbuddyConfiguration('instance',typed,()=>artifacts).contextFingerprint,formatter.contextFingerprint);
  const unreadable=workbuddyConfiguration('instance',typed,()=>{if(artifacts.rules==='unavailable')throw new Error('private-path');return artifacts;});
  artifacts={...artifacts,rules:'unavailable'};assert.equal(unreadable.verifyOutputProfile(),false);
});

test('automatic managed evidence identifies the configured desktop target across owned backends while fixed endpoints and changed targets remain distinct',()=>{
  const profile=connectionProfileSchema.parse({cwd:'/synthetic/project',cliVersion:'synthetic',authorizationScope:[],
    ownership:{mode:'courier-exclusive'},desktopDebugUrl:'http://127.0.0.1:2'});
  const artifacts=()=>({producer:'synthetic-producer'}),configured=(endpoint:string)=>({...profile,endpoint,connectionRole:'managed' as const});
  const initial=workbuddyConfiguration('instance',configured('http://127.0.0.1:3/api/v1/acp'),artifacts);
  const peer=workbuddyConfiguration('instance',configured('http://127.0.0.1:4/api/v1/acp'),artifacts);
  assert.equal(initial.contextFingerprint,peer.contextFingerprint);
  for(const changed of [{desktopDebugUrl:'http://127.0.0.1:5'},{cwd:'/synthetic/other'},{authorizationScope:['changed']},
    {cliVersion:'other'},{bootstrapPermissionMode:'default' as const}]){
    assert.notEqual(initial.contextFingerprint,workbuddyConfiguration('instance',{...configured('http://127.0.0.1:3/api/v1/acp'),...changed},artifacts).contextFingerprint);
  }
  const fixed={...configured('http://127.0.0.1:3/api/v1/acp'),ownership:{mode:'courier-exclusive' as const,bootstrapSessionRef:'private-fixed-host'}};
  assert.notEqual(workbuddyConfiguration('instance',fixed,artifacts).contextFingerprint,
    workbuddyConfiguration('instance',{...fixed,endpoint:'http://127.0.0.1:4/api/v1/acp'},artifacts).contextFingerprint);
  assert.notEqual(initial.contextFingerprint,workbuddyConfiguration('instance',fixed,artifacts).contextFingerprint);
  const {desktopDebugUrl:_,...missing}=configured('http://127.0.0.1:3/api/v1/acp');void _;
  assert.throws(()=>workbuddyConfiguration('instance',missing,artifacts),{message:'configuration_invalid'});
});
