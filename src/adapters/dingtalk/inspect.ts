import type { DeliveryInspection } from './port.js';
// The webhook protocol has no verified query keyed by Courier delivery ID.
export async function inspectDelivery():Promise<DeliveryInspection> {return {status:'unsupported'};}
