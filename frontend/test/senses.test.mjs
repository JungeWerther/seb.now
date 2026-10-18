// Runs the compiled senses.js, as the page does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const compiled = (name) => readFileSync(new URL(`../../src/seb_now/templates/${name}.js`, import.meta.url), "utf8");
const source = `${compiled("prelude")}\n${compiled("senses")}`;
const { lexicon, claimNames, commonKindPath, senseLabel } = vm.runInNewContext(
  `${source}\n;({ lexicon, claimNames, commonKindPath, senseLabel })`,
);

const plain = (x) => JSON.parse(JSON.stringify(x));
const fold = (name) => name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && w !== "the");
const matches = (typed, word, partial) => typed === word || (partial && word.startsWith(typed));
const typed = (text) => {
  const words = fold(text);
  return words.map((word, i) => ({ word, partial: i === words.length - 1 && !text.endsWith(" "), open: true }));
};
const named = (...pairs) => pairs.map(([name, id]) => ({ name, sense: { id } }));
const lex = (...pairs) => lexicon(named(...pairs), fold, (s) => s.id);
const read = (text, entries, complete = true) =>
  plain(claimNames(typed(text), entries, matches, complete).map((c) => [c.entry.words.join(" "), c.at]));

test("same words are one entry with every sense, kept once each", () => {
  const entries = lex(["Nightcall", "a"], ["The Nightcall", "b"], ["Event", "c"], ["event", "c"], ["Night Owl", "d"]);
  assert.deepEqual(plain(entries.map((e) => [e.words.join(" "), e.senses.map((s) => s.id)])), [
    ["night owl", ["d"]],
    ["nightcall", ["a", "b"]],
    ["event", ["c"]],
  ]);
});

test("a prefix shared by several names is no reading", () => {
  const entries = lex(["Nightcall", "a"], ["Nightwatch", "b"], ["Night Owl", "c"]);
  assert.deepEqual(read("night", entries), []);
  assert.deepEqual(read("night ", entries), []);
});

test("a prefix only one name has completes it", () => {
  const entries = lex(["Nightcall", "a"], ["The Nightcall", "b"], ["Nightwatch", "c"]);
  assert.deepEqual(read("nightc", entries), [["nightcall", [0]]]);
  assert.deepEqual(read("nightc", entries, false), []);
});

test("whole words come first, so a typed word is never a longer name's guess", () => {
  const entries = lex(["Eventail", "a"], ["Event", "b"]);
  assert.deepEqual(read("event", entries), [["event", [0]]]);
});

test("longer names take their words before shorter ones", () => {
  const entries = lex(["Tim", "a"], ["Tim Fernholz", "b"]);
  assert.deepEqual(read("tim fernholz ", entries), [["tim fernholz", [0, 1]]]);
  assert.deepEqual(read("tim fern", entries), [["tim", [0]]]);
});

test("a multi-word name finishes on its last word's only completion", () => {
  const entries = lex(["AI agents", "a"], ["robotics", "b"]);
  assert.deepEqual(read("ai agen", entries), [["ai agents", [0, 1]]]);
});

test("words already taken stay taken", () => {
  const words = typed("top night");
  words[0].open = false;
  const got = claimNames(words, lex(["Top Night", "a"]), matches, true);
  assert.deepEqual(plain(got), []);
});

test("the common kind is the longest shared path prefix", () => {
  assert.equal(commonKindPath(["entity.artifact.work", "entity.artifact.product"]), "entity.artifact");
  assert.equal(commonKindPath(["entity.artifact.work", "entity.artifact.work"]), "entity.artifact.work");
  assert.equal(commonKindPath(["entity.place", "entity.agent.org"]), "entity");
  assert.equal(commonKindPath(["entity.place", null]), null);
  assert.equal(commonKindPath([]), null);
});

test("a tag reads one sense as its label and several as what they share", () => {
  const name = (path) => path.split(".").at(-1);
  const work = { label: "work", path: "entity.artifact.work" };
  const product = { label: "product", path: "entity.artifact.product" };
  const topic = { label: "topic", path: null };
  assert.equal(senseLabel([work], name), "work");
  assert.equal(senseLabel([work, work], name), "work ×2");
  assert.equal(senseLabel([work, product, work], name), "artifact ×3");
  assert.equal(senseLabel([work, topic], name), "senses ×2");
  assert.equal(senseLabel([], name), "");
});
