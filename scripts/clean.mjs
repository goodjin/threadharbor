import { readdirSync, rmSync } from 'node:fs'

for (const entry of readdirSync('packages', { withFileTypes: true })) {
  if (entry.isDirectory()) rmSync(`packages/${entry.name}/lib`, { recursive: true, force: true })
}
rmSync('lib', { recursive: true, force: true })
