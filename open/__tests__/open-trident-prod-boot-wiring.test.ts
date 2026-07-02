/**
 * Open foundational-Trident prod-boot wiring — the anti-"built-but-not-wired"
 * gate for the `/code <task>` autonomous build runner.
 *
 * THE GAP (Trident-port, this PR): `cores/free/code-gen/src/backend.ts` throws
 * `CodegenNotConfiguredError` because the production runner was never wired into
 * prod boot — the Open composer never set `CompositionInput.trident`, so the
 * trident tick loop fell back to `stubAdvanceDeps()` (advances nothing) and
 * `/code` could not dispatch a real build.
 *
 * THE FIX (Trident v2 · Phase 2a exec-model): `open/composer.ts` builds a warm
 * FIRE seam (`buildSubstrateWorkflowFire`, over a non-ephemeral `cc-trident-fire-*`
 * substrate on the single-owner credential pool) and threads
 * `trident: { fire_inner_workflow }` onto the returned `CompositionInput`, so
 * `build-core-modules.ts` wires the REAL `buildWorkflowFirer` +
 * `buildTridentOrchestrator` step (the inner loop is a CC Dynamic Workflow, FIRED
 * on the warm substrate + harvested from the DB — billing-exempt, no `claude -p`).
 *
 * Per CLAUDE.md (the 2026-05-13 "built but never invoked" incident class) this
 * asserts the wiring ACTUALLY produces a working runner — it boots the REAL Open
 * composer with a SYNTHETIC credential, then:
 *   1. `composition.trident.fire_inner_workflow` is a wired function (not
 *      skeleton/stub). The live `Workflow`-fire exercise is the real-run
 *      acceptance, not this unit test.
 *   2. With NO credential the runner degrades cleanly: `composition.trident` is
 *      unset (the loop stays on its restart-safe no-op).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { AgentSpec, Substrate } from '../../runtime/substrate.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'
import type { Event } from '../../runtime/events.ts'

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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-trident-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-trident-test-secret-0123456789'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1' // force handoff default: ignore any host `claude` login (#101 Keychain probe)
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

/** Mocked substrate shared across every substrate the composer builds. Records
 *  the prompt it was handed and answers with a Forge-contract-shaped completion
 *  so a dispatched Trident turn returns deterministic terminal text. */
function recordingSubstrate(prompts: string[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      prompts.push(spec.prompt)
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: 'built it\nPR_NUMBER=11\nBRANCH=trident/x\nWORKTREE=/repo' }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock-trident',
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {
          throw new Error('mock substrate: no external tools')
        },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

describe('Open foundational-Trident prod-boot wiring', () => {
  test('a credentialed boot wires composition.trident.fire_inner_workflow to a REAL warm-substrate fire seam', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-trident-test'
    const prompts: string[] = []
    const composer = buildOpenGraphComposer({
      env: process.env,
      // Mock every substrate the composer builds (no real `claude`) — including
      // the warm `cc-trident-fire-*` substrate the fire seam runs its launching
      // turn on.
      substrateFactory: ((_opts: { cwd?: string }) => {
        return recordingSubstrate(prompts)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    })
    const composition = await composer({ db, project_slug: 'owner' })

    // The runner is wired — not the skeleton/stub. Phase 2a threads a warm
    // FIRE seam that invokes the `Workflow` tool + settles the launching turn;
    // the workflow's result is harvested from the DB. The fire closure is built
    // eagerly (no turn until a real run), so a credentialed boot exposes it as a
    // function. The live `Workflow`-fire round-trip is the real-run acceptance,
    // not this unit test.
    expect(composition.trident).toBeDefined()
    expect(typeof composition.trident!.fire_inner_workflow).toBe('function')

    // Phase 2b — the agent-native board-bound build dispatch is wired on the
    // SAME credential gate, backed by a TridentRunStore + the shared board.
    // Reachability (anti "built-but-not-wired"): boot → create a ready Plan item
    // → dispatch via the wired surface → a code_trident_runs row exists, BOUND.
    expect(composition.trident_build_dispatch).toBeDefined()
    const tbd = composition.trident_build_dispatch!
    expect(typeof tbd.repo_path).toBe('string')
    const { dispatchBoardBoundBuild } = await import('../../trident/board-dispatch.ts')
    const { WorkBoardStore } = await import('../../work-board/store.ts')
    const board = new WorkBoardStore(db)
    const item = await board.create('owner', {
      title: 'wire the export button to the new CSV endpoint with tests',
    })
    const res = await dispatchBoardBoundBuild(
      { board_item_id: item.id, task: 'build the export' },
      {
        store: tbd.store,
        board: tbd.work_board,
        project_slug: 'owner',
        repo_path: tbd.repo_path,
        resolveMergeMode: async () => 'local',
        resolveRalph: async () => false,
      },
    )
    expect(res.ok).toBe(true)
    // The run row exists and the Plan item is bound (fork ⑂ lit).
    expect(board.get('owner', item.id)?.linked_run_id).toBe(res.ok ? res.run.id : '')
    expect(board.get('owner', item.id)?.status).toBe('in_progress')

    // Part B — the Connect Codex surface + agent-tool service are wired, and the
    // trident loop threads the per-project CODEX_HOME (resolveCodexHome). Anti
    // "built-but-not-wired": connect a subscription auth via the wired service →
    // status connected + the loop's codex_home points at the same materialized dir.
    expect(composition.app_codex_credential_surface).toBeDefined()
    expect(composition.codex_credential).toBeDefined()
    expect(typeof composition.trident!.codex_home).toBe('string')
    const codexSvc = composition.codex_credential!.service
    const connect = await codexSvc.connect(
      'owner',
      JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' }, last_refresh: 'x' }),
    )
    expect(connect.ok).toBe(true)
    expect(codexSvc.status('owner').status).toBe('connected')

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)

  test('an LLM-less boot (no credential) leaves composition.trident unset (clean degrade)', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    expect(composition.trident).toBeUndefined()
    expect(composition.trident_build_dispatch).toBeUndefined()

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)
})
