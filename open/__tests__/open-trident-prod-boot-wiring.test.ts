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
 * THE FIX (Trident v2 + the 2026-06-29 BILLING fix): `open/composer.ts` builds
 * the inner-loop LAUNCHER as ONE turn on the INTERACTIVE persistent-REPL substrate
 * (`buildSubstrateInnerLauncher` over the single-owner credential pool) — the SAME
 * billing-EXEMPT seam chat/dispatch use, NOT a `claude -p` print-mode subprocess
 * (which is API-billed). It threads `trident: { launch_inner_workflow }` onto the
 * returned `CompositionInput`, so `build-core-modules.ts` wires the REAL
 * `buildWorkflowInnerLoop` + `buildTridentOrchestrator` step (the inner loop is a
 * CC Dynamic Workflow, driven to a terminal result by the held-open interactive
 * launcher turn that polls the background `Workflow` to completion).
 *
 * Per CLAUDE.md (the 2026-05-13 "built but never invoked" incident class) this
 * asserts the wiring ACTUALLY produces a working runner — it boots the REAL Open
 * composer with a SYNTHETIC credential, then:
 *   1. `composition.trident.launch_inner_workflow` is a wired function (not
 *      skeleton/stub).
 *   2. INVOKING it routes the turn through the injected substrate factory (the
 *      INTERACTIVE billing-exempt path) — it never spawns a `claude -p` process —
 *      and returns the parsed TRIDENT_RESULT. The live real-run loop is the
 *      end-to-end acceptance; this is the unit-level billing-exempt proof.
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
        // The launcher turn replies with TRIDENT_RESULT (the interactive analogue
        // of the old print-mode stdout); a Forge dispatch turn's contract lines
        // ride alongside so the same recording substrate serves both call sites.
        yield {
          kind: 'token',
          text:
            'built it\nPR_NUMBER=11\nBRANCH=trident/x\nWORKTREE=/repo\nTRIDENT_RESULT={"ok":true,"prNumber":11,"verdict":"APPROVE","round":1}',
        }
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
  test('a credentialed boot wires launch_inner_workflow to the INTERACTIVE substrate (billing-exempt; no claude -p)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-trident-test'
    const prompts: string[] = []
    const composer = buildOpenGraphComposer({
      env: process.env,
      // Mock EVERY substrate the composer builds — including the trident launcher
      // substrate, which now routes through this factory (the INTERACTIVE,
      // billing-exempt path). No real `claude`, and crucially no `claude -p`.
      substrateFactory: ((_opts: { cwd?: string }) => {
        return recordingSubstrate(prompts)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    })
    const composition = await composer({ db, project_slug: 'owner' })

    // The runner is wired — not the skeleton/stub.
    expect(composition.trident).toBeDefined()
    expect(typeof composition.trident!.launch_inner_workflow).toBe('function')

    // INVOKE it: the launcher turn runs on the INJECTED (interactive) substrate —
    // it records a launcher prompt and returns the parsed TRIDENT_RESULT. This is
    // the unit-level proof the inner loop uses the billing-exempt interactive seam,
    // never a `claude -p` subprocess.
    const before = prompts.length
    const res = await composition.trident!.launch_inner_workflow({
      prompt: 'invoke the Workflow tool then reply TRIDENT_RESULT',
      cwd: tmpDir,
      timeout_ms: 60_000,
    })
    expect(prompts.length).toBe(before + 1) // the turn went through the substrate
    expect(res.timed_out).toBe(false)
    expect(res.spawn_error).toBeNull()
    expect(res.exit_code).toBe(0)
    expect(res.stdout).toContain('TRIDENT_RESULT=')

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
