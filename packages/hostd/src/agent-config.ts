/** Fixed-path Agent user configuration readers and atomic writers. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type { RemoteAgentConfigBackend, RemoteAgentConfigDocument } from '@threadharbor/protocol'

/** Filesystem root and request bound for Agent user configuration. */
export interface AgentConfigManagerOptions {
  readonly homeDir: string
  readonly maxBytes: number
}

interface ConfigSpec {
  readonly path: string
  readonly format: RemoteAgentConfigDocument['format']
  readonly initialContent: string
}

function environmentRoot(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value.trim() === '' ? fallback : resolve(value)
}

function revision(exists: boolean, content: string): string {
  return createHash('sha256').update(exists ? 'present\0' : 'missing\0').update(content).digest('hex')
}

function readOptional(path: string, initialContent: string): { readonly exists: boolean; readonly content: string } {
  try {
    return { exists: true, content: readFileSync(path, 'utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, content: initialContent }
    throw error
  }
}

function validateJson(content: string): void {
  const value: unknown = JSON.parse(content)
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('Claude Code settings must be a JSON object')
  }
}

/** Reads and saves only the official user configuration file assigned to each Agent. */
export class AgentConfigManager {
  /** @param options - fixed home directory and maximum document size. */
  constructor(private readonly options: AgentConfigManagerOptions) {}

  /** Read one Agent's official user configuration file.
   * @param backend - configurable Agent backend.
   * @returns content plus an optimistic-concurrency revision.
   */
  read(backend: RemoteAgentConfigBackend): RemoteAgentConfigDocument {
    const spec = this.spec(backend)
    const current = readOptional(spec.path, spec.initialContent)
    const bytes = Buffer.byteLength(current.content)
    if (bytes > this.options.maxBytes) throw new Error(`${backend} configuration exceeds the ${this.options.maxBytes}-byte limit`)
    return {
      backend,
      path: spec.path,
      format: spec.format,
      exists: current.exists,
      content: current.content,
      revision: revision(current.exists, current.content),
      maxBytes: this.options.maxBytes,
    }
  }

  /** Validate and atomically replace one fixed Agent user configuration file.
   * @param backend - configurable Agent backend.
   * @param content - complete JSON or TOML document.
   * @param expectedRevision - revision returned by the last read.
   * @returns the newly persisted document.
   */
  write(backend: RemoteAgentConfigBackend, content: string, expectedRevision: string): RemoteAgentConfigDocument {
    const bytes = Buffer.byteLength(content)
    if (bytes > this.options.maxBytes) throw new Error(`${backend} configuration exceeds the ${this.options.maxBytes}-byte limit`)
    const spec = this.spec(backend)
    if (spec.format === 'json') validateJson(content)
    else parseToml(content)
    const current = this.read(backend)
    if (current.revision !== expectedRevision) throw new Error(`${backend} configuration changed after it was opened; reload before saving`)
    mkdirSync(dirname(spec.path), { recursive: true, mode: 0o700 })
    const temporary = `${spec.path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, content, { mode: 0o600 })
    renameSync(temporary, spec.path)
    return this.read(backend)
  }

  private spec(backend: RemoteAgentConfigBackend): ConfigSpec {
    switch (backend) {
      case 'codex': {
        const root = environmentRoot('CODEX_HOME', join(this.options.homeDir, '.codex'))
        return { path: join(root, 'config.toml'), format: 'toml', initialContent: '' }
      }
      case 'grok': {
        const root = environmentRoot('GROK_HOME', join(this.options.homeDir, '.grok'))
        return { path: join(root, 'config.toml'), format: 'toml', initialContent: '' }
      }
      case 'claude': {
        const root = environmentRoot('CLAUDE_CONFIG_DIR', join(this.options.homeDir, '.claude'))
        return {
          path: join(root, 'settings.json'),
          format: 'json',
          initialContent: '{\n  "$schema": "https://json.schemastore.org/claude-code-settings.json"\n}\n',
        }
      }
    }
  }
}
