import type { OutputKind } from '../adapters/harness/events.js';
export { displaySchema } from '../config/schema.js';
export type { DisplayPolicy } from '../config/schema.js';
export function policyKey(kind:OutputKind) {return kind==='permission_request'?'permissionRequest':kind==='tool_status'?'toolStatus':kind;}
