import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore, type TridentRun } from '@neutronai/trident/store.ts'
import { buildTridentDelivery, composeTerminalDelivery, interpretFailure } from '@neutronai/trident/delivery.ts'
import { composeTerminalHook } from '@neutronai/trident/terminal-observer.ts'
import { buildForgeConflictResolver } from '@neutronai/trident/conflict-resolver.ts'
import type { ArbitrationOutcome } from '@neutronai/trident/arbiter.ts'
import { seedMigratedDb } from '../../../tests/support/migrated-db.ts'
import { buildTerminalBuildWakeObserver, type TerminalBuildWakeDeps } from '../terminal-build-wake.ts'

let dir: string, db: ProjectDb, store: TridentRunStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-question-'))
  seedMigratedDb(join(dir, 'project.db'))
  db = ProjectDb.open(join(dir, 'project.db'))
  store = new TridentRunStore(db)
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
async function seed(over: Partial<TridentRun> = {}) {
  const run = await store.create({ slug: 'question', project_slug: 'project', repo_path: '/repo',
    task: 'Resolve behavior', chat_id: 'chat-project', channel_kind: 'app_socket' })
  await store.update(run.id, { phase: 'failed', failure_reason: 'Which behavior should remain?', ...over })
  return store.get(run.id)!
}
function harness(outcome: ArbitrationOutcome = { kind: 'owner-only', question: 'Choose the behavior?' }) {
  const order: string[] = [], prompts: string[] = [], owner: string[] = []
  const deps: TerminalBuildWakeDeps = {
    wakeCompleted: (id) => store.agentWakeCompleted(id),
    claimWake: async (id) => { order.push('complete'); return store.claimAgentWake(id) },
    boardItemIdForRun: async () => null, projectChatScope: () => 'project',
    arbitrate: async () => { order.push('arbiter'); return outcome },
    llm: { compose: async (spec) => { order.push('project'); prompts.push(spec.prompt); return 'Owner: should we preserve the old behavior?' } },
    post: async (run, reply) => { order.push('post'); owner.push(`${run.chat_id}: ${reply}`); return true },
    logger: { error() {} },
  }
  return { deps, order, prompts, owner }
}

for (const family of ['returned-question', 'error-text', 'harvested-escalation', 'resolver-question']) {
  test(`${family}: worker stays data, arbiter first, project can ask in its chat`, async () => {
    let run = await seed()
    if (family === 'error-text') await store.update(run.id, { failure_reason: 'Tool failed: ask owner to retry?' })
    if (family === 'harvested-escalation') await store.update(run.id, { harvested_at: 1, inner_result: JSON.stringify({
      ok: true, verdict: 'REQUEST_CHANGES', blockKind: 'design-gap',
      escalation: { kind: 'design-gap', whatIsMissing: 'Which behavior?', triggers: [], evidence: 'conflicting spec', round: 2 },
    }) })
    if (family === 'resolver-question') {
      const resolve = buildForgeConflictResolver({ build_substrate: () => ({ start: () => ({
        events: (async function* () { yield { kind: 'token' as const, text: 'ESCALATE: Which behavior in handler.ts?' } })(),
        respondToTool: async () => {}, cancel: async () => {}, tool_resolution: 'internal',
      }) }) })
      const result = await resolve({ run, repo_path: '/repo', branch: 'fix', base_branch: 'main', conflicted_files: ['handler.ts'] })
      expect(result.resolved).toBe(false)
      if (result.resolved) throw new Error('resolver lost the question')
      await store.update(run.id, { failure_reason: result.question })
    }
    run = store.get(run.id)!
    const h = harness(), passive: string[] = []
    const hook = composeTerminalHook(buildTridentDelivery({ sink: { send: async (m) => { passive.push(m.text); return 'status' } } }),
      [buildTerminalBuildWakeObserver(h.deps)])
    await hook.onTerminal(run)
    // THE ANNOUNCE IS THE RELOCATION, SPELLED OUT. #796 moves the ASK, not the
    // evidence: the deterministic announce still interprets the failure (#352),
    // and only `input_needed` — the owner-directed "reply to retry" clause — is
    // withheld, because the project decision turn below consults the arbiter
    // before deciding the owner is needed. Asserted as evidence-present AND
    // ask-absent so a stub announce cannot satisfy this pair.
    const interp = interpretFailure(run)
    expect(passive).toHaveLength(1)
    expect(passive[0]).toContain(interp.summary)
    expect(passive[0]).not.toContain(interp.input_needed)
    expect(passive[0]).toBe(composeTerminalDelivery(run, { include_advice: false })!.text)
    // And the ask is not lost — the decision turn receives it in full.
    expect(h.prompts[0]).toContain(interp.input_needed)
    expect(h.order).toEqual(['arbiter', 'project', 'post', 'complete'])
    expect(h.prompts[0]).toContain(JSON.stringify(composeTerminalDelivery(run)))
    expect(h.prompts[0]).toContain('owner-only')
    expect(h.owner).toEqual(['chat-project: Owner: should we preserve the old behavior?'])
    expect(store.listPendingAgentWakes()).toEqual([])
  })
}

test('failed admission survives reopening, false delivery stays pending, success completes', async () => {
  const run = await seed(), h = harness({ kind: 'unavailable', reason: 'offline' })
  h.deps.llm = null
  await buildTerminalBuildWakeObserver(h.deps)(run)
  expect(store.listPendingAgentWakes().map(r => r.id)).toEqual([run.id])
  h.deps.llm = { compose: async () => { throw new Error('project unavailable') } }
  await buildTerminalBuildWakeObserver(h.deps)(run)
  db.close(); db = ProjectDb.open(join(dir, 'project.db')); store = new TridentRunStore(db)
  expect(store.listPendingAgentWakes().map(r => r.id)).toEqual([run.id])
  const retry = harness({ kind: 'decision', option_id: 'investigate', reasoning: 'read the spec' })
  retry.deps.post = async () => false
  await buildTerminalBuildWakeObserver(retry.deps)(store.listPendingAgentWakes()[0]!)
  expect(store.agentWakeCompleted(run.id)).toBe(false)
  retry.deps.post = async () => { throw new Error('owner delivery unavailable') }
  await buildTerminalBuildWakeObserver(retry.deps)(run)
  expect(store.agentWakeCompleted(run.id)).toBe(false)
  retry.deps.post = h.deps.post
  await buildTerminalBuildWakeObserver(retry.deps)(run)
  expect(store.agentWakeCompleted(run.id)).toBe(true)
  expect(store.listPendingAgentWakes()).toEqual([])
})

test('active and completed results cannot start duplicate turns; passive success survives', async () => {
  const run = await seed(), h = harness()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  h.deps.llm = { compose: async () => { h.order.push('project'); await gate; return 'Resolved without owner input.' } }
  const observe = buildTerminalBuildWakeObserver(h.deps)
  const first = observe(run)
  await observe(run)
  release(); await first; await observe(run)
  expect(h.order.filter(x => x === 'project')).toHaveLength(1)
  const sent: string[] = []
  await buildTridentDelivery({ sink: { send: async m => { sent.push(m.text); return 'ok' } } })
    .onTerminal({ ...run, phase: 'done' })
  expect(sent[0]).toContain('merged and deployed')
})


test('arbiter failure reaches the project as unavailable evidence rather than losing the question', async () => {
  const run = await seed(), h = harness()
  h.deps.arbitrate = async () => { throw new Error('arbiter offline') }
  await buildTerminalBuildWakeObserver(h.deps)(run)
  expect(h.prompts[0]).toContain('arbiter offline')
  expect(h.owner).toHaveLength(1)
  expect(store.agentWakeCompleted(run.id)).toBe(true)
})

test('pending selection includes only addressed terminal results, with completed rows excluded', async () => {
  const run = await seed()
  await store.create({ slug: 'active', project_slug: 'project', repo_path: '/repo', task: 'active', chat_id: 'chat' })
  const unaddressed = await store.create({ slug: 'unaddressed', project_slug: 'project', repo_path: '/repo', task: 'unaddressed' })
  await store.update(unaddressed.id, { phase: 'failed' })
  const empty = await store.create({ slug: 'empty-address', project_slug: 'project', repo_path: '/repo', task: 'empty', chat_id: '' })
  await store.update(empty.id, { phase: 'failed' })
  expect(store.listPendingAgentWakes().map(r => r.id)).toEqual([run.id])
  await store.claimAgentWake(run.id)
  expect(store.listPendingAgentWakes()).toEqual([])
})
