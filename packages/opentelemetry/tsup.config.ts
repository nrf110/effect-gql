import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [
    "effect",
    "@effect/platform",
    "@effect/opentelemetry",
    "@effect-gql/core",
    "graphql",
    "@opentelemetry/api",
    "@opentelemetry/sdk-trace-base",
  ],
});
