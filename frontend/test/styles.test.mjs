// Runs the compiled styles.js after prelude.js, as the page does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (name) => readFileSync(new URL(`../../src/seb_now/templates/${name}`, import.meta.url), "utf8");
const { styleDeclarations, styleProperties, contrastRatio, contrastResults } = vm.runInNewContext(
  `${read("prelude.js")}\n${read("styles.js")}\n;({ styleDeclarations, styleProperties, contrastRatio, contrastResults })`,
);

const plain = (x) => JSON.parse(JSON.stringify(x));

// The layout type as the database stores it, plus a number and an enum token.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["column_width", "density", "dock_width", "font", "weight"],
  properties: {
    column_width: { $ref: "#/$defs/length", description: "The feed column" },
    dock_width: { $ref: "#/$defs/length" },
    font: { $ref: "#/$defs/font" },
    weight: { $ref: "#/$defs/number" },
    density: { enum: ["compact", "roomy"] },
  },
  $defs: {
    length: { type: "string", pattern: "^(0|[0-9]{1,4}(\\.[0-9]{1,3})?(px|rem|em|vw|vh|%))$" },
    font: { type: "string", pattern: '^[A-Za-z0-9 ,"-]{1,120}$' },
    number: { type: "number", minimum: -10000, maximum: 10000 },
  },
};
const STYLE = { column_width: "640px", dock_width: "30rem", font: '"Inter", sans-serif', weight: 1.5, density: "roomy" };

test("a style's tokens become custom properties", () => {
  assert.deepEqual(plain(styleDeclarations(SCHEMA, STYLE)), [
    ["--column-width", "640px"],
    ["--dock-width", "30rem"],
    ["--font", '"Inter", sans-serif'],
    ["--weight", "1.5"],
    ["--density", "roomy"],
  ]);
});

test("a value its type doesn't allow is dropped, the others kept", () => {
  const cases = {
    "url()": { column_width: "url(https://x/?leak)" },
    "a way out of the declaration": { column_width: "1px;}body{" },
    "a number as a string": { weight: "1.5" },
    "a number out of bounds": { weight: 10001 },
    "not a finite number": { weight: Infinity },
    "a keyword not in the enum": { density: "tight" },
    "a missing token": { column_width: undefined },
  };
  for (const [why, change] of Object.entries(cases)) {
    const [token] = Object.keys(change);
    const property = `--${token.replace(/_/g, "-")}`;
    const kept = styleDeclarations(SCHEMA, { ...STYLE, ...change }).map(([p]) => p);
    assert.ok(!kept.includes(property), why);
    assert.equal(kept.length, 4, why);
  }
});

test("only the tokens its type names, by refs it can resolve", () => {
  const schema = {
    ...SCHEMA,
    properties: {
      ...SCHEMA.properties,
      remote: { $ref: "https://evil.example/s.json" },
      missing: { $ref: "#/$defs/nope" },
      "Bad-Name": { enum: ["a"] },
    },
  };
  const style = { ...STYLE, remote: "1px", missing: "1px", "Bad-Name": "a", extra: "1px" };
  assert.deepEqual(plain(styleDeclarations(schema, style).map(([p]) => p)),
    ["--column-width", "--dock-width", "--font", "--weight", "--density"]);
});

test("a pattern the engine can't read matches nothing", () => {
  const schema = { ...SCHEMA, $defs: { ...SCHEMA.$defs, length: { type: "string", pattern: "(" } } };
  assert.deepEqual(plain(styleDeclarations(schema, STYLE).map(([p]) => p)), ["--font", "--weight", "--density"]);
});

test("a type's properties, to clear them", () => {
  assert.deepEqual(plain(styleProperties(SCHEMA)), ["--column-width", "--dock-width", "--font", "--weight", "--density"]);
});

// The same values tests/db/test_card_styles.py checks the database's contrast_ratio against.
test("contrast ratios are WCAG 2's, as the database computes them", () => {
  const cases = [["#000000", "#ffffff", 21], ["#ffffff", "#000000", 21], ["#777777", "#777777", 1],
    ["#777777", "#ffffff", 4.48], ["#767676", "#ffffff", 4.54]];
  for (const [a, b, ratio] of cases) assert.equal(Math.round(contrastRatio(a, b) * 100) / 100, ratio, `${a} on ${b}`);
});

test("a pair passes only when both colours are opaque and far enough apart", () => {
  const pairs = [{ foreground: "fg", background: "bg", min_ratio: 4.5 }, { foreground: "accent", background: "bg", min_ratio: 3 }];
  const verdicts = (values) => plain(contrastResults(pairs, values)).map(({ ratio, ok }) => [ratio === null ? null : Math.round(ratio * 10) / 10, ok]);
  assert.deepEqual(verdicts({ fg: "#ffffff", bg: "#000000", accent: "#777777" }), [[21, true], [4.7, true]]);
  assert.deepEqual(verdicts({ fg: "#777777", bg: "#ffffff", accent: "#767676" }), [[4.5, false], [4.5, true]]);
  assert.deepEqual(verdicts({ fg: "#ffffff80", bg: "#000000", accent: undefined }), [[null, false], [null, false]]);
});
