// Builds dist/, the unpacked extension: src/ bundled by esbuild, static/
// copied. `--e2e` adds host access to every site so the end-to-end test can
// read its fixture page without a click on the toolbar button (activeTab).
import { build } from "esbuild";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = `${root}dist`;
const e2e = process.argv.includes("--e2e");

await rm(dist, { recursive: true, force: true });
await cp(`${root}static`, dist, { recursive: true });
await build({
  entryPoints: [`${root}src/popup.ts`, `${root}src/options.ts`],
  outdir: dist,
  bundle: true,
  format: "iife",
  target: ["chrome120", "firefox128"],
  charset: "utf8",
  legalComments: "none",
  logLevel: "warning",
});

if (e2e) {
  const manifest = JSON.parse(await readFile(`${dist}/manifest.json`, "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  await writeFile(`${dist}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}
