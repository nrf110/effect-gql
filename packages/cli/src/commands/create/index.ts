/**
 * Create command - scaffold a new Effect GraphQL project
 *
 * Usage:
 *   effect-gql create <name> --server-type <type> [options]
 *   effect-gql create --interactive
 *
 * Server types:
 *   node     - Node.js server using @effect-gql/node
 *   bun      - Bun server using @effect-gql/bun
 *   express  - Express middleware using @effect-gql/express
 *   web      - Web standard handler using @effect-gql/web
 */

import { Effect, Console, Option } from "effect"
import * as readline from "readline"
import type { CreateOptions, ServerType, PackageManager } from "./types"
import { parseArgs } from "./args"
import { scaffold } from "./scaffolder"

/**
 * Print help for the create command
 */
export const printCreateHelp = (): void => {
  console.log(`
Usage: effect-gql create <name> --server-type <type> [options]

Create a new Effect GraphQL project.

Arguments:
  name                 Package/project name

Required Options:
  -s, --server-type    Server type: node, bun, express, web

Optional Options:
  -d, --directory      Target directory (default: ./<name>)
  --monorepo           Create as workspace package (auto-detected)
  --skip-install       Skip dependency installation
  --package-manager    Package manager: npm, pnpm, yarn, bun
  -i, --interactive    Interactive mode (prompts for options)
  -h, --help           Show this help message

Server Types:
  node      Node.js server using @effect-gql/node
            Best for: General Node.js deployments

  bun       Bun server using @effect-gql/bun
            Best for: Bun runtime with native WebSocket support

  express   Express middleware using @effect-gql/express
            Best for: Integrating into existing Express apps

  web       Web standard handler using @effect-gql/web
            Best for: Cloudflare Workers, Deno, edge runtimes

Examples:
  effect-gql create my-api --server-type node
  effect-gql create my-api -s bun
  effect-gql create my-api -s express -d ./packages/api --monorepo
  effect-gql create my-api -s web --skip-install
  effect-gql create --interactive
`)
}

/**
 * Simple prompt helper using readline
 */
const prompt = (question: string): Effect.Effect<string, Error> =>
  Effect.callback<string, Error>((resume) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    rl.question(question, (answer) => {
      rl.close()
      resume(Effect.succeed(answer.trim()))
    })

    rl.on("error", (error) => {
      rl.close()
      resume(Effect.fail(new Error(`Input error: ${error.message}`)))
    })

    return Effect.sync(() => rl.close())
  })

/**
 * Select from a list of options
 */
const selectPrompt = <T extends string>(
  question: string,
  options: readonly { label: string; value: T }[]
): Effect.Effect<T, Error> =>
  Effect.gen(function* () {
    yield* Console.log(question)
    options.forEach((opt, i) => {
      console.log(`  ${i + 1}) ${opt.label}`)
    })

    const answer = yield* prompt("Enter number: ")
    const index = parseInt(answer, 10) - 1

    if (isNaN(index) || index < 0 || index >= options.length) {
      yield* Console.log(`Invalid selection. Please enter 1-${options.length}.`)
      return yield* selectPrompt(question, options)
    }

    return options[index].value
  })

/**
 * Yes/no confirmation prompt
 */
const confirmPrompt = (question: string, defaultValue: boolean): Effect.Effect<boolean, Error> =>
  Effect.gen(function* () {
    const hint = defaultValue ? "[Y/n]" : "[y/N]"
    const answer = yield* prompt(`${question} ${hint} `)

    if (answer === "") return defaultValue
    const lower = answer.toLowerCase()
    if (lower === "y" || lower === "yes") return true
    if (lower === "n" || lower === "no") return false

    yield* Console.log("Please answer 'y' or 'n'.")
    return yield* confirmPrompt(question, defaultValue)
  })

/**
 * Run interactive mode to gather options
 */
const runInteractive = (): Effect.Effect<CreateOptions, Error> =>
  Effect.gen(function* () {
    yield* Console.log("")
    yield* Console.log("Create a new Effect GraphQL project")
    yield* Console.log("====================================")
    yield* Console.log("")

    // Get project name
    const name = yield* prompt("Project name: ")
    if (!name) {
      return yield* Effect.fail(new Error("Project name is required"))
    }

    // Validate name (basic npm package name validation)
    if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) {
      yield* Console.log("Warning: Name may not be a valid npm package name.")
    }

    // Get server type
    const serverType = yield* selectPrompt<ServerType>("Select server type:", [
      { label: "Node.js (@effect-gql/node)", value: "node" },
      { label: "Bun (@effect-gql/bun)", value: "bun" },
      { label: "Express (@effect-gql/express)", value: "express" },
      { label: "Web/Workers (@effect-gql/web)", value: "web" },
    ])

    // Ask about monorepo
    const monorepo = yield* confirmPrompt("Create as monorepo workspace package?", false)

    // Ask about package manager if monorepo
    const packageManager: Option.Option<PackageManager> = monorepo
      ? Option.some(
          yield* selectPrompt<PackageManager>("Select package manager:", [
            { label: "pnpm", value: "pnpm" },
            { label: "npm", value: "npm" },
            { label: "yarn", value: "yarn" },
            { label: "bun", value: "bun" },
          ])
        )
      : Option.none()

    return {
      name,
      serverType,
      directory: Option.none(),
      monorepo: Option.some(monorepo),
      skipInstall: false,
      packageManager,
    }
  })

/**
 * Entry point for the create command
 */
export const runCreate = (args: string[]): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const parsed = parseArgs(args)

    if ("help" in parsed) {
      printCreateHelp()
      return
    }

    if ("error" in parsed) {
      yield* Console.error(`Error: ${parsed.error}`)
      yield* Console.log("")
      printCreateHelp()
      process.exitCode = 1
      return
    }

    // Get options either from args or interactive mode
    const options: CreateOptions =
      "interactive" in parsed ? yield* runInteractive() : parsed.options

    // Run scaffolding
    yield* scaffold(options)
  })

// Re-export types for programmatic use
export type { CreateOptions, ServerType, PackageManager } from "./types"
export { SERVER_TYPES, isValidServerType } from "./types"
export { scaffold } from "./scaffolder"
