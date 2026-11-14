/**
 * Generate GraphQL SDL from an effect-gql schema builder.
 *
 * Usage:
 *   effect-gql generate-schema <module-path> [options]
 *
 * The module should export one of:
 *   - `builder` - A GraphQLSchemaBuilder instance
 *   - `schema` - A GraphQLSchema instance
 *   - `default` - Either of the above as default export
 */

import { Effect, Console } from "effect"
import {
  printSchema as defaultPrintSchema,
  lexicographicSortSchema as defaultLexicographicSortSchema,
  type GraphQLSchema,
} from "graphql"
import * as fs from "fs"
import * as path from "path"
import { createRequire } from "module"

// Create a require function for ESM compatibility (needed for cache clearing in watch mode)
const require = createRequire(import.meta.url)

interface GenerateOptions {
  /** Path to the schema module */
  modulePath: string
  /** Output file path (stdout if not specified) */
  output?: string
  /** Sort schema alphabetically */
  sort?: boolean
  /** Watch for changes */
  watch?: boolean
}

export interface GraphQLUtilities {
  printSchema: (schema: GraphQLSchema) => string
  lexicographicSortSchema: (schema: GraphQLSchema) => GraphQLSchema
}

/** Default utilities using the CLI's bundled graphql package */
const defaultUtilities: GraphQLUtilities = {
  printSchema: defaultPrintSchema,
  lexicographicSortSchema: defaultLexicographicSortSchema,
}

/**
 * Load graphql utilities from the same location as @effect-gql/core uses.
 * This resolves the "Cannot use GraphQLScalarType from another module" error that occurs
 * when the CLI's graphql version differs from the user's project.
 *
 * The key insight is that the schema is built using @effect-gql/core, which internally
 * uses graphql. We need to use the same graphql instance that @effect-gql/core uses.
 *
 * IMPORTANT: We use dynamic import() instead of require() because graphql has separate
 * ESM (index.mjs) and CJS (index.js) entry points. If the schema module was loaded via
 * ESM (e.g., by vitest or tsx), we need to import the ESM version to get the same instance.
 *
 * @param modulePath - The absolute path to the schema module being loaded
 */
const loadGraphQLUtilities = (modulePath: string): Effect.Effect<GraphQLUtilities, Error> =>
  Effect.tryPromise({
    try: async () => {
      // Create a require function that resolves from the module's directory
      const moduleRequire = createRequire(modulePath)

      // First, find where @effect-gql/core is located (this is what the schema module uses)
      const corePath = moduleRequire.resolve("@effect-gql/core")

      // Then resolve graphql path from @effect-gql/core's location
      const coreRequire = createRequire(corePath)
      const graphqlPath = coreRequire.resolve("graphql")

      // Use dynamic import to get the ESM version (matches how the schema module loads it)
      const graphql = await import(graphqlPath)

      return {
        printSchema: graphql.printSchema,
        lexicographicSortSchema: graphql.lexicographicSortSchema,
      }
    },
    catch: (error) =>
      new Error(
        `Failed to load graphql from project. Ensure @effect-gql/core and graphql are installed: ${error}`
      ),
  })

/**
 * Load a schema from a module path.
 * Supports both GraphQLSchemaBuilder and GraphQLSchema exports.
 */
export const loadSchema = (modulePath: string): Effect.Effect<GraphQLSchema, Error> =>
  Effect.gen(function* () {
    const absolutePath = path.resolve(process.cwd(), modulePath)

    // Validate file exists
    if (!fs.existsSync(absolutePath)) {
      return yield* Effect.fail(new Error(`File not found: ${absolutePath}`))
    }

    // Dynamic import (works with both ESM and CJS via tsx/ts-node)
    const module = yield* Effect.tryPromise({
      try: async () => {
        // Clear require cache for watch mode
        const resolved = require.resolve(absolutePath)
        delete require.cache[resolved]

        // Try dynamic import first (ESM), fall back to require (CJS)
        try {
          return await import(absolutePath)
        } catch {
          return require(absolutePath)
        }
      },
      catch: (error) => new Error(`Failed to load module: ${error}`),
    })

    // Look for builder or schema export
    const exported = module.builder ?? module.schema ?? module.default

    if (!exported) {
      return yield* Effect.fail(
        new Error(
          `Module must export 'builder' (GraphQLSchemaBuilder), 'schema' (GraphQLSchema), or a default export`
        )
      )
    }

    // If it's a builder, call buildSchema()
    if (typeof exported.buildSchema === "function") {
      return exported.buildSchema() as GraphQLSchema
    }

    // If it's already a GraphQLSchema
    if (exported.getQueryType && exported.getTypeMap) {
      return exported as GraphQLSchema
    }

    return yield* Effect.fail(
      new Error(`Export is not a GraphQLSchemaBuilder or GraphQLSchema. Got: ${typeof exported}`)
    )
  })

/**
 * Generate SDL from a schema.
 *
 * When called from the CLI, pass utilities loaded from the user's project
 * to avoid graphql version mismatch issues. When called directly (e.g., in tests),
 * the bundled graphql utilities are used as defaults.
 */
export const generateSDL = (
  schema: GraphQLSchema,
  options: { sort?: boolean; utilities?: GraphQLUtilities } = {}
): string => {
  const utilities = options.utilities ?? defaultUtilities
  const finalSchema = options.sort !== false ? utilities.lexicographicSortSchema(schema) : schema
  return utilities.printSchema(finalSchema)
}

/**
 * Generate SDL from a module path
 */
export const generateSDLFromModule = (
  modulePath: string,
  options: { sort?: boolean } = {}
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const absolutePath = path.resolve(process.cwd(), modulePath)
    const utilities = yield* loadGraphQLUtilities(absolutePath)
    const schema = yield* loadSchema(modulePath)
    return generateSDL(schema, { ...options, utilities })
  })

/**
 * Run the generate-schema command
 */
const run = (options: GenerateOptions): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const absolutePath = path.resolve(process.cwd(), options.modulePath)
    const utilities = yield* loadGraphQLUtilities(absolutePath)
    const schema = yield* loadSchema(options.modulePath)
    const sdl = generateSDL(schema, { sort: options.sort, utilities })

    if (options.output) {
      const outputPath = path.resolve(process.cwd(), options.output)
      fs.writeFileSync(outputPath, sdl)
      yield* Console.log(`Schema written to ${outputPath}`)
    } else {
      yield* Console.log(sdl)
    }
  })

/**
 * Watch mode - regenerate on file changes
 */
const watch = (options: GenerateOptions): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const absolutePath = path.resolve(process.cwd(), options.modulePath)
    const dir = path.dirname(absolutePath)

    yield* Console.log(`Watching for changes in ${dir}...`)

    // Initial generation
    yield* run(options).pipe(Effect.catch((error) => Console.error(`Error: ${error.message}`)))

    // Watch for changes
    yield* Effect.callback<void, Error>(() => {
      const watcher = fs.watch(dir, { recursive: true }, (_, filename) => {
        if (filename?.endsWith(".ts") || filename?.endsWith(".js")) {
          Effect.runPromise(
            run(options).pipe(
              Effect.tap(() => Console.log(`\nRegenerated at ${new Date().toLocaleTimeString()}`)),
              Effect.catch((error) => Console.error(`Error: ${error.message}`))
            )
          )
        }
      })

      return Effect.sync(() => watcher.close())
    })
  })

/**
 * Parse CLI arguments for generate-schema command
 */
const parseArgs = (args: string[]): GenerateOptions | { help: true } | { error: string } => {
  const positional: string[] = []
  let output: string | undefined
  let sort = true
  let watchMode = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === "-h" || arg === "--help") {
      return { help: true }
    } else if (arg === "-o" || arg === "--output") {
      output = args[++i]
    } else if (arg === "--no-sort") {
      sort = false
    } else if (arg === "-w" || arg === "--watch") {
      watchMode = true
    } else if (!arg.startsWith("-")) {
      positional.push(arg)
    } else {
      return { error: `Unknown option: ${arg}` }
    }
  }

  if (positional.length === 0) {
    return { error: "Missing module path" }
  }

  return {
    modulePath: positional[0],
    output,
    sort,
    watch: watchMode,
  }
}

export const printGenerateSchemaHelp = (): void => {
  console.log(`
Usage: effect-gql generate-schema <module-path> [options]

Generate GraphQL SDL from an effect-gql schema builder.

Arguments:
  module-path    Path to the schema module (.ts or .js)

Options:
  -o, --output   Write SDL to file instead of stdout
  --no-sort      Don't sort schema alphabetically
  -w, --watch    Watch for changes and regenerate
  -h, --help     Show this help message

Examples:
  effect-gql generate-schema ./src/schema.ts
  effect-gql generate-schema ./src/schema.ts -o schema.graphql
  effect-gql generate-schema ./src/schema.ts --watch -o schema.graphql

The module should export one of:
  - builder: A GraphQLSchemaBuilder instance
  - schema: A GraphQLSchema instance
  - default: Either of the above as default export
`)
}

/**
 * Entry point for the generate-schema command
 */
export const runGenerateSchema = (args: string[]): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const parsed = parseArgs(args)

    if ("help" in parsed) {
      printGenerateSchemaHelp()
      return
    }

    if ("error" in parsed) {
      yield* Console.error(`Error: ${parsed.error}`)
      printGenerateSchemaHelp()
      process.exitCode = 1
      return
    }

    if (parsed.watch) {
      yield* watch(parsed)
    } else {
      yield* run(parsed)
    }
  })
