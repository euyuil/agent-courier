export type CrashWindow = 'before_call' | 'after_remote' | 'after_commit' | 'event_before_commit' | 'event_after_commit';
export class InjectedCrash extends Error {
  constructor(readonly window: CrashWindow) { super('injected_crash'); }
}
export class Faults {
  private armed: CrashWindow | undefined;
  arm(window: CrashWindow): void { this.armed = window; }
  hit(window: CrashWindow): void {
    if (this.armed === window) {
      this.armed = undefined;
      throw new InjectedCrash(window);
    }
  }
}
