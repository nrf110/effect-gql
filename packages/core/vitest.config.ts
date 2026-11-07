import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    server: {
      // Keep graphql-ws and builder schemas on the same GraphQL module instance.
      deps: { inline: ["graphql-ws"] },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts", // Re-exports only
        "src/builder/index.ts", // Re-exports only
        "src/builder/types.ts", // Type definitions only
      ],
      thresholds: {
        global: {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
})
