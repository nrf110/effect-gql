/**
 * Project scaffolding logic
 */

import { Effect, Console, Option, pipe } from "effect"
import * as fs from "fs"
import * as path from "path"
import { spawn } from "child_process"
import type { CreateOptions, TemplateContext, PackageManager } from "./types"
import { generateProject } from "./templates"
import { detectMonorepo, detectPackageManager, getInstallCommand, getRunPrefix } from "./monorepo"

/**
 * Check if a directory exists and is empty (or doesn't exist)
 */
const validateDirectory = (targetDir: string): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      if (fs.existsSync(targetDir)) {
        const files = fs.readdirSync(targetDir)
        if (files.length > 0) {
          throw new Error(`Directory ${targetDir} is not empty`)
        }
      }
    },
    catch: (error) =>
      error instanceof Error ? error : new Error(`Failed to validate directory: ${error}`),
  })

/**
 * Create a directory and all parent directories
 */
const mkdirp = (dir: string): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => fs.mkdirSync(dir, { recursive: true }),
    catch: (error) => new Error(`Failed to create directory ${dir}: ${error}`),
  })

/**
 * Write a file, creating parent directories as needed
 */
const writeFile = (filePath: string, content: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* mkdirp(path.dirname(filePath))
    yield* Effect.try({
      try: () => fs.writeFileSync(filePath, content, "utf-8"),
      catch: (error) => new Error(`Failed to write ${filePath}: ${error}`),
    })
  })

/**
 * Run a shell command
 */
const runCommand = (command: string, args: string[], cwd: string): Effect.Effect<void, Error> =>
  Effect.callback<void, Error>((resume) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: true,
    })

    child.on("close", (code) => {
      if (code === 0) {
        resume(Effect.succeed(undefined))
      } else {
        resume(Effect.fail(new Error(`Command failed with exit code ${code}`)))
      }
    })

    child.on("error", (error) => {
      resume(Effect.fail(new Error(`Failed to run command: ${error.message}`)))
    })

    return Effect.sync(() => {
      child.kill()
    })
  })

/**
 * Install dependencies using the detected package manager
 */
const installDependencies = (
  targetDir: string,
  packageManager: PackageManager
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* Console.log("")
    yield* Console.log("Installing dependencies...")

    const installCmd = getInstallCommand(packageManager)
    const [cmd, ...args] = installCmd.split(" ")

    yield* runCommand(cmd, args, targetDir)

    yield* Console.log("Dependencies installed successfully!")
  })

/**
 * Print success message with next steps
 */
const printSuccessMessage = (ctx: TemplateContext, targetDir: string): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const relativePath = path.relative(process.cwd(), targetDir) || "."
    const runPrefix = getRunPrefix(ctx.packageManager)

    yield* Console.log("")
    yield* Console.log(`Successfully created ${ctx.name}!`)
    yield* Console.log("")
    yield* Console.log("Next steps:")
    yield* Console.log(`  cd ${relativePath}`)
    yield* Console.log(`  ${runPrefix} dev`)
    yield* Console.log("")
    yield* Console.log("Your GraphQL server will be available at:")
    yield* Console.log("  http://localhost:4000/graphql")
    yield* Console.log("  http://localhost:4000/graphiql (playground)")
    yield* Console.log("")
  })

/**
 * Main scaffolding function
 */
export const scaffold = (options: CreateOptions): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const targetDir = pipe(
      options.directory,
      Option.map((dir) => path.resolve(process.cwd(), dir)),
      Option.getOrElse(() => path.resolve(process.cwd(), options.name))
    )

    // Detect monorepo context
    const monorepoInfo = yield* detectMonorepo(targetDir)

    // Determine if we're in monorepo mode
    // Use explicit option if provided, otherwise use detected value
    const isMonorepo = pipe(
      options.monorepo,
      Option.getOrElse(() => monorepoInfo.isMonorepo)
    )

    // Determine package manager
    // Priority: explicit option > detected from monorepo > detected from cwd
    const packageManager = yield* pipe(
      options.packageManager,
      Option.orElse(() => monorepoInfo.packageManager),
      Option.match({
        onNone: () => detectPackageManager(process.cwd()),
        onSome: (pm) => Effect.succeed(pm),
      })
    )

    // Build template context
    const ctx: TemplateContext = {
      name: options.name,
      serverType: options.serverType,
      isMonorepo,
      packageManager,
    }

    yield* Console.log("")
    yield* Console.log(`Creating ${ctx.name} with ${ctx.serverType} server...`)

    // Validate target directory
    yield* validateDirectory(targetDir)

    // Generate all files
    const files = generateProject(ctx)

    // Write files
    for (const file of files) {
      const filePath = path.join(targetDir, file.path)
      yield* writeFile(filePath, file.content)
      yield* Console.log(`  Created ${file.path}`)
    }

    // Install dependencies unless skipped
    if (!options.skipInstall) {
      yield* installDependencies(targetDir, packageManager).pipe(
        Effect.catch((error) =>
          Console.log(`Warning: Failed to install dependencies: ${error.message}`).pipe(
            Effect.andThen(
              Console.log(
                "You can install them manually by running: " + getInstallCommand(packageManager)
              )
            )
          )
        )
      )
    } else {
      yield* Console.log("")
      yield* Console.log(
        `Skipping dependency installation. Run '${getInstallCommand(packageManager)}' to install.`
      )
    }

    // Print success message
    yield* printSuccessMessage(ctx, targetDir)
  })
