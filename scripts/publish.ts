/**
 * Publishes packages to npm from their dist directories.
 * Run this after prepare-publish.ts has been run.
 */

import * as fs from "fs"
import * as path from "path"
import { execSync } from "child_process"

const PACKAGES_DIR = path.resolve(__dirname, "../packages")

interface PackageJson {
  name: string
  version: string
  private?: boolean
}

function publishPackage(packageName: string, dryRun: boolean): boolean {
  const packageDir = path.join(PACKAGES_DIR, packageName)
  const distDir = path.join(packageDir, "dist")
  const distPackageJsonPath = path.join(distDir, "package.json")

  // Check if dist/package.json exists (means prepare-publish was run)
  if (!fs.existsSync(distPackageJsonPath)) {
    console.error(`No dist/package.json found for ${packageName}. Run prepare-publish first.`)
    return false
  }

  const pkg = JSON.parse(fs.readFileSync(distPackageJsonPath, "utf-8")) as PackageJson

  // Skip private packages
  if (pkg.private) {
    console.log(`⊘ Skipping ${pkg.name} (private)`)
    return true
  }

  const command = dryRun
    ? `npm publish --dry-run --access public`
    : `npm publish --access public`

  try {
    console.log(`${dryRun ? "[DRY RUN] " : ""}Publishing ${pkg.name}@${pkg.version}...`)
    execSync(command, {
      cwd: distDir,
      stdio: "inherit",
    })
    console.log(`✓ Published ${pkg.name}@${pkg.version}`)
    return true
  } catch (error) {
    console.error(`✗ Failed to publish ${pkg.name}`)
    return false
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const packageArgs = args.filter((arg) => !arg.startsWith("--"))

  const packages =
    packageArgs.length > 0
      ? packageArgs
      : fs.readdirSync(PACKAGES_DIR).filter((name) => {
          const pkgPath = path.join(PACKAGES_DIR, name, "package.json")
          return fs.existsSync(pkgPath)
        })

  console.log(`Publishing ${packages.length} packages${dryRun ? " (dry run)" : ""}...\n`)

  let failed = false
  for (const pkg of packages) {
    if (!publishPackage(pkg, dryRun)) {
      failed = true
    }
  }

  if (failed) {
    process.exit(1)
  }

  console.log("\n✓ All packages published successfully!")
}

main()
