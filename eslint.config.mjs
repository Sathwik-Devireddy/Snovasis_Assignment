// Root flat ESLint config — strict TypeScript hygiene for the monorepo
// (PHASE-04 P4.1). Global ignores exclude generated/vendored output from ALL
// rules; per-scope rule overrides follow.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    name: "global-ignores",
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/src/generated/**",
      "**/.next/**",
      "**/coverage/**",
      "ledgerline-repo-kit/**",
      "apps/web/next-env.d.ts",
      "apps/web/.next/types/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    name: "app-source-rules",
    files: ["apps/**/*.{ts,tsx,mjs}"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "warn",
      "no-console": ["error", { allow: ["error", "warn", "info"] }],
    },
  },
  {
    name: "scripts-and-migrations",
    files: ["db/migrations/**/*.js", "apps/api/scripts/**/*.mjs"],
    rules: {
      // Plain-JS migrations / runner scripts: console output is their interface.
      "no-console": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
