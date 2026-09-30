import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectClaudeCapacity, connectClaudeContinuation, nativeQuotaEpisodeId, registerClaudeNativeRelay,
  type ClaudeCapacityPin, type AcquireClaudeCapacity, type ControlClaudeContinuation } from './claude-capacity-client.ts'
import { readProcessIdentity } from '../adapters/claude-code/persistent/process-identity.ts'

/** Fake host, real Unix transport and signatures; no credentials or provider. */
export async function capacityFixture(mode = 'available', modelId = 'claude-fable-5-1') {
  const root = await mkdtemp(join(tmpdir(), 'capacity-proof-')), configDir = join(root, 'config')
  await mkdir(configDir)
  const keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519')
  const pin: ClaudeCapacityPin = { version: 1, publicKey: String(keys.publicKey.export({ type: 'spki', format: 'pem' })),
    hostId: 'fixture-host', instanceId: 'fixture-instance', socketPath: join(root, 'capacity.sock'), claudeConfigDir: configDir }
  const requests: Record<string, unknown>[] = [], sockets = new Set<Socket>(), parents = new Map<string, Record<string, unknown>>()
  let nativeStatus = 'all-full', retryDelayMs = 60_000
  let bodyDigest = 'b'.repeat(64)
  let predecessorToolUseId: string | null = null, intentId: string | null = null
  const intents = new Map<string, Record<string, any>>()
  const promoted = new Set<string>()
  let onPromotion: ((toolUseId: string, intentId: string) => Promise<void>) | undefined
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    let raw = ''
    socket.on('data', bytes => {
      raw += bytes.toString(); if (!raw.endsWith('\n')) return
      const request = JSON.parse(raw); requests.push(request)
      const scopeDigest = createHash('sha256').update(request.scopeToken).digest('hex')
      const registration = request.kind === 'claude-native-register'
      if (registration) parents.set(scopeDigest, request)
      if (!registration && mode === 'disconnect') { socket.destroy(); return }
      if (!registration && mode === 'timeout') return
      const parent = parents.get(scopeDigest)!
      const { scopeToken: _token, ...fields } = request
      const body: Record<string, any> = { ...fields, kind: registration ? 'claude-native-registered'
        : request.kind === 'claude-native-bind-child' ? 'claude-native-child-bound' : 'claude-native-observation',
      hostId: pin.hostId, scopeDigest, parentSessionId: parent.parentSessionId,
      parentPid: parent.parentPid, parentStartTicks: parent.parentStartTicks, bootId: parent.bootId }
      if (request.kind === 'claude-native-observe') {
        const status = mode === 'all-full' ? 'all-full' : mode === 'unknown' ? 'unknown' : 'available'
        body.observations = [{ scopeDigest, sessionId: parent.parentSessionId, nativeAgentId: request.nativeAgentId,
          parentAgentId: null, modelId, bodyDigest, status: nativeStatus, accountGeneration: 'c'.repeat(64),
          observedAtMs: Date.now() - 100, retryAtMs: Date.now() + 60_000,
          episodeId: nativeQuotaEpisodeId(request.leaseId, request.eventDigest, predecessorToolUseId), predecessorToolUseId, intentId }]
        body.capacity = { status, modelId, accountGeneration: status === 'available' ? 'a'.repeat(64) : null,
          observedAtMs: Date.now(), retryAtMs: status === 'all-full' ? Date.now() + retryDelayMs : null }
        if (mode.startsWith('wrong-')) {
          const key = mode.slice(6)
          if (key === 'modelId' || key === 'accountGeneration') body.capacity[key] = 'foreign'
          else body[key] = 'foreign'
        }
        if (mode.startsWith('observation-')) body.observations[0][mode.slice(12)] = 'foreign'
        if (mode === 'stale') body.capacity.observedAtMs -= 60_000
        if (mode === 'future') body.capacity.observedAtMs += 60_000
      }
      if (request.kind === 'claude-native-prepare-continuation') {
        body.kind = 'claude-native-continuation-prepared'; body.state = 'pending'
        intents.set(request.intentId, request)
      }
      if (request.kind === 'claude-native-promote-continuation') {
        const prepared = intents.get(request.intentId)
        if (!prepared || ['episodeId', 'hostMessage', 'deadlineMs', 'budgetDigest', 'fenceDigest'].some(key => prepared[key] !== request[key])) { socket.destroy(); return }
        body.kind = 'claude-native-continuation-promoted'; body.state = 'promoted'
        body.previousEpisodeId = request.episodeId
        body.episodeId = nativeQuotaEpisodeId(request.leaseId, request.eventDigest, request.toolUseId)
      }
      if (request.kind === 'claude-native-cancel-continuation') {
        body.kind = 'claude-native-continuation-cancelled'; body.state = 'cancelled'
      }
      if (request.kind.includes('-continuation') && mode.startsWith('control-wrong-')) body[mode.slice('control-wrong-'.length)] = 'foreign'
      const envelope = { body, signature: sign(null, Buffer.from(JSON.stringify(body)), !registration && mode === 'forged' ? other.privateKey : keys.privateKey).toString('base64') }
      socket.end(JSON.stringify(envelope) + '\n' + (!registration && mode === 'extra-frame' ? '{}\n' : ''))
    })
  })
  await new Promise<void>(resolve => server.listen(pin.socketPath, resolve))
  const acquire: AcquireClaudeCapacity = input => connectClaudeCapacity(pin, input)
  const control: ControlClaudeContinuation = async input => {
    const ok = await connectClaudeContinuation(pin, input)
    if (ok && input.action === 'promote' && !promoted.has(input.intentId)) {
      promoted.add(input.intentId)
      await onPromotion?.(input.toolUseId, input.intentId)
    }
    return ok
  }
  const register = async (sessionId = 'parent') => {
    const identity = readProcessIdentity(process.pid)!
    return registerClaudeNativeRelay(pin, { parentSessionId: sessionId, parentPid: process.pid,
      parentStartTicks: identity.start_ticks, bootId: identity.boot_id }, randomBytes(32).toString('base64url'),
    AbortSignal.timeout(1000), Date.now() + 1000)
  }
  return { pin, configDir, requests, acquire, control, register, sockets, intents,
    advanceEpisode(toolUseId: string | null, nonce: string | null) { predecessorToolUseId = toolUseId; intentId = nonce },
    setBodyDigest(value: string) { bodyDigest = value },
    onPromotion(callback: NonNullable<typeof onPromotion>) { onPromotion = callback },
    setMode(value: string) { mode = value },
    setNativeStatus(value: string) { nativeStatus = value }, setModel(value: string) { modelId = value },
    setRetryDelay(value: number) { retryDelayMs = value },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) } }
}
