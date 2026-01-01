// @ts-check

import eslint from "@eslint/js"
import { defineConfig } from "eslint/config"
import tseslint from "typescript-eslint"
import eslintConfigPrettier from "eslint-config-prettier"

export default defineConfig(
  // Global ignores
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/*.d.ts", "docs/.astro/**"],
  },

  // Base config for all files
  eslint.configs.recommended,

  // TypeScript configs
  ...tseslint.configs.recommended,

  // Source files - type-checked rules
  {
    files: ["packages/*/src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript-specific rules
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Turn off - too noisy for GraphQL library with dynamic types
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",

      // Allow empty functions (common in Effect patterns)
      "@typescript-eslint/no-empty-function": "off",

      // Allow `this` aliasing (used in class methods)
      "@typescript-eslint/no-this-alias": "off",

      // General rules
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      // Allow `arguments` in some cases (e.g., pipe implementations)
      "prefer-rest-params": "off",
    },
  },

  // Test files - no type checking, relaxed rules
  {
    files: ["packages/*/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-console": "off",
      // Allow generator functions without yield in tests (for mock async iterables)
      "require-yield": "off",
    },
  },

  // CLI package - allow console
  {
    files: ["packages/cli/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // Examples - relaxed rules for reference code
  {
    files: ["examples/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-console": "off",
    },
  },

  // Docs - minimal rules for documentation site
  {
    files: ["docs/**/*.{ts,tsx,js,jsx,mjs,cjs,astro}"],
    rules: {
      // Turn off most TypeScript rules - docs code may be incomplete snippets
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/ban-ts-comment": "off",

      // Allow console in docs
      "no-console": "off",

      // Keep basic code quality rules
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },

  // Disable rules that conflict with Prettier
  eslintConfigPrettier
)
