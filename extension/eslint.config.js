import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", "artifacts/"] },
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Page text only ever goes in through textContent.
      "no-restricted-properties": ["error",
        { property: "innerHTML" }, { property: "outerHTML" }, { property: "insertAdjacentHTML" },
        { object: "document", property: "write" }],
    },
  },
  {
    files: ["test/**/*.mjs", "scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      globals: { URL: "readonly", document: "readonly", window: "readonly", setTimeout: "readonly", process: "readonly", console: "readonly", fetch: "readonly", Response: "readonly", AbortSignal: "readonly" },
    },
  },
);
