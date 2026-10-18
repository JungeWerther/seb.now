// Code conventions, checked on the sources' syntax trees (typescript's parser,
// which reads the page script as JavaScript too):
// - No string literal in a function body. Strings are data or names: they go
//   in module-level constants and Mappings, which functions read. The page
//   script's existing ones are a baseline (page-strings.json) that may only
//   shrink; TypeScript sources have none but ALLOWED's.
// - A Mapping or Cases table is named for what it maps: `<value>By<Key>`,
//   Key being the table's key type (`spellingBySenseField: Cases<SenseField,
//   …>`), so a lookup reads as what it returns for what it's given.
// - No if-chain on fields (`if ("kind" in sense) … if ("topic" in sense)`):
//   that's a Cases table and `match`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import ts from "typescript";

const SRC = new URL("../src/", import.meta.url);
const PAGE = new URL("../../src/seb_now/templates/index.html", import.meta.url);
const BASELINE = new URL("./page-strings.json", import.meta.url);

// String literals a TypeScript function may hold, "<file> <function> <text>"
// to a one-line reason. Stale entries fail.
const ALLOWED = {};

const TABLE_TYPES = new Set(["Mapping", "Cases"]);

const sources = readdirSync(SRC).filter((f) => f.endsWith(".ts")).sort().map((file) => ({
  file,
  tree: ts.createSourceFile(file, readFileSync(new URL(file, SRC), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
}));

function pageTree() {
  const html = readFileSync(PAGE, "utf8");
  const [, script] = html.match(/<script type="module">([\s\S]*?)<\/script>/) ?? [];
  assert.ok(script, "index.html has no module script");
  const tree = ts.createSourceFile("index.html", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.deepEqual(tree.parseDiagnostics?.map((d) => d.messageText) ?? [], [], "the page script must parse");
  return tree;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

// A function's own name, else the name it's bound to, directly or as the
// argument of a wrapper (`const load = memoize(key, async () => …)`).
function nameOf(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = ts.isCallExpression(fn.parent) ? fn.parent.parent : fn.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
    && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}

// The named functions around `node`, outermost first ("memoize"), or null
// at module level. An anonymous function is named by the ones around it.
function scopeOf(node) {
  const names = [];
  let inFunction = false;
  for (let n = node.parent; n; n = n.parent) {
    if (!ts.isFunctionLike(n)) continue;
    inFunction = true;
    const name = nameOf(n);
    if (name) names.unshift(name);
  }
  if (!inFunction) return null;
  return names.length ? names.join(".") : "(anonymous)";
}

// Strings that are syntax, not data: a field named for `in`, a typeof
// comparison, a type, an object key.
function exempt(node) {
  const { parent } = node;
  if (ts.isBinaryExpression(parent)) {
    if (parent.operatorToken.kind === ts.SyntaxKind.InKeyword && parent.left === node) return true;
    const other = parent.left === node ? parent.right : parent.left;
    if (ts.isTypeOfExpression(other)) return true;
  }
  if (ts.isLiteralTypeNode(parent)) return true;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) return true;
  return false;
}

function textOf(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join("${}");
  return null;
}

// Every string literal in a function body, as "<function> <text>".
function functionStrings(tree) {
  const found = new Set();
  walk(tree, (node) => {
    const text = textOf(node);
    if (!text || exempt(node)) return;
    const scope = scopeOf(node);
    if (scope) found.add(`${scope} ${JSON.stringify(text)}`);
  });
  return found;
}

test("TypeScript functions hold no string literals", () => {
  const found = new Set(sources.flatMap(({ file, tree }) => [...functionStrings(tree)].map((s) => `${file} ${s}`)));
  const allowed = new Set(Object.keys(ALLOWED));
  assert.deepEqual([...found].filter((s) => !allowed.has(s)), [], "move these to a module-level constant or Mapping");
  assert.deepEqual([...allowed].filter((s) => !found.has(s)), [], "stale ALLOWED entries");
});

test("the page script's function strings only shrink", () => {
  const found = functionStrings(pageTree());
  const baseline = new Set(JSON.parse(readFileSync(BASELINE, "utf8")));
  const stale = [...baseline].filter((s) => !found.has(s));
  if (process.env.PRUNE_PAGE_STRINGS && stale.length) {
    writeFileSync(BASELINE, `${JSON.stringify([...baseline].filter((s) => found.has(s)), null, 1)}\n`);
  } else {
    assert.deepEqual(stale, [], "stale page-strings.json entries (PRUNE_PAGE_STRINGS=1 npm test drops them)");
  }
  assert.deepEqual([...found].filter((s) => !baseline.has(s)), [], "new strings in page functions: name them at module level");
});

function typeName(type) {
  return type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) ? type.typeName.text : null;
}

test("Mapping and Cases tables are named <value>By<Key>", () => {
  const misnamed = [];
  for (const { file, tree } of sources) {
    walk(tree, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
      const table = typeName(node.type);
      if (table === "Record") misnamed.push(`${file} ${node.name.text}: a Record table is a Mapping`);
      if (!TABLE_TYPES.has(table)) return;
      const key = typeName(node.type.typeArguments?.[0]);
      if (!key) misnamed.push(`${file} ${node.name.text}: name the key type of a ${table}`);
      else if (!new RegExp(`^[a-z][A-Za-z0-9]*By${key}$`).test(node.name.text)) {
        misnamed.push(`${file} ${node.name.text}: a ${table}<${key}, …> is named <value>By${key}`);
      }
    });
  }
  assert.deepEqual(misnamed, []);
});

// The `if (… in …)` checks in `fn`'s own body: a nested function is checked
// on its own.
function fieldIfsIn(fn) {
  let count = 0;
  const visit = (node) => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression)
      && node.expression.operatorToken.kind === ts.SyntaxKind.InKeyword) count++;
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return count;
}

test("an if on a field counts for its own function only", () => {
  const tree = ts.createSourceFile("t.ts", `function outer(xs: object[]) {
    xs.map((x) => { if ("a" in x) return 1; return 0; });
    xs.map((x) => { if ("b" in x) return 1; return 0; });
  }
  function chain(x: object) { if ("a" in x) return 1; if ("b" in x) return 2; return 0; }`, ts.ScriptTarget.Latest, true);
  const counts = {};
  walk(tree, (node) => { if (ts.isFunctionLike(node)) counts[nameOf(node) ?? "(anonymous)"] = fieldIfsIn(node); });
  assert.equal(counts.outer, 0);
  assert.equal(counts.chain, 2);
});

test("no if-chains on fields", () => {
  const chains = [];
  for (const { file, tree } of sources) {
    walk(tree, (node) => {
      if (!ts.isFunctionLike(node)) return;
      const fieldIfs = fieldIfsIn(node);
      if (fieldIfs > 1) chains.push(`${file} ${nameOf(node) ?? "(anonymous)"}: use Cases and match`);
    });
  }
  assert.deepEqual(chains, []);
});
