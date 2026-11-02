/**
 * The git work behind `/commit-merge-push`.
 *
 * Runs the repo's gates (typecheck, test, build) before committing, so a red
 * build never lands. Merges a worktree branch to main and pushes both, or just
 * pushes the current branch when already on main.
 */

import { execSync } from 'node:child_process'

export function executeShip(rawInput: string = ''): { kind: 'success' | 'error'; text: string } {
  const message = rawInput.trim() || 'Ship: automated commit'
  const cwd = process.cwd()

  try {
    // 1. Environment check: are we in a git repo, and where?
    const gitDir = execSync('git rev-parse --git-dir', { cwd, encoding: 'utf8' }).trim()
    const commonDir = execSync('git rev-parse --git-common-dir', { cwd, encoding: 'utf8' }).trim()
    const branch = execSync('git branch --show-current', { cwd, encoding: 'utf8' }).trim()

    if (!branch) {
      return { kind: 'error', text: 'Detached HEAD: cannot determine branch to merge and push.' }
    }

    // 2. Gates: typecheck, test, build. Any failure stops here.
    execSync('npm run typecheck', { cwd, stdio: 'inherit' })
    execSync('npm run test', { cwd, stdio: 'inherit' })
    execSync('npm run build', { cwd, stdio: 'inherit' })

    // 3. Commit: stage all changes and commit with the provided message.
    execSync('git add -A', { cwd })
    execSync(`git commit -m "${message}"`, { cwd })

    // 4. Merge: if in a worktree, switch to main, pull, and merge the branch.
    const inWorktree = gitDir !== commonDir
    if (inWorktree) {
      execSync('git checkout main', { cwd })
      execSync('git pull --ff-only', { cwd })
      execSync(`git merge --no-ff ${branch} -m "Merge ${branch}"`, { cwd })
    }

    // 5. Push: always push main; if in a worktree, also push the branch.
    execSync('git push origin main', { cwd })
    if (inWorktree) {
      execSync(`git push origin ${branch}`, { cwd })
    }

    return {
      kind: 'success',
      text: inWorktree
        ? `Shipped: committed to ${branch}, merged to main, pushed both.`
        : `Shipped: committed to ${branch} and pushed.`,
    }
  } catch (error) {
    return { kind: 'error', text: `Ship failed: ${String(error)}` }
  }
}
