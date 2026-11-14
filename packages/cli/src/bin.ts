#!/usr/bin/env node
/**
 * Effect GraphQL CLI
 *
 * Usage:
 *   effect-gql <command> [options]
 *
 * Commands:
 *   generate-schema  Generate GraphQL SDL from a schema module
 *   create           Create a new Effect GraphQL project (coming soon)
 */

import { Effect, Console } from "effect"
import { runGenerateSchema } from "./commands/generate-schema"
import { runCreate } from "./commands/create"
import { spawnSync } from "child_process"
import { createRequire } from "module"

const require = createRequire(import.meta.url)

const VERSION = "0.1.0"

/**
 * Check if tsx loader is already registered by looking at process flags.
 * When running with `node --import tsx`, the loader is active.
 */
const isTsxLoaderActive = (): boolean => {
  // Check if we're running under tsx or have tsx imported
  const execArgv = process.execArgv.join(" ")
  return execArgv.includes("tsx") || execArgv.includes("ts-node")
}

/**
 * For generate-schema with TypeScript files, re-execute with tsx loader.
 * Returns true if we re-executed, false if we should continue normally.
 */
const maybeReexecWithTsx = (): boolean => {
  const args = process.argv.slice(2)

  // Only applies to generate-schema command with a TypeScript file
  if (args[0] !== "generate-schema") {
    return false
  }

  // Find the module path (first positional argument after command)
  const modulePath = args.slice(1).find((arg) => !arg.startsWith("-"))
  if (!modulePath || !modulePath.endsWith(".ts")) {
    return false
  }

  // If tsx is already active, continue normally
  if (isTsxLoaderActive()) {
    return false
  }

  // Re-execute with tsx loader
  try {
    // Resolve the full path to tsx from this CLI's node_modules
    // This is necessary because --import resolves relative to cwd, not the CLI location
    const tsxPath = require.resolve("tsx")

    // Use tsx to run the CLI again with the same arguments
    const result = spawnSync(process.execPath, ["--import", tsxPath, ...process.argv.slice(1)], {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    })

    process.exitCode = result.status ?? 1
    return true
  } catch (_) {
    // tsx not available, fall through to try direct import
    // This may fail for multi-file TypeScript schemas
    return false
  }
}

const printHelp = (): void => {
  console.log(`
Effect GraphQL CLI v${VERSION}

Usage: effect-gql <command> [options]

Commands:
  generate-schema    Generate GraphQL SDL from a schema module
  create             Create a new Effect GraphQL project

Options:
  -h, --help         Show this help message
  -v, --version      Show version number

Examples:
  effect-gql generate-schema ./src/schema.ts
  effect-gql generate-schema ./src/schema.ts -o schema.graphql
  effect-gql create my-app --server-type node

Run 'effect-gql <command> --help' for command-specific help.
`)
}

const printVersion = (): void => {
  console.log(`effect-gql v${VERSION}`)
}

// Check if we need to re-execute with tsx for TypeScript files
if (maybeReexecWithTsx()) {
  // We re-executed, exit this process
  process.exit(process.exitCode ?? 0)
}

const main = Effect.gen(function* () {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printHelp()
    return
  }

  if (args[0] === "-v" || args[0] === "--version") {
    printVersion()
    return
  }

  const command = args[0]
  const commandArgs = args.slice(1)

  switch (command) {
    case "generate-schema":
      yield* runGenerateSchema(commandArgs)
      break

    case "create":
      yield* runCreate(commandArgs)
      break

    default:
      yield* Console.error(`Unknown command: ${command}`)
      printHelp()
      process.exitCode = 1
  }
})

Effect.runPromise(
  main.pipe(
    Effect.catch((error) =>
      Console.error(`Error: ${error.message}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1
          })
        )
      )
    )
  )
)
