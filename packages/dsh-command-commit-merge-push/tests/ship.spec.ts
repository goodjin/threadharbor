import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { executeShip } from '../src/ship.ts'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

const mockExecSync = vi.mocked(execSync)

describe('executeShip', () => {
  beforeEach(() => {
    mockExecSync.mockReset()
  })

  afterEach(() => {
    mockExecSync.mockReset()
  })

  it('runs gates, commits, merges, and pushes when in a worktree', () => {
    // Simulate worktree: gitDir !== commonDir
    let callCount = 0
    mockExecSync.mockImplementation((cmd: string) => {
      callCount++
      if (cmd === 'git rev-parse --git-dir') return '.git/worktrees/fix-branch'
      if (cmd === 'git rev-parse --git-common-dir') return '../.git'
      if (cmd === 'git branch --show-current') return 'fix-branch'
      return ''
    })

    const result = executeShip('fix: test message')

    expect(result.kind).toBe('success')
    expect(result.text).toContain('committed to fix-branch')
    expect(result.text).toContain('merged to main')
    expect(result.text).toContain('pushed both')

    // Verify the sequence: env checks → gates → commit → merge → push
    const calls = mockExecSync.mock.calls.map(c => c[0])
    expect(calls[0]).toBe('git rev-parse --git-dir')
    expect(calls[1]).toBe('git rev-parse --git-common-dir')
    expect(calls[2]).toBe('git branch --show-current')
    expect(calls).toContain('npm run typecheck')
    expect(calls).toContain('npm run test')
    expect(calls).toContain('npm run build')
    expect(calls).toContain('git add -A')
    expect(calls).toContain('git commit -m "fix: test message"')
    expect(calls).toContain('git checkout main')
    expect(calls).toContain('git pull --ff-only')
    expect(calls).toContain('git merge --no-ff fix-branch -m "Merge fix-branch"')
    expect(calls).toContain('git push origin main')
    expect(calls).toContain('git push origin fix-branch')
  })

  it('skips merge when already on main', () => {
    // Simulate main branch: gitDir === commonDir
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git rev-parse --git-dir') return '.git'
      if (cmd === 'git rev-parse --git-common-dir') return '.git'
      if (cmd === 'git branch --show-current') return 'main'
      return ''
    })

    const result = executeShip()

    expect(result.kind).toBe('success')
    expect(result.text).toContain('committed to main')
    expect(result.text).toContain('pushed')

    const calls = mockExecSync.mock.calls.map(c => c[0])
    expect(calls).not.toContain('git checkout main')
    expect(calls).not.toContain('git merge --no-ff')
    expect(calls).toContain('git push origin main')
    expect(calls.filter(c => c.startsWith('git push origin'))).toHaveLength(1)
  })

  it('uses default commit message when none provided', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git rev-parse --git-dir') return '.git'
      if (cmd === 'git rev-parse --git-common-dir') return '.git'
      if (cmd === 'git branch --show-current') return 'main'
      return ''
    })

    executeShip()

    const calls = mockExecSync.mock.calls.map(c => c[0])
    expect(calls).toContain('git commit -m "Ship: automated commit"')
  })

  it('returns error when gates fail', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git rev-parse --git-dir') return '.git'
      if (cmd === 'git rev-parse --git-common-dir') return '.git'
      if (cmd === 'git branch --show-current') return 'main'
      if (cmd === 'npm run typecheck') throw new Error('typecheck failed')
      return ''
    })

    const result = executeShip()

    expect(result.kind).toBe('error')
    expect(result.text).toContain('Ship failed')
    expect(result.text).toContain('typecheck failed')

    const calls = mockExecSync.mock.calls.map(c => c[0])
    expect(calls).not.toContain('git add -A')
    expect(calls).not.toContain('git commit')
  })

  it('returns error when in detached HEAD', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git rev-parse --git-dir') return '.git'
      if (cmd === 'git rev-parse --git-common-dir') return '.git'
      if (cmd === 'git branch --show-current') return ''
      return ''
    })

    const result = executeShip()

    expect(result.kind).toBe('error')
    expect(result.text).toContain('Detached HEAD')
  })
})
