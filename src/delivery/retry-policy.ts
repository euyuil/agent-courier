export function nextRetry(now:number,attemptCount:number,maxAutomaticRetries:number,retryAfter?:number):number|undefined {
  if (attemptCount>=1+maxAutomaticRetries) return undefined;
  const base=1000*2**(attemptCount-1);
  return now+Math.max(base,retryAfter??0);
}
