import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectClaudeCapacity, type ClaudeCapacityPin, type AcquireClaudeCapacity } from './claude-capacity-client.ts'

/** Fake selector, real Unix transport and signatures. Never reads credentials or calls a provider. */
export async function capacityFixture(mode = 'available') {
  const root = await mkdtemp(join(tmpdir(), 'capacity-proof-')), configDir = join(root, 'config')
  await mkdir(configDir)
  const keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519')
  const pin: ClaudeCapacityPin = { version: 1, publicKey: String(keys.publicKey.export({ type: 'spki', format: 'pem' })),
    hostId: 'fixture-host', instanceId: 'fixture-instance', socketPath: join(root, 'capacity.sock'), claudeConfigDir: configDir }
  const requests: Record<string, unknown>[] = [], sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    let raw = ''
    socket.on('data', bytes => {
      raw += bytes.toString(); if (!raw.endsWith('\n')) return
      const request = JSON.parse(raw); requests.push(request)
      if (mode === 'disconnect') { socket.destroy(); return }
      if (mode === 'timeout') return
      const status = mode === 'all-full' ? 'all-full' : mode === 'unknown' ? 'unknown' : 'available'
      const body = { ...request, kind: 'claude-capacity', hostId: pin.hostId,
        bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), status,
        accountGeneration: status === 'available' ? 'a'.repeat(64) : null,
        observedAtMs: Date.now(), retryAtMs: status === 'all-full' ? Date.now() + 60_000 : null }
      if (mode.startsWith('wrong-')) body[mode.slice(6)] = 'foreign'
      if (mode === 'stale') body.observedAtMs -= 60_000
      if (mode === 'future') body.observedAtMs += 60_000
      const envelope = { body, signature: sign(null, Buffer.from(JSON.stringify(body)), mode === 'forged' ? other.privateKey : keys.privateKey).toString('base64') }
      socket.write(JSON.stringify(envelope) + '\n' + (mode === 'extra-frame' ? '{}\n' : ''))
    })
  })
  await new Promise<void>(resolve => server.listen(pin.socketPath, resolve))
  const acquire: AcquireClaudeCapacity = input => connectClaudeCapacity(pin, input)
  return { pin, configDir, requests, acquire, sockets, setMode(value: string) { mode = value },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) } }
}
