import { expect, spyOn, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import * as capacity from '@neutronai/runtime/workers/claude-capacity-client.ts'
import { createAdminRespawnSurface } from '@neutronai/gateway/http/admin-respawn-surface.ts'
import { composeHttpHandler } from '@neutronai/gateway/http/compose.ts'
import { createPersistentReplSubstrate, poolKeyFor, shutdownAllPersistentRepls } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { registerSupervisedSubstrate, respawnSupervisedSession } from '@neutronai/runtime/adapters/claude-code/persistent/supervision.ts'
import { getRecord, patchRecord } from '@neutronai/runtime/adapters/claude-code/persistent/repl-registry.ts'
import { rearmReplCap } from '@neutronai/runtime/adapters/claude-code/persistent/operator-cap-rearm.ts'
import { setNativeChildLiveness } from '@neutronai/runtime/adapters/claude-code/persistent/native-child-liveness.ts'
import { lifecycleReplHost } from '@neutronai/runtime/adapters/claude-code/persistent/__tests__/lifecycle-repl-host.ts'
import { sessionJsonlPath } from '@neutronai/runtime/adapters/claude-code/persistent/session-size-watchdog.ts'
import type { PersistentReplSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/persistent/types.ts'
import { issueCapRearmAuthorization } from '../sign-repl-cap-rearm.ts'
import { verifyCapRearmAuthorization } from '../operator-cap-rearm-authorization.ts'

test('owner force cannot release a cap; independently signed exact rearm enables uncapped force', async () => {
  const pin = spyOn(capacity, 'loadClaudeCapacityPin').mockReturnValue(undefined)
  const route = spyOn(capacity, 'nativeRelayRouteFingerprint').mockReturnValue(undefined)
  const dir = mkdtempSync(join(tmpdir(), 'force-cap-authority-'))
  const fake = lifecycleReplHost()
  const owner = 'force-cap-owner'
  const projectsDir = join(dir, 'projects')
  const options: PersistentReplSubstrateOptions = { substrate_instance_id: 'force-cap', user_id: owner,
    project_id: 'project', conversationProjectId: 'project', cwd: dir,
    replRegistryPath: join(dir, 'registry.json'), projectsDir, skipTrustSeed: true, idleQuietMs: 0,
    sinkTokenPath: join(dir, 'sink-token'), captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    ptyHost: { async spawn(argv, opts) {
      const child = await fake.host.spawn(argv, opts)
      const current = fake.children.at(-1)!
      const transcript = sessionJsonlPath(current.sessionId, dir, projectsDir)
      mkdirSync(dirname(transcript), { recursive: true })
      writeFileSync(transcript, '{"type":"user","message":{"content":"fixture"}}\n')
      return child
    } },
  }
  setNativeChildLiveness(owner, () => false)
  try {
    registerSupervisedSubstrate(options)
    const substrate = createPersistentReplSubstrate(options)
    for await (const event of substrate.start({ prompt: 'ready', tools: [], model_preference: ['claude-test'] }).events) {
      if (event.kind === 'error') throw new Error(event.message)
    }
    const key = poolKeyFor(options), path = options.replRegistryPath!
    const first = fake.children[0]!
    expect(getRecord(path, key)?.has_session).toBe(true)
    patchRecord(path, key, { capped_at: 123 })
    const row = getRecord(path, key)!
    const request = { projectId: 'project', sessionKey: key, sessionId: row.sessionId,
      childGeneration: row.child_generation!, cappedAt: 123 }
    const pair = generateKeyPairSync('ed25519')
    const authority = { hostId: 'fixture-host', instanceId: 'fixture-instance',
      publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), attestBoot: async () => undefined }
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const issue = (input = request, signingKey = privateKey) => issueCapRearmAuthorization(input,
      '/fixture-operator-key', authority.hostId, authority.instanceId,
      { uid: () => 0, readKey: () => Buffer.from(signingKey) })
    let pinned = true
    const verify = (envelope: unknown) => verifyCapRearmAuthorization(envelope, pinned ? authority : undefined)
    const surface = createAdminRespawnSurface({ gatewayToken: 'owner-token', rateLimit: { windowMs: 60_000, maxRequests: 100 },
      respawn: sessionKey => respawnSupervisedSession(path, sessionKey),
      authorizeCapRearm: envelope => verify(envelope) !== undefined,
      rearmCap: async envelope => {
        const exact = verify(envelope)
        return exact !== undefined && rearmReplCap(options, exact, () => verify(envelope) !== undefined)
      },
    })
    const http = composeHttpHandler({ adminRespawn: surface, defaultHandler: () => new Response(null, { status: 404 }) })
    const call = (endpoint: string, body: unknown, token = 'owner-token') => http.fetch(new Request(`http://fixture${endpoint}`, {
      method: 'POST', headers: { 'X-Gateway-Token': token }, body: JSON.stringify(body),
    }), {} as never)
    const force = () => call('/admin/respawn-session', { session: key })
    const unchanged = () => {
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(fake.children).toHaveLength(1)
      expect(first.child.hasExited()).toBe(false)
    }
    const before = readFileSync(path, 'utf8')
    expect((await force()).status).toBe(500)
    unchanged()
    expect((await call('/admin/rearm-session-cap', request)).status).toBe(403)
    unchanged()
    const foreign = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect((await call('/admin/rearm-session-cap', issue(request, foreign))).status).toBe(403)
    unchanged()
    expect((await call('/admin/rearm-session-cap', issue({ ...request, childGeneration: 'stale' }))).status).toBe(409)
    unchanged()
    pinned = false
    expect((await call('/admin/rearm-session-cap', issue())).status).toBe(403)
    unchanged()
    pinned = true
    let keyReads = 0
    expect(() => issueCapRearmAuthorization(request, '/fixture-operator-key', authority.hostId, authority.instanceId,
      { uid: () => 1000, readKey: () => { keyReads++; return Buffer.from(privateKey) } })).toThrow()
    expect(keyReads).toBe(0)
    expect((await force()).status).toBe(500)
    unchanged()
    expect((await call('/admin/rearm-session-cap', issue())).status).toBe(200)
    expect(getRecord(path, key)?.capped_at).toBeUndefined()
    expect(fake.children).toHaveLength(1) // Signed rearm itself never restarts.
    expect(first.child.hasExited()).toBe(false)
    setNativeChildLiveness(owner, () => true)
    const rearmed = readFileSync(path, 'utf8')
    expect((await force()).status).toBe(500)
    expect(readFileSync(path, 'utf8')).toBe(rearmed)
    expect(first.child.hasExited()).toBe(false)
    setNativeChildLiveness(owner, () => false)
    expect((await force()).status).toBe(202)
    const deadline = Date.now() + 5000
    while ((fake.children.length !== 2 || getRecord(path, key)?.child_generation === row.child_generation) && Date.now() < deadline) {
      await Bun.sleep(10)
    }
    expect(fake.children).toHaveLength(2)
    expect(first.child.hasExited()).toBe(true)
    expect(fake.children[1]!.sessionId).toBe(first.sessionId)
    expect(getRecord(path, key)?.child_generation).not.toBe(row.child_generation)
    expect(getRecord(path, key)?.capped_at).toBeUndefined()
  } finally {
    await shutdownAllPersistentRepls()
    setNativeChildLiveness(owner, undefined)
    pin.mockRestore(); route.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})
