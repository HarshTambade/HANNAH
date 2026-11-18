// ESLint for HANNAH's server: rules that catch real bugs in plain JavaScript
// (there's no type checker here), not style. Errors fail `npm run lint` and CI.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/**", "logs/**", "coverage/**"] },
  {
    files: ["**/*.js", "**/*.cjs"],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: 2023, sourceType: "commonjs", globals: { ...globals.node } },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-self-compare": "error",
      "no-constant-binary-expression": "error",
      "no-unsafe-finally": "error",
      "eqeqeq": ["error", "smart"],
      // Input cleaning strips control characters on purpose.
      "no-control-regex": "off",
    },
  },
  {
    files: ["**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
    rules: { ...js.configs.recommended.rules, "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }] },
  },
];
