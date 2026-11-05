import { newId, type Clock, systemClock } from '../../domain/common.js';
import { contextFingerprint, optionalCapabilities, requiredCapabilities, type CapabilityName, type CapabilityState } from '../../domain/capabilities.js';
import type { AnswerInput, CommandHandle, HarnessPort, Inspection, ProbeReport, Receipt, SessionInput, StartInput, SteerInput } from '../harness/port.js';
import type { HarnessEvent, EventPayloads, OutputKind } from '../harness/events.js';

export interface FakeOptions {
  steerMode?: 'timely' | 'queued' | 'late' | 'unsupported'; writerOccupied?: boolean; authenticated?: boolean;
  receiptStatus?: 'accepted' | 'rejected' | 'unknown'; deferReceipts?: boolean; silentEvents?:boolean; clock?: Clock;
}
interface FakeSession { history: string[]; activeRun?: string; clientRunId?: string; waiting: boolean }
export class FakeHarness implements HarnessPort {
  readonly calls: { kind: string; input: unknown }[] = [];
  readonly applied: { inputId: string; runRef: string; text: string }[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly pendingReceipts = new Map<string, (receipt: Receipt) => void>();
  readonly inspections = new Map<string, Inspection>();
  private readonly listeners = new Map<string, Set<(event: HarnessEvent) => void>>();
  private sequence = 0;
  private checkedAt: number | undefined;
  private readonly evidenceId=newId<'capability-evidence'>();
  options: FakeOptions;
  constructor(options: FakeOptions = {}) { this.options = options; }
  async probe(instanceId: string): Promise<ProbeReport> {
    const clock = this.options.clock ?? systemClock;
    this.checkedAt ??= clock.now();
    const capabilities = Object.fromEntries([...requiredCapabilities, ...optionalCapabilities].map(name => [name,
      optionalCapabilities.includes(name as typeof optionalCapabilities[number]) ? 'unsupported' : 'supported'])) as Record<CapabilityName, CapabilityState>;
    if (this.options.steerMode && this.options.steerMode !== 'timely') capabilities.timelySteer = 'unsupported';
    const fingerprint = contextFingerprint({ targetRef: instanceId, cliVersion: null, transportKind: 'fake', authorizationScope: [], limitProfile: null });
    return { kind: 'fake', product: 'synthetic-harness', productVersion: '1', adapterVersion: '1',
      authenticationStatus: this.options.authenticated === false ? 'required' : 'authenticated', capabilities,
      contextFingerprint: fingerprint, limitations: ['模拟证据仅适用于 fake。'],
      evidenceRefs: [{ id: this.evidenceId, kind: 'fake', adapterVersion: '1', productVersion: '1',
        scope: Object.fromEntries(requiredCapabilities.map(name => [name, { states: ['running', 'waiting_input'], limitations: [] }])),
        contextFingerprint: fingerprint, checkedAt: this.checkedAt, outcome: 'passed', evidenceRef: 'synthetic-verification' }] };
  }
  private handle(operationId: string, accepted: Extract<Receipt, { status: 'accepted' }>, error?: Extract<Receipt, { status: 'rejected' }>): CommandHandle {
    let receipt: Receipt = error ?? accepted;
    if (!error && this.options.receiptStatus === 'unknown') receipt = { status: 'unknown', errorCode: 'state_unknown' };
    if (!error && this.options.receiptStatus === 'rejected') receipt = { status: 'rejected', errorCode: 'steer_rejected', definitelyNotAccepted: true };
    return { operationId, receipt: this.options.deferReceipts ? new Promise(resolve => { this.pendingReceipts.set(operationId, resolve); }) : Promise.resolve(receipt) };
  }
  createSession(input: { operationId: string; courierSessionId: string }): CommandHandle {
    this.calls.push({ kind: 'create', input });
    const ref = newId<'synthetic-harness-session'>();
    if (this.options.receiptStatus !== 'rejected') this.sessions.set(ref, { history: [], waiting: false });
    return this.handle(input.operationId, { status: 'accepted', sessionRef: ref, receiptEvidence: 'synthetic-create' });
  }
  resumeSession(input: SessionInput): CommandHandle {
    this.calls.push({ kind: 'load', input });
    const code = this.options.authenticated === false ? 'auth_required' : this.options.writerOccupied ? 'writer_occupied'
      : !this.sessions.has(input.sessionRef) ? 'session_missing' : undefined;
    return this.handle(input.operationId, { status: 'accepted', sessionRef: input.sessionRef, receiptEvidence: 'synthetic-load' },
      code ? { status: 'rejected', errorCode: code, definitelyNotAccepted: true } : undefined);
  }
  start(input: StartInput): CommandHandle {
    this.calls.push({ kind: 'start', input });
    const session = this.sessions.get(input.sessionRef);
    if (!session) return this.handle(input.operationId, { status: 'accepted', sessionRef: input.sessionRef, receiptEvidence: 'synthetic' },
      { status: 'rejected', errorCode: 'session_missing', definitelyNotAccepted: true });
    const runRef = newId<'synthetic-run'>();
    if (this.options.receiptStatus !== 'rejected') {
      session.activeRun = runRef; session.clientRunId = input.clientRunId; session.history.push(input.text);
      if(this.options.receiptStatus!=='unknown'&&!this.options.silentEvents)this.emit(input.sessionRef, runRef, 'run.started', { clientRunId: input.clientRunId, runRef });
    }
    return this.handle(input.operationId, { status: 'accepted', sessionRef: input.sessionRef, runRef, receiptEvidence: 'synthetic-start' });
  }
  steer(input: SteerInput): CommandHandle {
    this.calls.push({ kind: 'steer', input });
    const session = this.sessions.get(input.sessionRef);
    const accepted = { status: 'accepted' as const, sessionRef: input.sessionRef, runRef: input.expectedRunRef, receiptEvidence: 'synthetic-steer' };
    if (!session?.activeRun || session.activeRun !== input.expectedRunRef) return this.handle(input.operationId, accepted,
      { status: 'rejected', errorCode: 'stale_run', definitelyNotAccepted: true });
    if (this.options.receiptStatus !== 'rejected' && (!this.options.steerMode || this.options.steerMode === 'timely')) {
      session.history.push(input.text); this.applied.push({ inputId: input.inputId, runRef: input.expectedRunRef, text: input.text });
      if(this.options.receiptStatus!=='unknown'&&!this.options.silentEvents)this.emit(input.sessionRef, input.expectedRunRef, 'input.applied', { inputId: input.inputId, appliedEvidence: 'synthetic-consumption-before-completion' });
    }
    return this.handle(input.operationId, accepted);
  }
  answer(input: AnswerInput): CommandHandle {
    this.calls.push({ kind: 'answer', input });
    return this.handle(input.operationId, { status: 'accepted', sessionRef: input.sessionRef,
      runRef: input.runRef, vendorRequestId: input.vendorRequestId, receiptEvidence: 'synthetic-answer' });
  }
  subscribe(sessionRef: string, listener: (event: HarnessEvent) => void): () => void {
    const set = this.listeners.get(sessionRef) ?? new Set(); set.add(listener); this.listeners.set(sessionRef, set);
    return () => { set.delete(listener); };
  }
  emit<K extends keyof EventPayloads>(sessionRef: string, runRef: string, eventType: K, payload: EventPayloads[K], eventKey?: string): HarnessEvent {
    const event = { schemaVersion: 1, eventKey: eventKey ?? `synthetic-event-${++this.sequence}`, sessionRef, runRef,
      eventType, payload } as HarnessEvent;
    for (const listener of this.listeners.get(sessionRef) ?? []) listener(event);
    return event;
  }
  message(sessionRef: string, runRef: string, kind: OutputKind, text: string, messageId: string = newId<'synthetic-message'>()): string {
    this.emit(sessionRef, runRef, 'message.started', { messageId, kind, userVisible: true, logicalOrder: ++this.sequence });
    this.emit(sessionRef, runRef, 'message.fragment', { messageId, fragmentKey: `${messageId}-0`, fragmentIndex: 0, text });
    this.emit(sessionRef, runRef, 'message.completed', { messageId, finalFragmentIndex: 0 });
    return messageId;
  }
  complete(sessionRef: string): void {
    const session = this.sessions.get(sessionRef)!;
    this.emit(sessionRef, session.activeRun!, 'run.completed', { completionEvidence: 'synthetic-completion', stopReason: 'end_turn' });
    delete session.activeRun;
  }
  async inspect(input: { operationId?: string }): Promise<Inspection> { return this.inspections.get(input.operationId ?? '') ?? { status: 'unsupported' }; }
  async disconnect(): Promise<void> { this.listeners.clear(); }
  count(kind: string): number { return this.calls.filter(call => call.kind === kind).length; }
}
