/**
 * Monorepo detection and support
 */

import { Effect, Option } from "effect"
import * as fs from "fs"
import * as path from "path"
import type { MonorepoInfo, PackageManager } from "./types"

/**
 * Check if a file exists
 */
const fileExists = (filePath: string): Effect.Effect<boolean, never> =>
  Effect.sync(() => fs.existsSync(filePath))

/**
 * Read a file as string
 */
const readFile = (filePath: string): Effect.Effect<string, Error> =>
  Effect.try({
    try: () => fs.readFileSync(filePath, "utf-8"),
    catch: (error) => new Error(`Failed to read ${filePath}: ${error}`),
  })

/**
 * Detect the package manager based on lock files
 */
export const detectPackageManager = (dir: string): Effect.Effect<PackageManager, never> =>
  Effect.gen(function* () {
    if (yield* fileExists(path.join(dir, "pnpm-lock.yaml"))) return "pnpm"
    if (yield* fileExists(path.join(dir, "bun.lockb"))) return "bun"
    if (yield* fileExists(path.join(dir, "yarn.lock"))) return "yarn"
    return "npm"
  })

/**
 * Detect if we're inside a monorepo and gather info
 *
 * Walks up the directory tree looking for:
 * - pnpm-workspace.yaml (pnpm workspaces)
 * - package.json with "workspaces" field (npm/yarn workspaces)
 * - turbo.json (Turborepo)
 */
export const detectMonorepo = (targetDir: string): Effect.Effect<MonorepoInfo, never> =>
  Effect.gen(function* () {
    // Start from the parent of the target directory
    let currentDir = path.dirname(path.resolve(targetDir))
    const root = path.parse(currentDir).root

    while (currentDir !== root) {
      // Check for pnpm-workspace.yaml
      const pnpmWorkspacePath = path.join(currentDir, "pnpm-workspace.yaml")
      if (yield* fileExists(pnpmWorkspacePath)) {
        return {
          isMonorepo: true,
          packageManager: Option.some("pnpm" as PackageManager),
          workspacesRoot: Option.some(currentDir),
        }
      }

      // Check for package.json with workspaces
      const pkgPath = path.join(currentDir, "package.json")
      if (yield* fileExists(pkgPath)) {
        const content = yield* readFile(pkgPath).pipe(Effect.catch(() => Effect.succeed("")))
        if (content) {
          try {
            const pkg = JSON.parse(content)
            if (pkg.workspaces) {
              const pm = yield* detectPackageManager(currentDir)
              return {
                isMonorepo: true,
                packageManager: Option.some(pm),
                workspacesRoot: Option.some(currentDir),
              }
            }
          } catch {
            // Invalid JSON, continue
          }
        }
      }

      // Check for turbo.json
      const turboPath = path.join(currentDir, "turbo.json")
      if (yield* fileExists(turboPath)) {
        const pm = yield* detectPackageManager(currentDir)
        return {
          isMonorepo: true,
          packageManager: Option.some(pm),
          workspacesRoot: Option.some(currentDir),
        }
      }

      // Move up one directory
      currentDir = path.dirname(currentDir)
    }

    // No monorepo detected
    return {
      isMonorepo: false,
      packageManager: Option.none(),
      workspacesRoot: Option.none(),
    }
  })

/**
 * Get the install command for a package manager
 */
export const getInstallCommand = (pm: PackageManager): string => {
  switch (pm) {
    case "npm":
      return "npm install"
    case "pnpm":
      return "pnpm install"
    case "yarn":
      return "yarn"
    case "bun":
      return "bun install"
  }
}

/**
 * Get the run command prefix for a package manager
 */
export const getRunPrefix = (pm: PackageManager): string => {
  switch (pm) {
    case "npm":
      return "npm run"
    case "pnpm":
      return "pnpm"
    case "yarn":
      return "yarn"
    case "bun":
      return "bun run"
  }
}
