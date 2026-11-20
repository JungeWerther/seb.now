// Runs the compiled styles.js after prelude.js, as the page does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (name) => readFileSync(new URL(`../../src/seb_now/templates/${name}`, import.meta.url), "utf8");
const { styleDeclarations, styleProperties, builtinDeclarations } = vm.runInNewContext(
  `${read("prelude.js")}\n${read("styles.js")}\n;({ styleDeclarations, styleProperties, builtinDeclarations })`,
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

const PALETTE = {
  type: "object",
  additionalProperties: false,
  required: ["color_accent", "color_accent_dark"],
  properties: { color_accent: { $ref: "#/$defs/color" }, color_accent_dark: { $ref: "#/$defs/color" } },
  $defs: { color: { type: "string", pattern: "^#[0-9a-f]{6}([0-9a-f]{2})?$" } },
};
const row = (kind_path, name, style, schema) => ({ kind_path, name, style, kinds: schema ? { schema } : null });

test("built-in styles apply one per type, the first by name, as the build picks them", () => {
  const rows = [
    row("entity.style.palette", "zz palette", { color_accent: "#000000", color_accent_dark: "#000000" }, PALETTE),
    row("entity.style.layout", "seb.now layout", { ...STYLE }, SCHEMA),
    row("entity.style.palette", "seb.now palette", { color_accent: "#75352e", color_accent_dark: "#c1846e" }, PALETTE),
  ];
  assert.deepEqual(plain(builtinDeclarations(rows)), [
    ["--column-width", "640px"],
    ["--dock-width", "30rem"],
    ["--font", '"Inter", sans-serif'],
    ["--weight", "1.5"],
    ["--density", "roomy"],
    ["--color-accent", "#75352e"],
    ["--color-accent-dark", "#c1846e"],
  ]);
});

test("a built-in style without a schema, or with values its type refuses, sets nothing", () => {
  assert.deepEqual(plain(builtinDeclarations([row("entity.style.palette", "a", { color_accent: "#000000" }, null)])), []);
  assert.deepEqual(
    plain(builtinDeclarations([row("entity.style.palette", "a", { color_accent: "url(x)", color_accent_dark: "red" }, PALETTE)])),
    [],
  );
});
