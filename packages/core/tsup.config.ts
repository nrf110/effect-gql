import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "builder/index": "src/builder/index.ts",
    "server/index": "src/server/index.ts",
  },
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: [
    "effect",
    "@effect/platform",
    "graphql",
    "graphql-ws",
  ],
});
