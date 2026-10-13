/**
 * SSH deploy wire shapes shared by the host plugin and the browser client.
 *
 * Secrets (password, inline private key) may appear in deploy requests from the
 * browser to this host's authenticated `/api` routes only; they are never
 * written to logs or persisted operation records.
 */

/** OpenSSH target fields the operator fills in. */
export type SshConnectionInput = {
  readonly target: string
  readonly port?: number
  readonly user?: string
  /** Absolute path to a private key on the machine running DSH Web. */
  readonly identityFile?: string
  /** PEM text uploaded once per deploy; stored in a temp file on the host only. */
  readonly identityPem?: string
  /** Password for password authentication; never logged. */
  readonly password?: string
  readonly proxyJump?: string
}

/** Parsed SSH target after validation (still no host key trust). */
export type SshConnectionConfig = SshConnectionInput & {
  readonly hostKeyFingerprint: string | 'unapproved'
}

/** Result of scanning SSH host keys before trust is persisted. */
export type SshHostKeyCandidate = {
  readonly target: string
  readonly hostKeyFingerprint: string
  readonly algorithm: string
}

export type SshDeployPhase =
  | 'queued'
  | 'connecting'
  | 'preparing'
  | 'uploading'
  | 'installing'
  | 'starting'
  | 'opening-tunnel'
  | 'verifying'
  | 'succeeded'
  | 'failed'

export type SshDeployProgress = {
  readonly phase: SshDeployPhase
  readonly detail: string
  readonly current?: number
  readonly total?: number
}

export type SshDeployRequest = {
  readonly ssh: SshConnectionInput & { readonly hostKeyFingerprint: string }
  readonly hostId: string
  readonly hostTitle: string
  /** Loopback port for `dsh web` on the remote machine. */
  readonly remoteWebPort?: number
  /** When true, replace an existing release and restart the service. */
  readonly upgrade?: boolean
}

export type SshDeployResult = {
  readonly endpoint: string
  readonly remoteWebPort: number
  readonly releaseVersion: string
  readonly alreadyRunning: boolean
}

export type SshDeployOperationView = {
  readonly operationId: string
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed'
  readonly progress: SshDeployProgress
  readonly result?: SshDeployResult
  readonly error?: string
  readonly startedAt: number
  readonly finishedAt?: number
}
