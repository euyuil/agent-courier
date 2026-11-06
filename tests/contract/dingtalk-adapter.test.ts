import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCallback } from '../../src/adapters/dingtalk/normalize.js';
import { sendWebhook } from '../../src/adapters/dingtalk/webhook.js';
import { inspectDelivery } from '../../src/adapters/dingtalk/inspect.js';
import { sendOto } from '../../src/adapters/dingtalk/oto.js';
import type { DeliveryRoute,Recipient } from '../../src/adapters/dingtalk/port.js';

const context={scope:'synthetic-scope',robotCode:'synthetic-robot',evidenceRef:'synthetic-ingress'};
const body={msgId:'original',chatbotCorpId:context.scope,robotCode:context.robotCode,chatbotUserId:'bot-user',
  conversationId:'private-conversation',conversationType:'1',senderId:'sender',senderStaffId:'enterprise-user',
  msgtype:'text',text:{content:'hello'},sessionWebhook:'https://oapi.dingtalk.com/robot/sendBySession?session=synthetic',sessionWebhookExpiredTime:2000};
const recipient:Recipient={id:'recipient',platformScope:context.scope,robotId:context.robotCode,platformConversationId:body.conversationId};
const route:DeliveryRoute={id:'route',recipientId:recipient.id,kind:'sessionWebhook',expiresAt:2000,status:'ready',
  capabilityEvidenceId:'synthetic',verifiedLimits:{maxTextLength:10,lengthUnit:'codepoints',routeTotal:3,rates:[],evidenceRef:'synthetic'}};
const capability={url:body.sessionWebhook,recipient:{platformScope:recipient.platformScope,robotId:recipient.robotId,platformConversationId:recipient.platformConversationId}};
test('DingTalk normalization separates original ID, transport ID, robot identity and enterprise identity',()=>{
  const first=normalizeCallback('transport-1',body,context,1000)!;
  const repeated=normalizeCallback('transport-2',body,context,1100)!;
  assert.equal(first.event.originalMessageId,repeated.event.originalMessageId);
  assert.notEqual(first.event.transportMessageId,repeated.event.transportMessageId);
  assert.equal(first.event.robotId,body.robotCode);assert.equal(first.event.chatbotUserId,'bot-user');
  assert.equal(first.event.senderId,'sender');assert.equal(first.event.enterpriseUserId,'enterprise-user');
  assert.equal(first.event.dedupNamespace,repeated.event.dedupNamespace);
  assert.equal(normalizeCallback('t',{...body,robotCode:'other'},context,1000),undefined);
  assert.equal(normalizeCallback('t',{...body,msgId:undefined},context,1000),undefined);
});
test('webhook sends exactly once, recognizes explicit acceptance and treats transport/opaque errors as unknown',async()=>{
  let calls=0;
  const request=(async(_url,init)=>{calls++;assert.equal(init?.redirect,'error');return Response.json({errcode:0});}) as typeof fetch;
  assert.equal((await sendWebhook('hello',recipient,route,capability,request,1000)).status,'confirmed');
  assert.equal(calls,1);
  const timeout=(async()=>{calls++;throw new Error('synthetic-private-detail');}) as typeof fetch;
  assert.deepEqual(await sendWebhook('hello',recipient,route,capability,timeout,1000),{status:'unknown',safeReason:'delivery_failed'});
  assert.equal(calls,2);
  for(const response of [new Response('',{status:500}),Response.json({errcode:999999}),Response.json({unexpected:'private'})])
    assert.equal((await sendWebhook('hello',recipient,route,capability,(async()=>response) as typeof fetch,1000)).status,'unknown');
});
test('webhook validates original recipient, expiry, codepoint limit and destination before the network',async()=>{
  const request=(async()=>{assert.fail('network must not be called');}) as typeof fetch;
  assert.equal((await sendWebhook('hello',recipient,route,capability,request,2000)).status,'route_unavailable');
  assert.equal((await sendWebhook('12345678901',recipient,route,capability,request,1000)).status,'not_sent');
  assert.equal((await sendWebhook('hello',{...recipient,id:'other'},route,capability,request,1000)).status,'route_unavailable');
  assert.equal((await sendWebhook('hello',recipient,route,{...capability,url:'https://example.invalid/robot/sendBySession'},request,1000)).status,'route_unavailable');
  assert.equal((await sendWebhook('hello',recipient,route,{...capability,recipient:{...capability.recipient,platformConversationId:'other'}},request,1000)).status,'route_unavailable');
  assert.deepEqual(await inspectDelivery(),{status:'unsupported'});
  assert.deepEqual(await sendOto(),{status:'route_unavailable',code:'recipient'});
});
