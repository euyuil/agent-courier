import type { SendResult } from './port.js';
// No verified enterprise-user mapping or OTO authorization is inferred from senderId.
export async function sendOto():Promise<SendResult> {return {status:'route_unavailable',code:'recipient'};}
