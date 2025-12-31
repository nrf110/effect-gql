import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      // Use source files for proper module resolution during tests
      "@effect-gql/core/server": path.resolve(__dirname, "../core/src/server/index.ts"),
      "@effect-gql/core": path.resolve(__dirname, "../core/src/index.ts"),
    },
    // Ensure proper deduplication of graphql modules
    dedupe: ["graphql", "graphql-ws"],
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.integration.ts"],
    exclude: ["node_modules", "dist"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        global: {
          statements: 70,
          branches: 70,
          functions: 70,
          lines: 70,
        },
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    // Force single instance of graphql across all imports
    server: {
      deps: {
        inline: ["graphql", "graphql-ws"],
      },
    },
  },
})
