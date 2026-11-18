// ESLint for the HANNAH app: rules that catch real bugs, not style. TypeScript
// (`tsc -b`) already checks types and undefined names, so those rules are off here.
// Errors fail `npm run lint` and CI; warnings are shown for cleanup.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "android/**", "ios/**", "electron/**", "node_modules/**", "public/**", "playwright-report/**", "test-results/**", "plugins/desktop-tools/electron/dist/**", "**/*.d.ts"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Hooks called conditionally break React's state; missing dependencies give stale values.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // TypeScript covers these.
      "no-undef": "off",
      "no-redeclare": "off",
      // Bugs, not style.
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-self-assign": "error",
      "no-self-compare": "error",
      "no-constant-binary-expression": "error",
      "no-unsafe-finally": "error",
      "no-async-promise-executor": "error",
      "no-promise-executor-return": "off",
      "eqeqeq": ["error", "smart"],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["src/__tests__/**/*.{ts,tsx}"],
    // Test helpers named "use" are not React hooks.
    rules: { "@typescript-eslint/no-unused-vars": "off", "react-hooks/rules-of-hooks": "off" },
  },
);
