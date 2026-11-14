/**
 * Package.json template generation
 */

import type { ServerType, TemplateContext } from "../types"

/**
 * Current dependency versions
 * Keep in sync with the main packages
 */
const VERSIONS = {
  core: "^2.0.0",
  node: "^2.0.0",
  bun: "^2.0.0",
  express: "^2.0.0",
  web: "^2.0.0",
  effect: "^4.1.1",
  platformNode: "^4.1.1",
  platformBun: "^4.1.1",
  graphql: "^16.0.0",
  expressLib: "^5.0.0",
  tsx: "^4.19.0",
  typescript: "^5.0.0",
} as const

interface Dependencies {
  readonly dependencies: Record<string, string>
  readonly devDependencies: Record<string, string>
}

/**
 * Get dependencies for each server type
 */
const getDependencies = (serverType: ServerType, _isMonorepo: boolean): Dependencies => {
  // Always use published versions - workspace:* is only for effect-gql internal development
  const baseDeps: Record<string, string> = {
    "@effect-gql/core": VERSIONS.core,
    effect: VERSIONS.effect,
    graphql: VERSIONS.graphql,
  }

  const baseDevDeps: Record<string, string> = {
    tsx: VERSIONS.tsx,
    typescript: VERSIONS.typescript,
  }

  switch (serverType) {
    case "node":
      return {
        dependencies: {
          ...baseDeps,
          "@effect-gql/node": VERSIONS.node,
          "@effect/platform-node": VERSIONS.platformNode,
        },
        devDependencies: baseDevDeps,
      }

    case "bun":
      return {
        dependencies: {
          ...baseDeps,
          "@effect-gql/bun": VERSIONS.bun,
          "@effect/platform-bun": VERSIONS.platformBun,
        },
        devDependencies: {
          typescript: VERSIONS.typescript,
          // Bun has built-in TypeScript support, no tsx needed
        },
      }

    case "express":
      return {
        dependencies: {
          ...baseDeps,
          "@effect-gql/express": VERSIONS.express,
          express: VERSIONS.expressLib,
        },
        devDependencies: {
          ...baseDevDeps,
          "@types/express": "^5.0.0",
        },
      }

    case "web":
      return {
        dependencies: {
          ...baseDeps,
          "@effect-gql/web": VERSIONS.web,
        },
        devDependencies: baseDevDeps,
      }
  }
}

/**
 * Get scripts for each server type
 */
const getScripts = (serverType: ServerType): Record<string, string> => {
  switch (serverType) {
    case "node":
      return {
        start: "tsx src/index.ts",
        dev: "tsx watch src/index.ts",
        build: "tsc",
        typecheck: "tsc --noEmit",
      }

    case "bun":
      return {
        start: "bun run src/index.ts",
        dev: "bun --watch src/index.ts",
        build: "bun build src/index.ts --outdir dist --target bun",
        typecheck: "tsc --noEmit",
      }

    case "express":
      return {
        start: "tsx src/index.ts",
        dev: "tsx watch src/index.ts",
        build: "tsc",
        typecheck: "tsc --noEmit",
      }

    case "web":
      return {
        start: "tsx src/index.ts",
        dev: "tsx watch src/index.ts",
        build: "tsc",
        typecheck: "tsc --noEmit",
        // Users will typically add wrangler/deno commands as needed
      }
  }
}

/**
 * Generate package.json content
 */
export const generatePackageJson = (ctx: TemplateContext): string => {
  const deps = getDependencies(ctx.serverType, ctx.isMonorepo)

  const pkg = {
    name: ctx.name,
    version: "0.0.1",
    private: true,
    type: "module",
    engines: ctx.serverType === "bun" ? { bun: ">=1.4.2" } : { node: ">=22.19.0" },
    scripts: getScripts(ctx.serverType),
    dependencies: deps.dependencies,
    devDependencies: deps.devDependencies,
  }

  return JSON.stringify(pkg, null, 2) + "\n"
}
