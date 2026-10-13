import { connect, createServer } from 'node:net'

export async function portListening(port: number, attempts = 1): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const open = await new Promise<boolean>((resolveProbe) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.setTimeout(1000)
      socket.once('connect', () => { socket.destroy(); resolveProbe(true) })
      socket.once('timeout', () => { socket.destroy(); resolveProbe(false) })
      socket.once('error', () => resolveProbe(false))
    })
    if (open) return true
    if (attempt + 1 < attempts) await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  return false
}

export async function freePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        rejectPort(new Error('failed to allocate a loopback port'))
        return
      }
      const port = address.port
      server.close((error) => error === undefined ? resolvePort(port) : rejectPort(error))
    })
  })
}
