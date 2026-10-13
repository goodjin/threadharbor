import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MANIFEST = 'threadharbor-release.json'

export function resolveReleaseDirectory(configured: string | undefined): string {
  if (configured !== undefined && configured.trim() !== '') {
    const expanded = configured.replace(/^~(?=$|\/)/, homedir())
    if (!existsSync(expanded)) throw new Error(`configured release directory does not exist: ${configured}`)
    return realpathSync(expanded)
  }
  const stable = join(homedir(), '.local/share/threadharbor/stable-current')
  if (existsSync(stable)) return realpathSync(stable)
  const testLink = join(homedir(), '.local/share/threadharbor/test-current')
  if (existsSync(testLink)) return realpathSync(testLink)
  return findWorkspaceRoot()
}

export function readReleaseVersion(releaseRoot: string): string {
  const manifestPath = join(releaseRoot, MANIFEST)
  if (!existsSync(manifestPath)) {
    const pkg = join(releaseRoot, 'package.json')
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }
        if (typeof parsed.version === 'string') return parsed.version
      } catch {
        // fall through
      }
    }
    return 'unknown'
  }
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function findWorkspaceRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'package.json')
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }
        if (parsed.name === 'threadharbor' || parsed.name === '@threadharbor/dsh-host-federation') {
          return realpathSync(current)
        }
      } catch {
        // continue walking
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error('unable to locate a ThreadHarbor release directory; configure releaseDirectory on threadharbor-ssh-deploy')
}
