/**
 * #1237 — project admission precedes the chat queue, the parent-input injection
 * seam and host acting turns. Every guard below has an opposite control in the
 * same test: the refused path never reaches the substrate or the injection seam,
 * and the same path proceeds once the scope is open.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { seedProject } from './project-admission-fixture.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ChatOutbound } from '@neutronai/landing/server.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import { ProjectAdmission } from '../../project-admission.ts'
import type { MaintenanceFence } from '../../project-admission-store.ts'
import {
  buildLiveAgentTurn,
  PROJECT_FENCED_BODY,
  PROJECT_UNKNOWN_BODY,
  ProjectAdmissionRefusedError,
} from '../build-live-agent-turn.ts'

let tmp: string
let path: string
let db: ProjectDb
let store: ButtonStore
const extraDbs: ProjectDb[] = []

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-admission-'))
  path = join(tmp, 'owner.db')
  seedMigratedDb(path)
  db = ProjectDb.open(path)
  seedProject(db, 'project-a')
  store = new ButtonStore({ db })
})
afterEach(() => {
  for (const d of extraDbs.splice(0)) d.close()
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function latch() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

/** Substrate that records every start and blocks the prompt containing `block`. */
function gatedSubstrate(block: string) {
  const starts: string[] = []
  const scopes: AgentSpec['metering_context'][] = []
  const started = latch(), release = latch()
  const substrate: Substrate = {
    start(spec: AgentSpec) {
      scopes.push(spec.metering_context)
      const name = spec.prompt.includes(block) ? block : spec.prompt.split('\n').pop()!.trim()
      starts.push(name)
      async function* events(): AsyncGenerator<Event> {
        if (name === block) { started.release(); await release.promise }
        yield { kind: 'token', text: `reply:${name}` }
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 's' }
      }
      return { events: events(), async respondToTool() {}, async cancel() {}, tool_resolution: 'internal' }
    },
  }
  return { substrate, starts, scopes, started, release }
}

function runner(admission: ProjectAdmission, substrate: Substrate, injectActiveTurn?: (text: string) => Promise<boolean>) {
  return buildLiveAgentTurn({
    admission,
    substrate,
    ...(injectActiveTurn !== undefined ? { injectActiveTurn: (_t, text: string) => injectActiveTurn(text) } : {}),
    personaLoader: { async load() { return '' } },
    buttonStore: store,
    project_slug: 'owner',
    owner_home: tmp,
    ack_delay_ms: 60_000,
  })
}

/** `null` = General: the turn carries no project id at all. */
function turn(user_text: string, sent: ChatOutbound[], project_id: string | null = 'project-a') {
  return {
    project_slug: 'owner', user_id: 'u',
    topic_id: project_id === null ? 'app:u' : `app:u:${project_id}`,
    ...(project_id !== null ? { project_id } : {}),
    user_text, send: (e: ChatOutbound) => { sent.push(e) }, observed_at: Date.now(),
  }
}

async function historyText(topic_id: string): Promise<string> {
  return JSON.stringify(await store.listHistoryByTopic({
    topic_id, before: Date.now() + 1, before_prompt_id: null, now: Date.now(), limit: 50,
  }))
}

async function reopenFrom(admission: ProjectAdmission, start: MaintenanceFence): Promise<void> {
  let fence = start
  for (const phase of ['quiesced', 'replacing', 'attesting'] as const) {
    fence = (await admission.maintenance.advance(fence))!
    expect(fence?.phase).toBe(phase)
  }
  expect(await admission.maintenance.reopen(fence)).toBe(true)
}

test('admission race: a fenced turn never queues while admitted work drains; reopen admits again', async () => {
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'boot-1' })
  const g = gatedSubstrate('turn-A')
  const run = runner(admission, g.substrate)
  const sent: ChatOutbound[] = []
  const a = run(turn('turn-A', sent))
  await g.started.promise
  expect(admission.inspect('project-a')?.leases).toBe(1)

  const fence = (await admission.maintenance.beginMaintenance(admission.scopeFor('project-a')))!
  expect(fence.phase).toBe('draining')
  // Admitted work holds its lease: maintenance cannot advance past draining.
  expect(await admission.maintenance.advance(fence)).toBeNull()

  const b = await run(turn('turn-B', sent))
  expect(b).toMatchObject({ outcome: 'failed', reply_prompt_id: null, refusal: { code: 'project_fenced' } })
  expect(g.starts).toEqual(['turn-A'])
  expect(sent.some((e) => e.type === 'agent_message' && e.body === PROJECT_FENCED_BODY)).toBe(true)
  expect(await historyText('app:u:project-a')).not.toContain('turn-B')

  g.release.release()
  expect((await a).outcome).toBe('replied')
  expect(admission.inspect('project-a')?.leases).toBe(0)
  await reopenFrom(admission, fence)

  // Control: the reopened scope admits and reaches the substrate.
  const c = await run(turn('turn-C', sent))
  expect(c.outcome).toBe('replied')
  expect(c.refusal).toBeUndefined()
  expect(g.starts).toEqual(['turn-A', 'turn-C'])
  expect(admission.inspect('project-a')?.leases).toBe(0)
})

test('restart: durable leases from one connection block maintenance through another; a lost fence resumes', async () => {
  const first = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'boot-1' })
  const g = gatedSubstrate('turn-A')
  const run = runner(first, g.substrate)
  const a = run(turn('turn-A', []))
  await g.started.promise
  const lease = db.get<{ producer: string }>('SELECT producer FROM project_admission_leases')
  expect(lease?.producer).toBe('chat:boot-1')

  // A second process on the same file sees the lease and cannot advance past it.
  const db2 = ProjectDb.open(path); extraDbs.push(db2)
  const second = new ProjectAdmission({ db: db2, ownerHandle: 'owner', bootId: 'boot-2' })
  expect(second.inspect('project-a')).toEqual({ generation: 0, phase: 'open', leases: 1 })
  await second.maintenance.beginMaintenance(second.scopeFor('project-a'))
  // Its acknowledgement is "lost"; a third connection resumes the persisted fence.
  const db3 = ProjectDb.open(path); extraDbs.push(db3)
  const third = new ProjectAdmission({ db: db3, ownerHandle: 'owner', bootId: 'boot-3' })
  const resumed = third.maintenance.resume(third.scopeFor('project-a'))!
  expect(resumed.phase).toBe('draining')
  expect(await third.maintenance.advance(resumed)).toBeNull()

  // A runner built on the restarted process refuses while the fence persists.
  const restartedRun = runner(third, gatedSubstrate('__never_blocks__').substrate)
  expect((await restartedRun(turn('after-restart', []))).refusal?.code).toBe('project_fenced')

  g.release.release()
  expect((await a).outcome).toBe('replied')
  await reopenFrom(third, resumed)
  expect((await restartedRun(turn('reopened', []))).outcome).toBe('replied')
})

test('parent input: a fenced follow-up is refused before injection; an open scope injects', async () => {
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'boot-1' })
  const g = gatedSubstrate('turn-A')
  const injected: string[] = []
  const run = runner(admission, g.substrate, async (text) => { injected.push(text); return true })
  const a = run(turn('turn-A', []))
  await g.started.promise

  // Control: the open scope delivers the follow-up into the live parent turn.
  const open = await run(turn('follow-up-open', []))
  expect(open.outcome).toBe('replied')
  expect(injected).toEqual(['follow-up-open'])
  expect(admission.inspect('project-a')?.leases).toBe(1)

  await admission.maintenance.beginMaintenance(admission.scopeFor('project-a'))
  const sent: ChatOutbound[] = []
  const fenced = await run(turn('follow-up-fenced', sent))
  expect(fenced.refusal?.code).toBe('project_fenced')
  expect(injected).toEqual(['follow-up-open'])
  expect(g.starts).toEqual(['turn-A'])
  expect(sent.some((e) => e.type === 'agent_message' && e.body === PROJECT_FENCED_BODY)).toBe(true)
  g.release.release()
  await a
})

test('an unknown project refuses and is never mapped to General; General admits', async () => {
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'boot-1' })
  const g = gatedSubstrate('__never_blocks__')
  const run = runner(admission, g.substrate)
  const sent: ChatOutbound[] = []
  const ghost = await run(turn('to-ghost', sent, 'ghost'))
  expect(ghost.refusal?.code).toBe('project_unknown')
  // A project id spelled like General's legacy sentinel is still a named project.
  expect((await run(turn('to-literal', sent, 'general'))).refusal?.code).toBe('project_unknown')
  expect(sent.filter((e) => e.type === 'agent_message' && e.body === PROJECT_UNKNOWN_BODY)).toHaveLength(2)
  expect(g.starts).toEqual([])
  expect(admission.inspect('ghost')).toBeNull()
  expect(admission.inspect(null)).toBeNull()

  // Control: General (no project id) admits and replies.
  const general = await run(turn('to-general', [], null))
  expect(general.outcome).toBe('replied')
  expect(general.refusal).toBeUndefined()
  expect(g.starts).toHaveLength(1)
  expect(admission.inspect(null)).toEqual({ generation: 0, phase: 'open', leases: 0 })
})

test('host acting turns admit through the same scope and are refused while fenced', async () => {
  const admission = new ProjectAdmission({ db, ownerHandle: 'owner', bootId: 'boot-1' })
  const g = gatedSubstrate('__never_blocks__')
  const run = runner(admission, g.substrate)
  const spec = (prompt: string, metering_context?: AgentSpec['metering_context']): AgentSpec => ({
    prompt, tools: [], model_preference: [], ...(metering_context !== undefined ? { metering_context } : {}),
  })
  await admission.maintenance.register(admission.scopeFor(null))
  const fence = (await admission.maintenance.beginMaintenance(admission.scopeFor(null)))!
  // The legacy metering spelling of General is General for acting turns.
  const refused = run.composeActingTurn('app:u', spec('wake-general', { project_id: 'general' }), { timeout_ms: 1000 })
  await expect(refused).rejects.toBeInstanceOf(ProjectAdmissionRefusedError)
  await expect(run.composeActingTurn('app:u', spec('wake-none'), { timeout_ms: 1000 }))
    .rejects.toThrow('project_fenced')
  // An exact conversation scope wins over the legacy metering id.
  await expect(run.composeActingTurn('app:u:general', spec('wake-literal', { project_id: 'general', conversationProjectId: 'general' }), { timeout_ms: 1000 }))
    .rejects.toThrow('project_unknown')
  expect(g.starts).toEqual([])

  // Control: another project's acting turn proceeds; General does after reopen.
  expect(await run.composeActingTurn('app:u:project-a', spec('wake-a', { project_id: 'project-a' }), { timeout_ms: 1000 }))
    .toBe('reply:wake-a')
  await reopenFrom(admission, fence)
  expect(await run.composeActingTurn('app:u', spec('wake-general', { project_id: 'general' }), { timeout_ms: 1000 }))
    .toBe('reply:wake-general')
  expect(g.scopes).toEqual([
    { project_id: 'project-a', conversationProjectId: 'project-a' },
    { project_id: 'general', conversationProjectId: null },
  ])
  seedProject(db, 'general')
  expect(await run.composeActingTurn('app:u:general', spec('wake-literal', { project_id: 'general', conversationProjectId: 'general' }), { timeout_ms: 1000 }))
    .toBe('reply:wake-literal')
  expect(g.scopes.at(-1)).toEqual({ project_id: 'general', conversationProjectId: 'general' })
  const leases = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM project_admission_leases')
  expect(leases?.n).toBe(0)
})
