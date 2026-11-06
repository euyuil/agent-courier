import type { NormalizedInbound } from '../adapters/dingtalk/port.js';
import type { Runtime, CourierDependencies } from './runtime.js';
import { CourierError } from '../domain/errors.js';
import { receive } from './inbound.js';
import { scheduleOutput } from '../delivery/output-scheduling.js';
import { saveEvidence, saveInstance } from '../storage/capabilities.js';
import { insert, decode } from '../storage/records.js';
import { newId } from '../domain/common.js';
import { transaction } from '../storage/database.js';
import { subscribe } from './sessions.js';
import type { HarnessBinding } from '../domain/session.js';
import { recover } from './recovery.js';
import { reloadConfig } from '../config/reload.js';
import { syntheticLimits,syntheticPlatformEvidence,platformFingerprint } from '../adapters/testing/evidence.js';
import { contextFingerprint } from '../domain/capabilities.js';
import { closeInOrder } from './shutdown.js';
export type { CourierDependencies } from './runtime.js';
export interface AcceptResult { status: 'ignored' | 'duplicate' | 'accepted' | 'rejected' | 'unknown'; inputId?: string }
export class Courier {
  readonly runtime: Runtime;
  private readonly inFlight=new Set<Promise<unknown>>();
  private closing:Promise<void>|undefined;
  private readonly platformEvidenceId:string|undefined;
  constructor(readonly dependencies: CourierDependencies) {
    const fake=dependencies.config.platform.kind==='fake';
    if(fake!==(dependencies.config.harness.adapter==='mock') || (!fake&&!dependencies.platformEvidenceTarget))throw new CourierError('capability_unverified');
    this.runtime={...dependencies,loaded:new Set(),subscriptions:new Map(),diagnostics:[],closed:false,answerPriority:new Map()};
    const ctx=this.runtime;
    recover(ctx.db);
    if(fake) {
    const limits=syntheticLimits();
    const priorEvidence=ctx.db.prepare("SELECT id FROM capability_evidence WHERE kind='fake' AND contextFingerprint=? AND evidenceRef='synthetic-platform-budget-only' ORDER BY rowid DESC LIMIT 1").get(platformFingerprint(ctx.config,limits)) as {id:string}|undefined;
    this.platformEvidenceId=priorEvidence?.id??newId<'capability-evidence'>();
    transaction(ctx.db,()=>{
      if (!ctx.db.prepare('SELECT id FROM harness_instances WHERE id=?').get(ctx.config.harness.instanceId)) {
        const evidenceId=newId<'capability-evidence'>();
        saveEvidence(ctx.db,{id:evidenceId,kind:'fake',adapterVersion:'1',productVersion:'1',scope:{},contextFingerprint:contextFingerprint({targetRef:ctx.config.harness.instanceId,cliVersion:null,transportKind:'fake',authorizationScope:[],limitProfile:null}),checkedAt:ctx.clock.now(),outcome:'unverified',evidenceRef:'synthetic-unverified'});
        saveInstance(ctx.db,{id:ctx.config.harness.instanceId,adapterKind:'mock',productVersion:'1',capabilityEvidenceId:evidenceId,readiness:'unverified'});
      }
      if(!priorEvidence)saveEvidence(ctx.db,{...syntheticPlatformEvidence(ctx.config,ctx.clock.now(),limits),id:this.platformEvidenceId!});
    });
    }
    const bindings=ctx.db.prepare('SELECT * FROM harness_bindings WHERE harnessSessionId IS NOT NULL').all();
    for (const row of bindings) subscribe(ctx,decode<HarnessBinding>(row)!);
  }
  async accept(event: NormalizedInbound): Promise<AcceptResult> {
    if(this.runtime.closed)throw new CourierError('state_unknown');
    if(this.runtime.readConfig) {
      try{this.reload(this.runtime.readConfig());}
      catch{this.configReloadFailure();}
    }
    const task=this.receive(event);this.inFlight.add(task);
    try{return await task;}finally{this.inFlight.delete(task);}
  }
  private async receive(event:NormalizedInbound):Promise<AcceptResult> {
    const result=await receive(this.runtime,event);
    if(this.runtime.config.platform.kind==='fake')transaction(this.runtime.db,()=>{
      const recipients=this.runtime.db.prepare('SELECT id FROM recipients WHERE id NOT IN (SELECT recipientId FROM delivery_routes)').all() as {id:string}[];
      for (const recipient of recipients) insert(this.runtime.db,'delivery_routes',{id:newId<'route'>(),recipientId:recipient.id,kind:'sessionWebhook',
        verifiedLimits:syntheticLimits(),capabilityEvidenceId:this.platformEvidenceId,status:'ready'});
    });
    return result;
  }
  async flush(): Promise<void> {
    if(this.runtime.closed)return;
    const task=scheduleOutput(this.runtime);this.inFlight.add(task);
    try { await task; } finally { this.inFlight.delete(task); }
  }
  reload(config:unknown):boolean {
    try{this.runtime.config=reloadConfig(this.runtime.config,config);return true;}
    catch{return this.configReloadFailure();}
  }
  private configReloadFailure():false {
    this.runtime.diagnostics.push({code:'configuration_invalid'});
    try{this.runtime.onConfigReloadFailure?.();}catch{/* 操作者日志失败不替代原有效配置，也不影响当前输入。 */}
    return false;
  }
  close(): Promise<void> {
    if(this.closing)return this.closing;
    this.runtime.closed=true;
    this.closing=closeInOrder([
      ()=>this.runtime.harness.disconnect(this.runtime.config.harness.instanceId),
      ()=>Promise.allSettled(this.inFlight),
      async()=>{
        try{await closeInOrder([...this.runtime.subscriptions.values()]);}
        finally{this.runtime.subscriptions.clear();}
      },
    ]);
    return this.closing;
  }
}
