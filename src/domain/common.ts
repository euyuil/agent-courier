import { randomUUID } from 'node:crypto';

export type Id<Entity extends string> = string & { readonly __entity: Entity };
export type Timestamp = number;
export type Sequence = number;
export function newId<Entity extends string>(): Id<Entity> { return randomUUID() as Id<Entity>; }
export interface Clock { now(): Timestamp }
export const systemClock: Clock = { now: () => Date.now() };
export function assertNever(value: never): never { throw new Error(`unsupported_variant:${typeof value}`); }
