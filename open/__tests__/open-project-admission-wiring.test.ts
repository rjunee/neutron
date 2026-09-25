/**
 * #1237 — the composed Open app exposes ONE project admission service, and the
 * composed chat runner (the unified `/ws/app/chat` surface the owner uses) admits
 * through it. Boots the REAL Open composition over a live `Bun.serve` with a mocked
 * substrate: a message into a fenced General is refused before the live-agent
 * dispatch, and the same message is answered once admission reopens.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { ProjectAdmission } from '@neutronai/gateway/project-admission.ts'
import { PROJECT_FENCED_BODY } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import type { MaintenanceFence } from '@neutronai/gateway/project-admission-store.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG', 'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let close: (() => Promise<void>) | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-admission-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-admission-test'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(async () => {
  if (close !== null) { await close(); close = null }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

const COLD_PROMPT_MARKER = "The user's message follows. Reply to it directly."

function recordingSubstrate(prompts: string[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      prompts.push(spec.prompt)
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: 'admitted-reply' }
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'mock' }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> { throw new Error('mock substrate: no external tools') },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

test('the composed app exposes the admission service and its chat runner refuses a fenced General', async () => {
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const prompts: string[] = []
  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: () => recordingSubstrate(prompts),
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  const server = Bun.serve({ port: 0, fetch: (req, srv) => graph.fetch!(req, srv), websocket: graph.websocket! })
  close = async () => {
    await server.stop(true)
    for (const cleanup of composition.realmode_cleanups ?? []) { try { await cleanup() } catch { /* best-effort */ } }
    await graph.shutdown()
    db.close()
  }

  const admission = composition.project_admission
  expect(admission).toBeInstanceOf(ProjectAdmission)
  if (admission === undefined) throw new Error('composition did not expose project_admission')
  const general = admission.scopeFor(null)
  await admission.maintenance.register(general)
  const fence = (await admission.maintenance.beginMaintenance(general))!
  expect(fence).not.toBeNull()

  const frames: string[] = []
  const ws = new WebSocket(`${`http://127.0.0.1:${server.port}`.replace(/^http/, 'ws')}/ws/app/chat?token=dev:owner&platform=web`)
  ws.onmessage = (e) => { frames.push(String(e.data)) }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
  })
  const liveTurns = (): number => prompts.filter((p) => p.includes(COLD_PROMPT_MARKER)).length

  ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'fenced hello', client_msg_id: 'c-fenced' }))
  await waitFor(() => frames.some((f) => f.includes(PROJECT_FENCED_BODY)))
  expect(liveTurns()).toBe(0)
  expect(admission.inspect(null)).toMatchObject({ phase: 'draining', leases: 0 })

  // Positive control: once admission reopens, the same surface answers.
  let current: MaintenanceFence = fence
  for (let i = 0; i < 3; i++) current = (await admission.maintenance.advance(current))!
  expect(await admission.maintenance.reopen(current)).toBe(true)
  ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'open hello', client_msg_id: 'c-open' }))
  await waitFor(() => frames.some((f) => f.includes('admitted-reply')))
  expect(liveTurns()).toBe(1)
  expect(admission.inspect(null)).toMatchObject({ phase: 'open', leases: 0 })
  ws.close()
  await sleep(50)
}, 30_000)

test('the composed app exposes the liveness census over the SAME admission service', async () => {
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  const composer = buildOpenGraphComposer({ env: process.env, substrateFactory: () => recordingSubstrate([]) })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  close = async () => {
    for (const cleanup of composition.realmode_cleanups ?? []) { try { await cleanup() } catch { /* best-effort */ } }
    await graph.shutdown()
    db.close()
  }
  const liveness = composition.project_liveness
  const admission = composition.project_admission
  if (liveness === undefined || admission === undefined) throw new Error('composition did not expose the census and admission')

  const quiet = await liveness.census(null)
  expect(quiet.parent).toEqual({ kind: 'absent' })
  expect(quiet.scope).toEqual(admission.scopeFor(null))
  expect(quiet.verdict).toBe('idle')

  // A native child admitted through the composed service is what the census reads.
  const child = await admission.forNativeChild(null).admit('census-run', 'build:0')
  if (child.status !== 'admitted') throw new Error(`expected admission, got ${child.status}`)
  const busy = await liveness.census(null)
  expect(busy.children).toBe('busy')
  expect(busy.verdict).toBe('busy')
  expect(await child.release()).toBe(true)
  expect((await liveness.census(null)).verdict).toBe('idle')
}, 30_000)
