export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };

export class VirtualClock implements Clock {
  constructor(private time = Date.UTC(2026, 10, 5)) {}
  now(): number { return this.time; }
  advance(milliseconds: number): void {
    if (milliseconds < 0) throw new Error('clock_backwards');
    this.time += milliseconds;
  }
}

export class Barrier {
  private release!: () => void;
  readonly reached = new Promise<void>(resolve => { this.release = resolve; });
  signal(): void { this.release(); }
}
