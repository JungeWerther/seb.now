// A concurrency gate as a wrapper: `const gate = limited(n)` and then
// `gate(fn)` is `fn` with at most `n` calls in flight across every function
// wrapped by that same gate; the rest wait their turn, first come first
// served. A call holds its slot until it settles, rejected or not, so a
// wrapped function that retries keeps its slot through its retries and waits.

export function limited(size: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = (): Promise<void> =>
    active < size ? (active++, Promise.resolve()) : new Promise((resolve) => waiting.push(() => (active++, resolve())));
  // The freed slot goes straight to the next waiter, if any.
  const release = () => {
    active--;
    waiting.shift()?.();
  };
  return <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    await acquire();
    try {
      return await fn(...args);
    } finally {
      release();
    }
  };
}
