/**
 * Prepares packages for npm publishing by copying and transforming
 * package.json to the dist directory with adjusted paths.
 *
 * This ensures the published package has files at root level instead of dist/.
 */

import * as fs from "fs"
import * as path from "path"

const PACKAGES_DIR = path.resolve(__dirname, "../packages")
const ROOT_DIR = path.resolve(__dirname, "..")

interface PackageJson {
  name: string
  version: string
  main?: string
  types?: string
  exports?: Record<string, unknown>
  files?: string[]
  [key: string]: unknown
}

function removeDist(value: string): string {
  return value.replace(/^\.\/dist\//, "./").replace(/^dist\//, "./")
}

function transformExports(
  exports: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(exports)) {
    if (typeof value === "string") {
      result[key] = removeDist(value)
    } else if (typeof value === "object" && value !== null) {
      result[key] = transformExports(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}

function transformBin(
  bin: Record<string, string> | string
): Record<string, string> | string {
  if (typeof bin === "string") {
    return removeDist(bin)
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(bin)) {
    result[key] = removeDist(value)
  }
  return result
}

function transformPackageJson(pkg: PackageJson): PackageJson {
  const transformed = { ...pkg }

  // Remove dist/ prefix from main and types
  if (transformed.main) {
    transformed.main = removeDist(transformed.main)
  }
  if (transformed.types) {
    transformed.types = removeDist(transformed.types)
  }

  // Transform bin
  if (transformed.bin) {
    transformed.bin = transformBin(
      transformed.bin as Record<string, string> | string
    )
  }

  // Transform exports
  if (transformed.exports) {
    transformed.exports = transformExports(
      transformed.exports as Record<string, unknown>
    )
  }

  // Remove files array - not needed since we're publishing from dist
  delete transformed.files

  // Remove scripts - not needed in published package
  delete transformed.scripts

  // Remove devDependencies - not needed in published package
  delete transformed.devDependencies

  return transformed
}

function preparePackage(packageName: string): void {
  const packageDir = path.join(PACKAGES_DIR, packageName)
  const distDir = path.join(packageDir, "dist")
  const packageJsonPath = path.join(packageDir, "package.json")

  // Check if package exists
  if (!fs.existsSync(packageJsonPath)) {
    console.error(`Package not found: ${packageName}`)
    return
  }

  // Check if dist exists
  if (!fs.existsSync(distDir)) {
    console.error(`Dist directory not found for ${packageName}. Run build first.`)
    return
  }

  // Read and transform package.json
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as PackageJson
  const transformedPkg = transformPackageJson(pkg)

  // Write transformed package.json to dist
  fs.writeFileSync(
    path.join(distDir, "package.json"),
    JSON.stringify(transformedPkg, null, 2) + "\n"
  )

  // Copy README.md if it exists (from package dir or root)
  const packageReadme = path.join(packageDir, "README.md")
  const rootReadme = path.join(ROOT_DIR, "README.md")
  if (fs.existsSync(packageReadme)) {
    fs.copyFileSync(packageReadme, path.join(distDir, "README.md"))
  } else if (fs.existsSync(rootReadme)) {
    fs.copyFileSync(rootReadme, path.join(distDir, "README.md"))
  }

  // Copy LICENSE if it exists
  const packageLicense = path.join(packageDir, "LICENSE")
  const rootLicense = path.join(ROOT_DIR, "LICENSE")
  if (fs.existsSync(packageLicense)) {
    fs.copyFileSync(packageLicense, path.join(distDir, "LICENSE"))
  } else if (fs.existsSync(rootLicense)) {
    fs.copyFileSync(rootLicense, path.join(distDir, "LICENSE"))
  }

  console.log(`✓ Prepared ${pkg.name} for publishing`)
}

function main(): void {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    // Prepare all packages
    const packages = fs.readdirSync(PACKAGES_DIR).filter((name) => {
      const pkgPath = path.join(PACKAGES_DIR, name, "package.json")
      return fs.existsSync(pkgPath)
    })

    console.log(`Preparing ${packages.length} packages for publishing...\n`)

    for (const pkg of packages) {
      preparePackage(pkg)
    }
  } else {
    // Prepare specific packages
    for (const pkg of args) {
      preparePackage(pkg)
    }
  }

  console.log("\nDone! Run 'npm publish' from each dist/ directory to publish.")
}

main()
