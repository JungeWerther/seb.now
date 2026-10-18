import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/"] },
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Declarations here are consumed by index.html's script, not by this file.
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",
      // The page's own XSS rules (see tests/test_site.py) hold here too.
      "no-restricted-properties": ["error",
        { property: "innerHTML" }, { property: "outerHTML" }, { property: "insertAdjacentHTML" },
        { object: "document", property: "write" }],
    },
  },
  {
    files: ["test/**/*.mjs", "eslint.config.js"],
    languageOptions: { globals: { URL: "readonly", setTimeout: "readonly", process: "readonly" } },
  },
);
