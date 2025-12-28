import eslint from "@eslint/js"
import tseslint from "typescript-eslint"
import eslintConfigPrettier from "eslint-config-prettier"

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "docs/**",
      "examples/**",
      "**/coverage/**",
      "**/*.d.ts",
    ],
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

  // Disable rules that conflict with Prettier
  eslintConfigPrettier
)
