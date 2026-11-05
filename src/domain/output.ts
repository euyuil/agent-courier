import type { OutputKind } from '../adapters/harness/events.js';
export interface HarnessEventRecord { id: string; bindingId: string; runId: string; sourceEventKey: string; eventType: string; sequence?: number; payloadRef: string; processedAt: number }
export interface OutputMessage { id: string; runId: string; sourceMessageId: string; kind: OutputKind; userVisible: boolean; logicalSequence: number; completeness: 'assembling' | 'complete' | 'invalid'; selected: boolean; hiddenReason?: string; contentRef: string }
export interface OutputFragment { id: string; outputMessageId: string; sourceFragmentKey: string; fragmentIndex: number; textRef: string }
