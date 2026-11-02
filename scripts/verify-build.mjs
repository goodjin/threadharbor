/**
 * Host-side entry checks for the threadharbor bundle.
 *
 * The browser-artifact checks moved with the federation UI to
 * github.com/goodjin/dsh-client (scripts/verify-build.mjs there).
 */
import { readFileSync } from 'node:fs'

/**
 * Every host-side plugin entry the bundle patch mounts must import under Node
 * itself, not just under tsx.
 *
 * The web host loads link-installed plugins through Node's strip-only
 * TypeScript mode; tsx (used by `pnpm test` and the source launch) silently
 * accepts what that mode rejects — a constructor parameter property, an enum,
 * a namespace. The import then throws inside the host, the entry never gets a
 * fiber, and boot reports only a bare "failed to import" with the cause buried.
 * Importing each entry here with plain Node catches the syntax at build time;
 * the patch file is the source of truth for what a host actually mounts.
 */
const patch = readFileSync('cordis.patch.yml', 'utf8')
const names = [...new Set([...patch.matchAll(/name:\s*'(@goodjin2\/dsh-host-federation\/[^']+)'/g)].map(m => m[1]))]
if (names.length === 0) {
  throw new Error('no @goodjin2/dsh-host-federation plugin names found in cordis.patch.yml — the host-entry import check has nothing to check')
}
for (const name of names) {
  try {
    await import(name)
  } catch (error) {
    throw new Error(
      `host plugin entry ${name} does not import under plain Node (the web host's strip-only mode): `
      + (error instanceof Error ? error.message.split('\n')[0] : String(error)),
    )
  }
}
