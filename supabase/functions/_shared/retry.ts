// Retrying as a wrapper: `retry(policy)(run)` calls `run` until its outcome
// isn't worth another try or the attempts run out, and returns the last
// outcome with how many attempts it took. What counts as worth retrying, the
// wait between attempts and what to do before one are the policy's hooks, so
// a caller states its rule instead of writing the loop.

export interface RetryPolicy<T> {
  attempts: number;
  // Wait before attempt `next` (2, 3, ...).
  delayMs: (next: number) => number;
  retryIf: (outcome: T) => boolean;
  // Runs on an outcome that is about to be retried, e.g. to release it.
  onRetry?: (outcome: T) => Promise<void> | void;
  // Runs as each attempt starts.
  onAttempt?: (attempt: number) => void;
}

export interface Retried<T> {
  outcome: T;
  attempts: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function retry<T>(policy: RetryPolicy<T>) {
  return (run: (attempt: number) => Promise<T>): Promise<Retried<T>> => {
    const attempt = async (n: number): Promise<Retried<T>> => {
      policy.onAttempt?.(n);
      const outcome = await run(n);
      if (n >= policy.attempts || !policy.retryIf(outcome)) return { outcome, attempts: n };
      await policy.onRetry?.(outcome);
      await sleep(policy.delayMs(n + 1));
      return attempt(n + 1);
    };
    return attempt(1);
  };
}

// 2^(n-2) × base before attempt n: base, 2·base, 4·base, ...
export const exponential = (baseMs: number) => (next: number) => baseMs * 2 ** (next - 2);
export const constant = (ms: number) => () => ms;
