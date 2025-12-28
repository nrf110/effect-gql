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

const VERSION = "0.1.0"

const printHelp = (): void => {
  console.log(`
Effect GraphQL CLI v${VERSION}

Usage: effect-gql <command> [options]

Commands:
  generate-schema    Generate GraphQL SDL from a schema module
  create             Create a new Effect GraphQL project (coming soon)

Options:
  -h, --help         Show this help message
  -v, --version      Show version number

Examples:
  effect-gql generate-schema ./src/schema.ts
  effect-gql generate-schema ./src/schema.ts -o schema.graphql
  effect-gql create my-app

Run 'effect-gql <command> --help' for command-specific help.
`)
}

const printVersion = (): void => {
  console.log(`effect-gql v${VERSION}`)
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
      yield* Console.log("The 'create' command is coming soon!")
      yield* Console.log("It will help you scaffold new Effect GraphQL projects.")
      break

    default:
      yield* Console.error(`Unknown command: ${command}`)
      printHelp()
      process.exitCode = 1
  }
})

Effect.runPromise(
  main.pipe(
    Effect.catchAll((error) =>
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
