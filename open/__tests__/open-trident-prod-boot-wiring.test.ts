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
 * THE FIX (Trident v2): `open/composer.ts` builds a dedicated per-worktree
 * `cc-trident-*` substrate FACTORY and threads
 * `trident: { build_substrate }` onto the returned `CompositionInput`, so
 * `build-core-modules.ts` wires the REAL `buildWorkflowInnerLoop` +
 * `buildTridentOrchestrator` step (the inner loop is now a CC Dynamic Workflow).
 *
 * Per CLAUDE.md (the 2026-05-13 "built but never invoked" incident class) this
 * asserts the wiring ACTUALLY produces a working runner — it boots the REAL Open
 * composer with a SYNTHETIC credential (so the substrates are built) + a MOCKED
 * substrate (no real `claude`, no api.anthropic.com), then:
 *   1. `composition.trident.build_substrate` is a wired function (not skeleton/stub).
 *   2. Invoking it builds a FRESH substrate rooted at the given worktree cwd and
 *      a turn on it runs (the launcher would invoke the Workflow tool here).
 *   3. With NO credential the runner degrades cleanly: `composition.trident` is
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
  test('a credentialed boot wires composition.trident.build_substrate to a REAL per-worktree substrate factory', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-trident-test'
    const prompts: string[] = []
    // Capture the cwd the composer threads into each substrate build — the
    // `ClaudeCodeSubstrateOptions.cwd` `buildLlmCallSubstrate` composes from the
    // per-call `build_substrate(cwd)` factory.
    const builtCwds: string[] = []
    const composer = buildOpenGraphComposer({
      env: process.env,
      substrateFactory: ((opts: { cwd?: string }) => {
        builtCwds.push(opts.cwd ?? '<none>')
        return recordingSubstrate(prompts)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    })
    const composition = await composer({ db, project_slug: 'owner' })

    // 1) The runner is wired — not the skeleton/stub. v2 threads a per-worktree
    //    substrate FACTORY (the launcher invokes the Workflow tool on it).
    expect(composition.trident).toBeDefined()
    expect(typeof composition.trident!.build_substrate).toBe('function')

    // 2) Invoking the factory + running a turn builds a FRESH substrate rooted at
    //    the given worktree cwd (the underlying `buildLlmCallSubstrate` invokes the
    //    backing factory lazily at start()), and the turn runs against the mocked
    //    backend (NOT a CodegenNotConfiguredError).
    const builtBefore = builtCwds.length
    const worktreeA = join(tmpDir, 'worktrees', 'run-a')
    const subA = composition.trident!.build_substrate(worktreeA)
    let saw = ''
    for await (const ev of subA.start({ prompt: 'LAUNCH: drive the workflow', tools: [], model_preference: [] }).events) {
      if (ev.kind === 'token') saw += ev.text
    }
    expect(saw).toContain('PR_NUMBER=11')
    expect(prompts.some((p) => p.includes('LAUNCH: drive the workflow'))).toBe(true)
    expect(builtCwds.length).toBeGreaterThan(builtBefore)
    expect(builtCwds.slice(builtBefore)).toContain(worktreeA)

    // A second worktree re-roots again (per-build isolation, never a fixed cwd).
    const worktreeB = join(tmpDir, 'worktrees', 'run-b')
    const subB = composition.trident!.build_substrate(worktreeB)
    for await (const ev of subB.start({ prompt: 'LAUNCH: another run', tools: [], model_preference: [] }).events) {
      void ev
    }
    expect(builtCwds).toContain(worktreeB)

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

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)
})
