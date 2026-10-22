import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { listLocalIdentityFiles, listSshConfigHosts } from '../src/ssh/local-assets.ts'

describe('listSshConfigHosts', () => {
  it('parses Host blocks and skips Match / wildcards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-config-'))
    const config = join(dir, 'config')
    writeFileSync(config, `
Host jinmac-mini us-box
  HostName 192.168.1.5
  User jin
  IdentityFile ~/.ssh/id_ed25519
  Port 2222

Host *
  User good

Match host lab
  User lab
`, 'utf8')
    const hosts = listSshConfigHosts(config)
    expect(hosts).toEqual([
      {
        alias: 'jinmac-mini',
        hostName: '192.168.1.5',
        user: 'jin',
        identityFile: join(process.env['HOME'] ?? '/tmp', '.ssh/id_ed25519'),
        port: 2222,
      },
      {
        alias: 'us-box',
        hostName: '192.168.1.5',
        user: 'jin',
        identityFile: join(process.env['HOME'] ?? '/tmp', '.ssh/id_ed25519'),
        port: 2222,
      },
    ])
  })
})

describe('listLocalIdentityFiles', () => {
  it('lists private keys and skips pub/config junk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-dir-'))
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(join(dir, 'id_ed25519'), 'key', 'utf8')
    writeFileSync(join(dir, 'id_ed25519.pub'), 'pub', 'utf8')
    writeFileSync(join(dir, 'github-deploy'), 'key2', 'utf8')
    writeFileSync(join(dir, 'known_hosts'), 'host', 'utf8')
    writeFileSync(join(dir, 'config'), 'Host x', 'utf8')
    const paths = listLocalIdentityFiles(dir)
    expect(paths.map(path => path.split('/').pop())).toEqual(['github-deploy', 'id_ed25519'])
  })
})
