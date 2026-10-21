// The page's module script, with the compiled scripts site.py inlines into it,
// declares each top-level name once: a second `const` of the same name is a
// SyntaxError that stops the whole page, which a parse alone doesn't catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const TEMPLATES = new URL("../../src/seb_now/templates/", import.meta.url);
const INLINED = /__([A-Z]+)_JS__/g;

function pageScript() {
  const html = readFileSync(new URL("index.html", TEMPLATES), "utf8");
  const [, script] = html.match(/<script type="module">([\s\S]*?)<\/script>/) ?? [];
  assert.ok(script, "index.html has no module script");
  return script.replace(INLINED, (_, name) => readFileSync(new URL(`${name.toLowerCase()}.js`, TEMPLATES), "utf8"));
}

function topLevelNames(tree) {
  return tree.statements.flatMap((statement) => {
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((d) =>
        ts.isIdentifier(d.name) ? [d.name.text] : []);
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      return [statement.name.text];
    }
    return [];
  });
}

test("every top-level name in the page script is declared once", () => {
  const tree = ts.createSourceFile("page.js", pageScript(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = topLevelNames(tree);
  const repeated = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
  assert.deepEqual(repeated, []);
});
