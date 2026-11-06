import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../../src/config/schema.js';
import { openDatabase,transaction } from '../../src/storage/database.js';
import { migrate } from '../../src/storage/migrate.js';
import { platformRecords } from '../../src/storage/platform.js';
import { putContent } from '../../src/storage/content.js';
import { saveEvidence,invalidateEvidence } from '../../src/storage/capabilities.js';
import { decode,insert } from '../../src/storage/records.js';
import { Courier } from '../../src/application/courier.js';
import { composeReal } from '../../src/application/real.js';
import { FakeHarness } from '../../src/adapters/testing/fake-harness.js';
import { FakePlatform } from '../../src/adapters/testing/fake-platform.js';
import { platformTarget } from '../../src/adapters/dingtalk/profile.js';
import { DingTalkClient } from '../../src/adapters/dingtalk/client.js';
import { routeBudget } from '../../src/delivery/limits.js';
import { VirtualClock } from '../fixtures/clock.js';
import type { NormalizedInbound,DeliveryRoute,VerifiedLimits,Recipient } from '../../src/adapters/dingtalk/port.js';
import type { CapabilityEvidence } from '../../src/domain/capabilities.js';
import { loadConfig } from '../../src/config/load.js';
import { credential } from '../../src/config/private.js';

const config=()=>configSchema.parse({schemaVersion:1,storage:{databasePath:'unused'},platform:{kind:'dingtalk-stream',scopeRef:'synthetic-scope',
  robotRef:'synthetic-robot',clientIdRef:'env:COURIER_SYNTHETIC_CLIENT',clientSecretRef:'env:COURIER_SYNTHETIC_SECRET',limitProfileRef:'platform.json'},
  harness:{instanceId:'synthetic-real-instance',adapter:'workbuddy-experimental',connectionProfileRef:'connection.json',capabilityEvidenceRef:'evidence.json'}});
test('unadmitted composition reads no credential and creates no synthetic capability, Harness instance or delivery route',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'courier-real-gate-')),db=openDatabase(':memory:',{allowMemory:true});migrate(db);
  try {
    const cfg=config(),file=join(dir,'config.json');
    for(const [name,value] of Object.entries({'config.json':cfg,'connection.json':{endpoint:'http://127.0.0.1:1/api/v1/acp',cwd:'.',
      cliVersion:'synthetic',authorizationScope:[]},'evidence.json':[],'platform.json':{productVersion:'dingtalk-stream@2.1.5',adapterVersion:'1',
      authorizationScope:[],limits:{maxTextLength:100,lengthUnit:'codepoints',routeTotal:3,rates:[],evidenceRef:'synthetic'},evidence:[]}}))
      writeFileSync(join(dir,name),JSON.stringify(value),{mode:0o600});
    assert.equal(loadConfig(file).platform.clientIdRef,'env:COURIER_SYNTHETIC_CLIENT');
    await assert.rejects(composeReal(cfg,file,db),{message:'capability_unverified'});
    for(const table of ['capability_evidence','harness_instances','delivery_routes'])assert.equal((db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n,0);
  }finally{db.close();rmSync(dir,{recursive:true});}
});
test('private credential references require owner-only files and explicit environment names',()=>{
  const dir=mkdtempSync(join(tmpdir(),'courier-secret-')),file=join(dir,'credential');
  try {
    writeFileSync(file,'synthetic',{mode:0o600});assert.equal(credential(join(dir,'config.json'),'credential'),'synthetic');
    chmodSync(file,0o644);assert.throws(()=>credential(join(dir,'config.json'),'credential'),{message:'auth_required'});
    assert.throws(()=>credential(join(dir,'config.json'),'env:missing-invalid-name'),{message:'auth_required'});
  }finally{rmSync(dir,{recursive:true});}
});
test('real route persistence preserves recipient and original budget across callback retries; revocation prevents the network',async()=>{
  const db=openDatabase(':memory:',{allowMemory:true});migrate(db);const clock=new VirtualClock(),cfg=config();
  const limits:VerifiedLimits={maxTextLength:100,lengthUnit:'codepoints',routeTotal:1,rates:[],evidenceRef:'synthetic-limits'};
  const target=platformTarget(cfg,limits,[]);
  const evidence:CapabilityEvidence={...target,id:'synthetic-platform-proof',checkedAt:clock.now(),outcome:'passed',evidenceRef:'synthetic-only',
    scope:{ingress:{states:[],limitations:[]},delivery:{states:[],limitations:[]}}};saveEvidence(db,evidence);
  const platform=new DingTalkClient({config:cfg,db,target,evidence:[evidence],limits,now:()=>clock.now(),credentials:()=>{assert.fail('credentials must not be loaded');},
    request:(async()=>{assert.fail('network must not be called');}) as typeof fetch});
  const courier=new Courier({config:cfg,db,harness:new FakeHarness(),platform:new FakePlatform(),clock,platformEvidenceTarget:target});
  try {
    assert.equal((db.prepare("SELECT count(*) n FROM capability_evidence WHERE kind='fake'").get() as {n:number}).n,0);
    const event:NormalizedInbound={transportMessageId:'transport',originalMessageId:'original',platformScope:cfg.platform.scopeRef,robotId:cfg.platform.robotRef,
      platformConversationId:'private',conversationType:'private',senderId:'sender',contentType:'text',text:'hello',receivedAt:clock.now(),expiresAt:clock.now()+60000};
    const {conversation,identity}=platformRecords(db,event);
    event.sensitiveCapabilityRef=putContent(db,JSON.stringify({url:'https://oapi.dingtalk.com/robot/sendBySession?session=synthetic',
      recipient:{platformScope:event.platformScope,robotId:event.robotId,platformConversationId:event.platformConversationId}}));
    transaction(db,()=>platform.persistInbound(event,conversation.recipientId));
    const route=decode<DeliveryRoute>(db.prepare('SELECT * FROM delivery_routes').get())!;
    const recipient=decode<Recipient>(db.prepare('SELECT * FROM recipients').get())!;
    insert(db,'inputs',{id:'input',dedupNamespace:'synthetic',originalMessageId:'original',platformConversationId:conversation.id,identityId:identity.id,
      receivedSequence:0,textRef:putContent(db,'hello'),mode:'invalid',status:'rejected'});
    const delivery='delivery';insert(db,'outbound_deliveries',{id:delivery,recipientId:recipient.id,inputId:'input',logicalMessageIds:[],
      deliverySequence:0,payloadRef:putContent(db,'hello'),status:'pending',attemptCount:0});
    insert(db,'delivery_attempts',{id:'attempt',deliveryId:delivery,attemptNo:1,routeId:route.id,startedAt:clock.now(),outcome:'confirmed'});
    platform.persistInbound({...event,transportMessageId:'redelivery'},conversation.recipientId);
    assert.equal((db.prepare('SELECT count(*) n FROM delivery_routes').get() as {n:number}).n,1);
    assert.deepEqual(routeBudget(courier.runtime,recipient,route),{available:false});
    assert.deepEqual(await platform.send('delivery',recipient,'hello',{...route,verifiedLimits:{...limits,routeTotal:100}}),{status:'route_unavailable',code:'limit'});
    invalidateEvidence(db,evidence.id,clock.now());assert.throws(()=>platform.admission(),{message:'capability_unverified'});
    assert.deepEqual(await platform.send('delivery',recipient,'hello',route),{status:'route_unavailable',code:'auth'});
  }finally{await courier.close();db.close();}
});
