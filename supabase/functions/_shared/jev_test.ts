import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { JevClient } from "./jev.ts";

function stubFetch(statuses: number[]): { calls: () => number; restore: () => void } {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    const status = statuses[calls++];
    const body = status === 200 ? JSON.stringify({ answers: { q: "a" }, model: "m", usage: { input_tokens: 1, output_tokens: 1 } }) : "busy";
    return Promise.resolve(new Response(body, { status }));
  };
  return { calls: () => calls, restore: () => globalThis.fetch = real };
}

Deno.test("ask retries a 429 and returns the answer that follows", async () => {
  const stub = stubFetch([429, 200]);
  try {
    const result = await new JevClient("key", "model").ask({}, { q: { type: "choice", options: ["a"] } } as never);
    assertEquals(result.answers, { q: "a" } as never);
    assertEquals(stub.calls(), 2);
  } finally {
    stub.restore();
  }
});

Deno.test("ask doesn't retry a status that isn't retryable", async () => {
  const stub = stubFetch([400, 200]);
  try {
    await assertRejects(() => new JevClient("key", "model").ask({}, {}), Error, "TypeSafe 400");
    assertEquals(stub.calls(), 1);
  } finally {
    stub.restore();
  }
});
