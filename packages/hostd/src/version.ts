/** Identify a hostd artifact by package version plus a digest of the shipped files. */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Files SSH-deployed to a remote host and hashed for upgrade detection. */
export const HOSTD_ARTIFACT_FILES = ['bin.js', 'hold-worker.js'] as const

export function readHostdPackageVersion(packageJsonPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** `0.1.0` when no files exist; `0.1.0+<12-hex>` after hashing shipped JS. */
export function hostdVersionFromFiles(packageVersion: string, files: readonly string[]): string {
  const existing = files.filter((path) => {
    try {
      return existsSync(path) && statSync(path).isFile()
    } catch {
      return false
    }
  }).sort((left, right) => basename(left).localeCompare(basename(right)))
  if (existing.length === 0) return packageVersion
  const hash = createHash('sha256')
  for (const path of existing) {
    hash.update(basename(path))
    hash.update('\0')
    hash.update(readFileSync(path))
  }
  return `${packageVersion}+${hash.digest('hex').slice(0, 12)}`
}

export function hostdArtifactVersionFromDirectory(artifactDirectory: string): string {
  return hostdVersionFromFiles(
    readHostdPackageVersion(join(artifactDirectory, '..', 'package.json')),
    HOSTD_ARTIFACT_FILES.map(file => join(artifactDirectory, file)),
  )
}

/** Version of the code this process loaded. Must not re-read files after start. */
export function runningHostdVersion(
  workerScript: string,
  here = fileURLToPath(new URL('.', import.meta.url)),
): string {
  const files = [...new Set([join(here, 'bin.js'), workerScript])]
  return hostdVersionFromFiles(readHostdPackageVersion(join(here, '..', 'package.json')), files)
}
