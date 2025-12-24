import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      // Use compiled dist to avoid Effect module identity issues
      "@effect-gql/core": path.resolve(__dirname, "../core/dist/index.js"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.integration.ts"],
    exclude: ["node_modules", "dist"],
    passWithNoTests: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
