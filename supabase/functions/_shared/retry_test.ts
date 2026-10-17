import { assertEquals } from "jsr:@std/assert@1";
import { constant, exponential, retry } from "./retry.ts";

Deno.test("retry stops at the first outcome not worth retrying", async () => {
  const outcomes = [503, 503, 200, 503];
  const released: number[] = [];
  const { outcome, attempts } = await retry<number>({
    attempts: 5,
    delayMs: constant(0),
    retryIf: (status) => status === 503,
    onRetry: (status) => void released.push(status),
  })((n) => Promise.resolve(outcomes[n - 1]));
  assertEquals({ outcome, attempts }, { outcome: 200, attempts: 3 });
  assertEquals(released, [503, 503]);
});

Deno.test("retry returns the last outcome once the attempts run out", async () => {
  const started: number[] = [];
  const result = await retry<string>({
    attempts: 3,
    delayMs: constant(0),
    retryIf: () => true,
    onAttempt: (n) => void started.push(n),
  })((n) => Promise.resolve(`try ${n}`));
  assertEquals(result, { outcome: "try 3", attempts: 3 });
  assertEquals(started, [1, 2, 3]);
});

Deno.test("exponential doubles from the base before the second attempt", () => {
  assertEquals([2, 3, 4].map(exponential(1000)), [1000, 2000, 4000]);
});
