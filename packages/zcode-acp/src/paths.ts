/**
 * Where the ZCode world lives on this machine, overridable for tests.
 *
 * Defaults match the layout measured on 2026-10-13 (ZCode desktop 3.15.1,
 * CLI 0.16.9). Every knob also has an env override so a broken install can be
 * pointed at the right place without a rebuild — and so the test suite can
 * substitute a temp home and a fake app-server.
 */

export type ZcodePaths = {
  /** `~/.zcode/v2/credentials.json` — the encrypted coding-plan api key. */
  readonly credentialsFile: string
  /** Base of the builtin provider configs; the newest version dir wins. */
  readonly builtinBase: string
  /** `~/.zcode/v2/provider_config.json`. */
  readonly personalConfig: string
  /** `~/.zcode/cli/log` — where the app-server writes its jsonl log. */
  readonly logDir: string
  /** The app-server entry this adapter spawns with `node <script> app-server`. */
  readonly serverScript: string
  /** Node binary for the spawn; the adapter itself already runs on node. */
  readonly nodeBin: string
}

function env(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

export function defaultPaths(): ZcodePaths {
  const home = process.env['HOME'] ?? '.'
  return {
    credentialsFile: env('ZCODE_ACP_CREDENTIALS_FILE') ?? `${home}/.zcode/v2/credentials.json`,
    builtinBase: env('ZCODE_ACP_BUILTIN_BASE') ?? `${home}/.zcode/v2/runtime/provider/darwin-aarch64`,
    personalConfig: env('ZCODE_ACP_PERSONAL_FILE') ?? `${home}/.zcode/v2/provider_config.json`,
    logDir: env('ZCODE_ACP_LOG_DIR') ?? `${home}/.zcode/cli/log`,
    serverScript: env('ZCODE_ACP_SERVER_SCRIPT')
      ?? '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    nodeBin: env('ZCODE_ACP_NODE_BIN') ?? 'node',
  }
}
