import { readFileSync } from 'node:fs'

const client = readFileSync('packages/dsh-client/lib/client.js', 'utf8')
if (!client.startsWith('window.__ModuleLoader__.load(') || !client.includes('@threadharbor/dsh-client')) {
  throw new Error('DSH browser artifact does not register with the public module loader')
}
for (const external of ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']) {
  if (!client.includes(JSON.stringify(external)) && !client.includes(`\`${external}\``)) {
    throw new Error(`DSH browser artifact omitted its ${external} module-table request`)
  }
}
if (client.includes('@threadharbor/protocol')) {
  throw new Error('DSH browser artifact leaked @threadharbor/protocol into the module table; it must be inlined')
}

for (const path of ['packages/hostd/lib/bin.js', 'packages/hostd/lib/hold-worker.js']) {
  const artifact = readFileSync(path, 'utf8')
  const external = [...artifact.matchAll(/\bfrom["']([^"']+)["']/g)].map(match => match[1])
    .find(specifier => !specifier?.startsWith('node:'))
  if (external !== undefined || artifact.includes('/home/') || artifact.includes('/tmp/')) {
    throw new Error(`${path} is not a location-independent self-contained hostd artifact`)
  }
}
