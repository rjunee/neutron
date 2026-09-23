/**
 * Open skill-forge prod-boot wiring — the anti-"built-but-not-wired" gate for
 * the auto-skillify capability (the legacy harness→Neutron parity gap #5).
 *
 * THE GAP (parity scan §2.R / §5.5): the `skill-forge/` package was fully
 * built (audit → distill → propose → approve → register) AND migration 0086
 * created `skill_forge_proposals`, but NOTHING composed it: `open/composer.ts`,
 * `gateway/composition*`, and `trident/` had ZERO references. So a completed
 * Trident workflow was never audited, no proposal ever surfaced, and the
 * owner had no `/skills` surface — auto-skillify was unreachable.
 *
 * THE FIX: `open/composer.ts` constructs a `SkillForge` + its proposals store
 * over the per-instance ProjectDb, then threads onto the returned
 * `CompositionInput`:
 *   1. `skill_forge: { backend }`  → `build-core-modules.ts` registers the
 *                                    `skill_forge_*` MCP tools.
 *   2. `trident.on_run_terminal`   → the Trident terminal hook fires
 *                                    `onWorkflowCompleted` on a `done` run (the
 *                                    auto-propose TRIGGER).
 * (The `/skills` chat-command filter is chained into `buildLandingStack` and
 * exercised at the unit level in `skill-forge/command.test.ts`; the MCP tool
 * registration in `skill-forge/tool.test.ts`.)
 *
 * THE SECOND GAP — PROPOSALS WERE NEVER DELIVERED. Wiring the trigger made
 * proposals get CREATED; it did not make the owner learn of one. The composer's
 * notifier was a lone `log.info('skill_forge_proposal')`, so the system watched
 * him work, noticed a pattern, drafted an offer, persisted it, and told nobody —
 * the only way to see a proposal was to type `/skills`, i.e. to already suspect
 * one existed. The fix posts it through `deliver` (`gateway/http/deliver.ts`,
 * the ONE out-of-turn delivery seam) as a durable button-backed reply.
 *
 * WHY THE DELIVERY TEST ASSERTS A DURABLE ROW AND NOT A SPY. "The notifier was
 * called" is exactly what the broken version also satisfied — it called a
 * function that logged. So the assertion here is the OUTCOME: after a `done` run,
 * the proposal message is a real durable button prompt in the owner's
 * `app:<owner>` chat topic. Delete the `deliver(...)` call from
 * the composer's notifier and this test fails (mutation-verified), because no row
 * exists. Note there is NO live socket in this test — which is the point of
 * a durable reply over `'none'`: nobody is connected when a Trident run finishes, and
 * the proposal must still be there when he next opens the app.
 *
 * Per CLAUDE.md (the "built but never invoked" incident class) this boots the
 * REAL Open composer and proves (a) the backend + trigger are threaded, (b) a
 * simulated `done` Trident run flowing through `on_run_terminal` persists a
 * proposal to the per-instance store, (c) the proposal is DELIVERED into the
 * owner's durable chat history with the decide-able detail in it, (d) a `failed`
 * run does not, and (e) the approve/decline/list surface is wired even on an
 * LLM-less box, which still never delivers anything. No real `claude`, no
 * api.anthropic.com.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { SkillForgeProposalsStore } from '@neutronai/skill-forge/proposals-store.ts'
import { SYSTEM_SPEAKER_USER_ID } from '@neutronai/channels/button-store.ts'
import { appWsTopicId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'
import { SupervisedLoop } from '@neutronai/loop'
import type { Event } from '@neutronai/runtime/events.ts'
import { TridentRunStore, type TridentRun } from '@neutronai/trident/store.ts'
import { makeTridentRun } from '@neutronai/trident/testing/make-trident-run.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let db: ProjectDb

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-skillforge-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-skillforge-test-secret-0123456789'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1' // force handoff default: ignore any host `claude` login (#101 Keychain probe)
  delete process.env['NOTIFY_SOCKET']
  seedMigratedDb(process.env['NEUTRON_DB_PATH'])
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH'])
})

afterEach(() => {
  db.close()
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

function cleanup(composition: { realmode_cleanups?: Array<() => void> }): void {
  for (const fn of composition.realmode_cleanups ?? []) {
    try {
      fn()
    } catch {
      /* best-effort */
    }
  }
}

/** A skill-worthy `done` Trident run (multi-step, distinct actions, succeeded). */
function doneRun(overrides: Partial<TridentRun> = {}): TridentRun {
  return makeTridentRun({
    id: 'run-skillforge-1',
    slug: 'demo',
    project_slug: 'owner',
    phase: 'done',
    max_rounds: 5,
    max_task_iterations: 0,
    branch: 'feat/demo',
    pr: 42,
    merge_mode: 'pr',
    execution_strategy: 'single',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/tmp/repo',
    task: 'scrape a tweet and file the result to the brief',
    started_at: '2026-06-26T00:00:00.000Z',
    last_advanced_at: '2026-06-26T00:01:00.000Z',
    ...overrides,
  })
}

/** Skill Forge prompts in the bare owner topic the live client binds and hydrates. */
function skillForgePromptsInOwnerChat(): Array<{ body: string; options_json: string }> {
  return db
    .raw()
    .query<{ body: string; options_json: string }, [string, string]>(
      `SELECT body, options_json FROM button_prompts
        WHERE topic_id = ? AND idempotency_key LIKE ?
        ORDER BY created_at ASC`,
    )
    .all(appWsTopicId(OWNER_USER_ID), 'skill-forge-proposal:%')
}

/** System-authored turns in the owner topic — what the project decision turn posts. */
function systemTurnsInOwnerChat(): Array<{ body: string }> {
  return db
    .raw()
    .query<{ body: string }, [string, string]>(
      `SELECT body FROM button_prompts
        WHERE topic_id = ? AND resolution_speaker_user_id = ?
        ORDER BY created_at ASC`,
    )
    .all(appWsTopicId(OWNER_USER_ID), SYSTEM_SPEAKER_USER_ID)
}

describe('Open skill-forge prod-boot wiring (parity gap #5)', () => {
  test('a credentialed boot threads skill_forge.backend + the trident auto-propose trigger', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-skillforge-test'
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    // 1) The backend (which drives the MCP-tool registration) is wired.
    expect(composition.skill_forge).toBeDefined()
    expect(typeof composition.skill_forge!.backend.listPending).toBe('function')

    // 2) The auto-propose trigger is the Trident terminal hook.
    expect(composition.trident).toBeDefined()
    expect(typeof composition.trident!.on_run_terminal).toBe('function')

    cleanup(composition)
  }, 20_000)

  test('a done Trident run flowing through on_run_terminal persists a proposal', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-skillforge-test'
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    await composition.trident!.on_run_terminal!(doneRun())

    // The store is the source of truth — the proposal is persisted.
    const store = new SkillForgeProposalsStore({ db })
    const pending = await store.listPending()
    expect(pending.length).toBe(1)
    expect(pending[0]!.workflow.intent).toBe('scrape a tweet and file the result to the brief')

    // And the SAME backend the composer wired surfaces it.
    const listed = await composition.skill_forge!.backend.listPending()
    expect(listed.map((p) => p.id)).toContain(pending[0]!.id)

    cleanup(composition)
  }, 20_000)

  test('the proposal is DELIVERED as a durable turn in the owner chat, with no client connected', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-skillforge-test'
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    // Nothing has spoken into the owner's chat yet.
    expect(skillForgePromptsInOwnerChat().length).toBe(0)

    await composition.trident!.on_run_terminal!(doneRun())

    // THE BAR: the proposal ARRIVED. Not "the notifier ran" — the broken version
    // also ran a notifier. A durable button prompt exists in the topic the client
    // hydrates. Removing the `deliver(...)` call from the composer's skill-forge
    // notifier makes this line fail with 0 rows.
    const turns = skillForgePromptsInOwnerChat()
    expect(turns.length).toBe(1)

    // It is the PROPOSAL, and it carries enough to decide without hunting: what
    // was noticed, what is proposed, and the working approve/decline surface.
    const store = new SkillForgeProposalsStore({ db })
    const [proposal] = await store.listPending()
    const body = turns[0]!.body
    expect(body).toContain('Skill Forge')
    expect(body).toContain(proposal!.proposed_name)
    expect(body).toContain(proposal!.what_it_does)
    for (const trigger of proposal!.triggers) expect(body).toContain(trigger)
    // The instruction must name the surface that actually decides it — the
    // `/skills` command filter — and quote this proposal's own id, so there is
    // no `/skills list` round-trip just to find the handle.
    expect(body).toContain(`/skills approve ${proposal!.id}`)
    expect(body).toContain(`/skills decline ${proposal!.id}`)
    const options = JSON.parse(turns[0]!.options_json) as Array<{ label: string; value: string }>
    expect(options.map((option) => option.label)).toEqual(['Approve', 'Edit', 'Decline'])
    expect(options.every((option) => option.value.startsWith('sfp:'))).toBe(true)

    cleanup(composition)
  }, 20_000)

  test('the project can offer a persisted skill after receiving the worker result', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-skillforge-test'
    let sweep: SupervisedLoop | undefined
    const start = SupervisedLoop.prototype.start
    const capture = spyOn(SupervisedLoop.prototype, 'start').mockImplementation(function(this: SupervisedLoop) {
      if (this.describe().name === 'terminal-build-decisions') sweep = this
      return start.call(this)
    })
    const composition = await buildOpenGraphComposer({ env: process.env, substrateFactory: () => ({
      start: (spec) => ({
        events: (async function* (): AsyncGenerator<Event> {
          expect(spec.prompt).toContain('skill_forge_list')
          const proposals = await new SkillForgeProposalsStore({ db }).listPending()
          expect(proposals).toHaveLength(1)
          yield { kind: 'token', text: `Project asks: save ${proposals[0]!.proposed_name}?` }
          yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'mock' }
        })(), respondToTool: async () => {}, cancel: async () => {}, tool_resolution: 'internal',
      }),
    }) })({ db, project_slug: 'owner' })
    capture.mockRestore()
    try {
      const runs = new TridentRunStore(db)
      const run = await runs.create({ slug: 'skill-question', project_slug: 'owner', repo_path: '/tmp/repo',
        task: doneRun().task, chat_id: appWsTopicId(OWNER_USER_ID), channel_kind: 'app_socket' })
      expect(await runs.selectExecutionStrategy(run.id, {
        strategy: 'single', rationale: 'One coherent workflow.',
        plan: JSON.stringify({ strategy: 'single', implementationPlan: '- [x] Complete workflow' }),
      })).toEqual({ kind: 'allow' })
      await runs.update(run.id, { phase: 'done' })
      await composition.trident!.on_run_terminal!(runs.get(run.id)!)
      expect(systemTurnsInOwnerChat()).toEqual([])
      await sweep!.runOnce()
      const proposals = await composition.skill_forge!.backend.listPending()
      expect(systemTurnsInOwnerChat().map(r => r.body)).toEqual([`Project asks: save ${proposals[0]!.proposed_name}?`])
      expect(runs.agentWakeCompleted(run.id)).toBe(true)
    } finally {
      for (const stop of composition.realmode_cleanups ?? []) await stop()
    }
  }, 20_000)

  test('a re-run of the SAME workflow re-notifies zero times (one offer, not one per run)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-skillforge-test'
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    // Three terminal `done` runs of the same workflow. The signature dedupe in
    // `SkillForge.onWorkflowCompleted` returns early on 2 and 3, leaving one
    // pending proposal for the project conversation.
    await composition.trident!.on_run_terminal!(doneRun({ id: 'run-1' }))
    await composition.trident!.on_run_terminal!(doneRun({ id: 'run-2' }))
    await composition.trident!.on_run_terminal!(doneRun({ id: 'run-3' }))

    const store = new SkillForgeProposalsStore({ db })
    expect((await store.listPending()).length).toBe(1)
    expect(skillForgePromptsInOwnerChat().length).toBe(1)

    cleanup(composition)
  }, 30_000)

  test('a failed Trident run is NOT skillified (the audit gates on success)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-skillforge-test'
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    await composition.trident!.on_run_terminal!(
      doneRun({ phase: 'failed', failure_reason: 'argus rejected' }),
    )

    const store = new SkillForgeProposalsStore({ db })
    expect((await store.listPending()).length).toBe(0)
    // No proposal ⇒ nothing delivered. Delivery hangs off the proposal, so the
    // owner is never pinged about a workflow that failed.
    expect(skillForgePromptsInOwnerChat().length).toBe(0)

    cleanup(composition)
  }, 20_000)

  test('an LLM-less boot still exposes the skill-forge surface (approve works offline)', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    // No credential → no Trident dispatch → no auto-propose trigger…
    expect(composition.trident).toBeUndefined()
    // …but the approve/decline/list surface is still wired (no feature flag).
    expect(composition.skill_forge).toBeDefined()
    const backend = composition.skill_forge!.backend

    // Seed a pending proposal directly, then approve it through the backend —
    // proving the skill file lands on disk with no LLM in the loop.
    const store = new SkillForgeProposalsStore({ db })
    const seeded = await store.create({
      workflow_signature: 'sig-offline',
      project_slug: 'owner',
      proposed_name: 'offline-demo',
      triggers: ['do the offline demo'],
      what_it_does: 'a seeded offline proposal',
      artifacts: [],
      workflow: {
        project_slug: 'owner',
        intent: 'offline demo',
        steps: [{ action: 'a' }, { action: 'b' }],
        artifacts: [],
        succeeded: true,
      },
    })
    const result = await backend.approve(seeded.id)
    expect(existsSync(result.skill_path)).toBe(true)
    expect(result.proposal.status).toBe('approved')

    // …and the delivery change does NOT alter the LLM-less case. No Trident
    // dispatch ⇒ no `done` run ⇒ no auto-propose ⇒ nothing to deliver. Approving
    // a hand-seeded proposal is a decision, not a new offer, so it posts nothing
    // either: the owner's chat stays silent on a box with no credential.
    expect(skillForgePromptsInOwnerChat().length).toBe(0)

    cleanup(composition)
  }, 20_000)
})
