import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeUrl, isWebPage, outcomeOf, reported, sendSignals } from "../src/actions.ts";
import { CONFIG } from "../src/config.ts";

const signals = { url: "https://www.theguardian.com/profile/david-adler", feeds: [], rel_me: [], same_as: [], author_urls: [] };

const recording = (status, body = "{}") => {
  const calls = [];
  const fetcher = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(body, { status }));
  };
  return { calls, fetcher };
};

test("claudeUrl prefills /follow with the page, encoded", () => {
  const url = new URL(claudeUrl("https://example.com/a b?x=1&y=2#frag"));
  assert.equal(url.origin + url.pathname, CONFIG.CLAUDE_NEW_CHAT_URL);
  assert.equal(url.searchParams.get("q"), "/follow https://example.com/a b?x=1&y=2#frag");
  assert.equal([...url.searchParams.keys()].length, 1);
});

test("isWebPage takes http(s) pages only", () => {
  for (const url of ["https://example.com/", "http://example.com/", "HTTPS://EXAMPLE.COM/"]) assert.ok(isWebPage(url));
  for (const url of [undefined, "", "about:blank", "chrome://extensions", "moz-extension://x/popup.html", "file:///tmp/a.html", "javascript:alert(1)"]) {
    assert.ok(!isWebPage(url), String(url));
  }
});

test("sendSignals posts the signals as JSON with the bearer token", async () => {
  const { calls, fetcher } = recording(200);
  assert.deepEqual(await sendSignals(signals, "tok", fetcher), {
    ok: true,
    message: "Sent to your seb.now inbox.",
    connection: "active",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CONFIG.INTAKE_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(calls[0].init.body), signals);
  // No cookies or credentials of the reader's ride along.
  assert.equal(calls[0].init.credentials, undefined);
});

test("every intake refusal reads as a failure with a reason", async () => {
  for (const status of [401, 413, 422, 429, 500, 503]) {
    const outcome = await sendSignals(signals, "tok", recording(status).fetcher);
    assert.equal(outcome.ok, false, String(status));
    assert.ok(outcome.message.length > 0);
  }
  assert.match(outcomeOf(418).message, /418/);
});

test("a network failure is an outcome, not a throw", async () => {
  const outcome = await sendSignals(signals, "tok", () => Promise.reject(new TypeError("offline")));
  assert.equal(outcome.ok, false);
});

test("a 401 means this device's connection is gone", async () => {
  const outcome = await sendSignals(signals, "tok", recording(401).fetcher);
  assert.equal(outcome.connection, "gone");
});

test("a 403 means waiting for approval, with the code the intake names", async () => {
  const body = JSON.stringify({ error: "waiting for approval", pair_code: "K7Q-2MX" });
  const outcome = await sendSignals(signals, "tok", recording(403, body).fetcher);
  assert.deepEqual(outcome, {
    ok: false,
    message: "Waiting for approval, code K7Q-2MX.",
    connection: "pending",
    pairCode: "K7Q-2MX",
  });
  const unreadable = await sendSignals(signals, "tok", recording(403, "not json").fetcher);
  assert.equal(unreadable.connection, "pending");
  assert.equal(unreadable.pairCode, undefined);
});

test("reported shows busy, then the outcome, and turns a throw into one", async () => {
  const shown = [];
  const show = (outcome) => shown.push(outcome);
  await reported(show)(() => Promise.resolve({ ok: true, message: "done" }))();
  await reported(show)(() => Promise.reject(new Error("boom")))();
  assert.deepEqual(shown, ["busy", { ok: true, message: "done" }, "busy", { ok: false, message: "boom" }]);
});
