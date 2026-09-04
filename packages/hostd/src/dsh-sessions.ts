/** Move leftover project-local DSH JSONL into the hostd-owned session root. */

import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync,
} from 'node:fs'
import { join } from 'node:path'

const PROJECT_SESSIONS_DIR = '.sessions'

function isExdev(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EXDEV'
}

function removeIfEmpty(path: string): void {
  if (!existsSync(path)) return
  if (readdirSync(path).length > 0) return
  rmSync(path, { recursive: true, force: true })
}

function moveDirectory(source: string, destination: string): void {
  try {
    renameSync(source, destination)
  } catch (error) {
    if (!isExdev(error)) throw error
    cpSync(source, destination, { recursive: true, errorOnExist: true })
    rmSync(source, { recursive: true, force: true })
  }
  chmodSync(destination, 0o700)
}

/**
 * Relocate `<cwd>/.sessions/<projectKey>/<sessionId>/` into `sessionRoot`.
 * Destination already present (a live DSH_SESSION_ROOT write) wins; the
 * leftover project copy is deleted. Empty `.sessions` trees are removed.
 *
 * @param cwd - project working directory that may still contain `.sessions`.
 * @param sessionRoot - hostd-owned JSONL root (`dataDir/dsh-sessions`).
 */
export function migrateProjectDshSessions(cwd: string, sessionRoot: string): void {
  const sourceRoot = join(cwd, PROJECT_SESSIONS_DIR)
  if (!existsSync(sourceRoot)) return
  const sourceStat = lstatSync(sourceRoot)
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) return
  if (!existsSync(sessionRoot) || !statSync(sessionRoot).isDirectory()) return
  try {
    if (realpathSync(sourceRoot) === realpathSync(sessionRoot)) return
  } catch {
    return
  }

  for (const projectEntry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue
    const sourceProject = join(sourceRoot, projectEntry.name)
    const destinationProject = join(sessionRoot, projectEntry.name)
    mkdirSync(destinationProject, { recursive: true, mode: 0o700 })
    chmodSync(destinationProject, 0o700)

    for (const sessionEntry of readdirSync(sourceProject, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink()) continue
      const sourceSession = join(sourceProject, sessionEntry.name)
      const destinationSession = join(destinationProject, sessionEntry.name)
      if (existsSync(destinationSession)) {
        rmSync(sourceSession, { recursive: true, force: true })
        continue
      }
      moveDirectory(sourceSession, destinationSession)
    }
    removeIfEmpty(sourceProject)
  }
  removeIfEmpty(sourceRoot)
}
