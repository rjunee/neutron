/**
 * Open skill-forge prod-boot wiring — the anti-"built-but-not-wired" gate for
 * the auto-skillify capability (Vajra→Neutron parity gap #5).
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
 * Per CLAUDE.md (the "built but never invoked" incident class) this boots the
 * REAL Open composer and proves (a) the backend + trigger are threaded, (b) a
 * simulated `done` Trident run flowing through `on_run_terminal` persists a
 * proposal to the per-instance store, (c) a `failed` run does not, and (d) the
 * approve/decline/list surface is wired even on an LLM-less box. No real
 * `claude`, no api.anthropic.com.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { SkillForgeProposalsStore } from '../../skill-forge/proposals-store.ts'
import type { TridentRun } from '../../trident/store.ts'

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
  delete process.env['NOTIFY_SOCKET']
  db = ProjectDb.open(process.env['NEUTRON_DB_PATH'])
  applyMigrations(db.raw())
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
  return {
    id: 'run-skillforge-1',
    slug: 'demo',
    project_slug: 'owner',
    phase: 'done',
    round: 1,
    max_rounds: 5,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 0,
    branch: 'feat/demo',
    pr: 42,
    merge_mode: 'pr',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/tmp/repo',
    worktree: null,
    task: 'scrape a tweet and file the result to the brief',
    chat_id: null,
    thread_id: null,
    channel_kind: 'telegram',
    failure_reason: null,
    workflow_run_id: null,
    inner_checkpoint: null,
    inner_verdict: null,
    started_at: '2026-06-26T00:00:00.000Z',
    last_advanced_at: '2026-06-26T00:01:00.000Z',
    ...overrides,
  }
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

  test('a failed Trident run is NOT skillified (the audit gates on success)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-skillforge-test'
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    await composition.trident!.on_run_terminal!(
      doneRun({ phase: 'failed', failure_reason: 'argus rejected' }),
    )

    const store = new SkillForgeProposalsStore({ db })
    expect((await store.listPending()).length).toBe(0)

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

    cleanup(composition)
  }, 20_000)
})
