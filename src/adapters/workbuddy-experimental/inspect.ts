import type { Inspection } from '../harness/port.js';
// History presence and connection state cannot establish an operation's side effects.
export async function inspect():Promise<Inspection> {return {status:'unsupported'};}
