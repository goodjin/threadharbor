/**
 * Decrypting the local ZCode coding-plan credential.
 *
 * Measured 2026-10-13: `~/.zcode/v2/credentials.json` holds the api key under
 * a key like `account-provider:coding-plan:…:api-key`, the value being
 * `enc:v1:<iv>.<tag>.<ct>` in base64url, AES-256-GCM with the key derived as
 * sha256 of `zcode-credential-fallback:<platform>:<homedir>:<username>`.
 *
 * The username must come from the passwd entry for the current uid — on macOS
 * `os.login()`-style environment lookups can disagree with it and the GCM tag
 * then fails. Node's `os.userInfo()` reads the passwd entry, which is the one
 * that decrypts. The decrypted key lives in memory only; nothing here logs it.
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir, platform, userInfo } from 'node:os'

function b64url(input: string): Buffer {
  return Buffer.from(input + '='.repeat((4 - input.length % 4) % 4), 'base64url')
}

/** Derive the AES key the same way the desktop app's fallback secret does. */
export function deriveKey(over?: { platform?: string; home?: string; username?: string }): Buffer {
  const secret = `zcode-credential-fallback:${over?.platform ?? platform()}:${over?.home ?? homedir()}:${over?.username ?? userInfo().username}`
  return createHash('sha256').update(secret).digest()
}

/** Decrypt one `enc:v1:<iv>.<tag>.<ct>` value. Throws when the tag fails. */
export function decryptCredential(value: string, key: Buffer = deriveKey()): string {
  const body = value.slice('enc:v1:'.length)
  const parts = body.split('.')
  if (parts.length !== 3 || parts.some(part => part === '')) throw new Error('credential is not enc:v1:<iv>.<tag>.<ct>')
  const decipher = createDecipheriv('aes-256-gcm', key, b64url(parts[0]!))
  decipher.setAuthTag(b64url(parts[1]!))
  return Buffer.concat([decipher.update(b64url(parts[2]!)), decipher.final()]).toString('utf8')
}

/**
 * The coding-plan api key, decrypted. Resolved lazily and cached: the file is
 * read once per process and the key never touches disk or logs afterwards.
 */
export async function loadApiKey(credentialsFile: string): Promise<string> {
  let creds: Record<string, unknown>
  try {
    creds = JSON.parse(await readFile(credentialsFile, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`cannot read ZCode credentials at ${credentialsFile}: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const [name, value] of Object.entries(creds)) {
    if (name.startsWith('account-provider:coding-plan:') && name.endsWith(':api-key')
      && typeof value === 'string' && value.startsWith('enc:v1:')) {
      return decryptCredential(value)
    }
  }
  throw new Error('no coding-plan api key in ZCode credentials (is the desktop app logged in?)')
}
