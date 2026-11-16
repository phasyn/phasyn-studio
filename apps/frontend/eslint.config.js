import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Features use each other only through their public entry `@/features/<name>` (index.ts). */
const FEATURE_INTERNALS = {
  group: ["@/features/*/**"],
  message: "Import another feature through its public entry @/features/<name> (its index.ts), not its internal files.",
};
/** Tests may also use another feature's test entry `@/features/<name>/testing` (its fixtures and stubs). */
const FEATURE_INTERNALS_IN_TESTS = {
  group: ["@/features/*/**", "!@/features/*/testing"],
  message: "Import another feature through @/features/<name> (production entry) or, from a test, @/features/<name>/testing (test entry), not its internal files.",
};
/** Shared layers sit below the features and never import them. */
const ANY_FEATURE = {
  group: ["@/features/*", "@/features/*/**"],
  message: "src/{components,compute,lib,api,i18n,test} are shared layers below the features and must not import them.",
};

export default defineConfig([
  globalIgnores(["dist", "src/api/generated", "src/compute/generated"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        project: ["./tsconfig.app.json", "./tsconfig.test.json", "./tsconfig.node.json", "./tsconfig.worker.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "伺服器資料一律以文字呈現，不得注入 HTML。",
        },
      ],
    },
  },
  {
    // Feature boundaries (errors). Relative imports that cross into another feature are caught by
    // scripts/check-boundaries.mjs in the same lint command, which also keeps the feature graph acyclic.
    // app/lazyPages.tsx imports page modules directly so each page stays in its own lazy chunk.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/app/lazyPages.tsx"],
    rules: { "no-restricted-imports": ["error", { patterns: [FEATURE_INTERNALS] }] },
  },
  {
    files: ["src/**/*.test.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [FEATURE_INTERNALS_IN_TESTS] }] },
  },
  {
    // Last, so tests inside the shared layers keep this stricter rule.
    files: ["src/{components,compute,lib,api,i18n,test}/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [ANY_FEATURE] }] },
  },
  {
    // Tests and test infrastructure run under Vitest (Node or jsdom) and are never hot-reloaded.
    files: ["**/*.test.{ts,tsx}", "src/test/**"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: globals.node },
  },
]);
