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
    "@effect/platform-node",
    "@effect-gql/core",
    "graphql",
    "graphql-ws",
    "ws",
  ],
});
