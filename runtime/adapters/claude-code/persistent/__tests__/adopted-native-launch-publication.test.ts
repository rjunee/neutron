import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reconcileOwnRepl, resetBootAdoptionForTests } from '../boot-adoption.ts'
import { pool } from '../pool-state.ts'
import { shutdownAllPersistentRepls } from '../persistent-repl-substrate.ts'
import { readNativeParentLaunchEvidence } from '../native-parent-launch-evidence.ts'
import { FakeAdoptableHost } from './boot-adoption-host.ts'
import type { AdoptedNativeLaunchDeps } from '../adopted-native-parent-launch.ts'

const dirs: string[] = []
const channel = 'neutron-0123456789abcdef0123456789abcdef'
afterEach(async () => {
  await shutdownAllPersistentRepls()
  resetBootAdoptionForTests()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function adopt(input: { tools?: string; healthy?: boolean; scope?: string | null; image?: boolean;
  changeBeforeClaim?: boolean; credential?: boolean; baseline?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adopt-launch-')); dirs.push(dir)
  const key = 'instance owner project credential', registry = join(dir, 'registry.json')
  const argv = ['claude', '--resume', 'session', '--tools', input.tools ?? 'Agent,SendMessage',
    '--dangerously-load-development-channels', `server:${channel}`]
  const scope = input.scope === undefined ? 'project' : input.scope
  const row = { sessionKey: key, sessionId: 'session', channelName: channel, cwd: dir,
    conversationProjectId: scope, has_session: true, pid: 4242, devchannel_port: 45555,
    child_generation: 'generation', pane_handle: 'pane',
    reuse: { tool_surface: 'Agent,SendMessage', tool_bridge: false, auth_fingerprint: 'auth' } }
  writeFileSync(registry, JSON.stringify({ [key]: row }))
  const host = new FakeAdoptableHost()
  host.addPane('pane', { argv, screens: input.baseline === false ? [] : ['idle'], pid: 4242 })
  let observations = 0
  const nativeLaunch: AdoptedNativeLaunchDeps = {
    readIdentity: () => ({ boot_id: 'boot', start_ticks: 10 }), readArgv: () => argv,
    observeExecutable: async () => {
      observations++
      if (input.changeBeforeClaim) writeFileSync(registry, JSON.stringify({ [key]: { ...row, child_generation: 'foreign' } }))
      return input.image === false ? undefined : {
        executable: { realPath: '/opt/claude.exe', version: '2.1.285', sha256: 'measured' }, isCurrent: () => true }
    },
  }
  const result = await reconcileOwnRepl({ substrate_instance_id: 'instance', user_id: 'owner', project_id: 'project',
    conversationProjectId: scope, cwd: dir, replRegistryPath: registry, ptyHost: host }, key,
  { host, health: async () => input.healthy !== false, nativeLaunch, baselineMs: 5,
    expectedAuthFingerprint: input.credential === false ? 'different' : 'auth', log() {} })
  const session = await pool.get(key)
  return { result, session, evidence: session && readNativeParentLaunchEvidence(session), observations }
}

test('authenticated adopted project publishes fresh launch inputs for later dispatch receipts', async () => {
  const f = await adopt()
  expect(f.result.kind, JSON.stringify(f.result)).toBe('adopted')
  expect(f.session!.adopted).toBe(true)
  expect(f.observations).toBe(1)
  expect(f.evidence).toMatchObject({ sessionId: 'session', childGeneration: 'generation', projectId: 'project',
    tools: ['Agent', 'SendMessage'], executable: { sha256: 'measured' } })
})

test('registry SendMessage assertion cannot upgrade an Agent-only survivor', async () => {
  const f = await adopt({ tools: 'Agent' })
  expect(f.result.kind).toBe('adopted')
  expect(f.evidence).toBeUndefined()
  expect(f.observations).toBe(0)
})

test('missing executable observation preserves adoption but supplies no launch authority', async () => {
  const f = await adopt({ image: false })
  expect(f.result.kind).toBe('adopted')
  expect(f.evidence).toBeUndefined()
  expect(f.observations).toBe(1)
})

test('General never acquires project continuation evidence', async () => {
  const f = await adopt({ scope: null })
  expect(f.result.kind).toBe('adopted')
  expect(f.evidence).toBeUndefined()
  expect(f.observations).toBe(0)
})

test('failed health or replaced generation never publishes measured evidence', async () => {
  const health = await adopt({ healthy: false })
  expect(health.result.kind).not.toBe('adopted')
  expect(health.observations).toBe(0)
  expect(health.session).toBeUndefined()
  const changed = await adopt({ changeBeforeClaim: true })
  expect(changed.result.kind).not.toBe('adopted')
  expect(changed.observations).toBe(1)
  expect(changed.session).toBeUndefined()
})

test('changed credential or unavailable baseline never publishes continuation authority', async () => {
  const credential = await adopt({ credential: false })
  expect(credential.result.kind).not.toBe('adopted')
  expect(credential.observations).toBe(0)
  expect(credential.session).toBeUndefined()
  const baseline = await adopt({ baseline: false })
  expect(baseline.result.kind).not.toBe('adopted')
  expect(baseline.observations).toBe(1)
  expect(baseline.session).toBeUndefined()
})
