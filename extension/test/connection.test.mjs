import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIG } from "../src/config.ts";
import { acceptHandOver, connectUrl, isConnection, newNonce } from "../src/connection.ts";

const NOW = 1_800_000_000_000;
const pending = { nonce: "n".repeat(32), at: NOW - 1000 };
const token = `sft_${"ab".repeat(32)}`;
const message = (fields = {}) => ({ type: "seb-follow-token", nonce: pending.nonce, token, status: "active", pairCode: null, ...fields });

test("a hand-over from seb.now with this extension's nonce is taken", () => {
  assert.deepEqual(acceptHandOver(CONFIG.SEB_NOW_ORIGIN, message(), pending, NOW), { token, status: "active", pairCode: null });
  assert.deepEqual(acceptHandOver(CONFIG.SEB_NOW_ORIGIN, message({ status: "pending", pairCode: "K7Q-2MX" }), pending, NOW), {
    token,
    status: "pending",
    pairCode: "K7Q-2MX",
  });
});

test("an active token carries no code, whatever the message says", () => {
  assert.equal(acceptHandOver(CONFIG.SEB_NOW_ORIGIN, message({ pairCode: "K7Q-2MX" }), pending, NOW).pairCode, null);
});

for (const [why, args] of [
  ["another origin", ["https://evil.example", message(), pending, NOW]],
  ["a look-alike origin", ["https://seb.now.evil.example", message(), pending, NOW]],
  ["http seb.now", ["http://seb.now", message(), pending, NOW]],
  ["no Connect waiting", [CONFIG.SEB_NOW_ORIGIN, message(), undefined, NOW]],
  ["another nonce", [CONFIG.SEB_NOW_ORIGIN, message({ nonce: "m".repeat(32) }), pending, NOW]],
  ["a Connect too old", [CONFIG.SEB_NOW_ORIGIN, message(), { ...pending, at: NOW - CONFIG.NONCE_TTL_MS - 1 }, NOW]],
  ["another message type", [CONFIG.SEB_NOW_ORIGIN, message({ type: "seb-follow-connected" }), pending, NOW]],
  ["a token of the wrong shape", [CONFIG.SEB_NOW_ORIGIN, message({ token: "sft_short" }), pending, NOW]],
  ["a token with extra text", [CONFIG.SEB_NOW_ORIGIN, message({ token: `${token}\n` }), pending, NOW]],
  ["an unknown status", [CONFIG.SEB_NOW_ORIGIN, message({ status: "revoked" }), pending, NOW]],
  ["a pending token without a code", [CONFIG.SEB_NOW_ORIGIN, message({ status: "pending" }), pending, NOW]],
  ["a malformed code", [CONFIG.SEB_NOW_ORIGIN, message({ status: "pending", pairCode: "<b>x</b>" }), pending, NOW]],
  ["not an object", [CONFIG.SEB_NOW_ORIGIN, "seb-follow-token", pending, NOW]],
  ["null", [CONFIG.SEB_NOW_ORIGIN, null, pending, NOW]],
  ["an array", [CONFIG.SEB_NOW_ORIGIN, [message()], pending, NOW]],
]) {
  test(`a hand-over is refused from ${why}`, () => assert.equal(acceptHandOver(...args), null));
}

test("nonces are 32 base64url characters, from the random source", () => {
  const nonce = newNonce();
  assert.match(nonce, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(newNonce(), nonce);
  assert.equal(newNonce((b) => b.fill(255)), "_".repeat(32));
});

test("Connect opens seb.now/connect with the nonce in the fragment, never the query", () => {
  const url = new URL(connectUrl("abc_-123"));
  assert.equal(url.origin, CONFIG.SEB_NOW_ORIGIN);
  assert.equal(url.pathname, CONFIG.CONNECT_PATH);
  assert.equal(url.search, "");
  assert.equal(url.hash, "#nonce=abc_-123");
});

test("only a well-formed stored connection is read back", () => {
  assert.ok(isConnection({ token, status: "active", pairCode: null }));
  for (const value of [undefined, null, {}, { token: "x", status: "active" }, { token, status: "revoked" }, "token"]) {
    assert.ok(!isConnection(value), JSON.stringify(value));
  }
});

test("Connect needs access to seb.now first, and stores nothing without it", async () => {
  const { startConnect } = await import("../src/connection.ts");
  const calls = [];
  globalThis.chrome = {
    storage: { local: { set: async (v) => calls.push(["set", v]) } },
    tabs: { create: async (v) => calls.push(["open", v.url]) },
  };
  try {
    await assert.rejects(startConnect(Promise.resolve(false)), /access to seb\.now/);
    assert.deepEqual(calls, []);
    await startConnect(Promise.resolve(true));
    assert.equal(calls[0][0], "set");
    assert.match(calls[1][1], /^https:\/\/seb\.now\/connect#nonce=[A-Za-z0-9_-]{32}$/);
  } finally {
    delete globalThis.chrome;
  }
});
