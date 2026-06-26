/**
 * Open agent-dispatch prod-boot wiring — the anti-"built-but-not-wired" gate
 * for the general agent-dispatch family (parity gap #3).
 *
 * THE GAP (parity scan §2.F / §5.3): Neutron had the `runtime/subagent/`
 * registry + watchdog PRIMITIVE and a dead-code persona dispatcher
 * (`trident/agent-dispatch.ts`), but NO live surface that dispatches a
 * named/ad-hoc background agent, registers it, spawns it via the substrate,
 * and reports its result back. Every `spawnSubagent`/registry call site was a
 * test.
 *
 * THE FIX: `open/composer.ts` constructs a `DispatchService` over the SAME
 * `buildSubstrateTridentDispatch` closure `/code` uses + threads
 * `agent_dispatch: { service }` onto the returned `CompositionInput`, so
 * `build-core-modules.ts` registers the `dispatch_agent` agent tool.
 *
 * Per CLAUDE.md (the "built but never invoked" incident class) this asserts the
 * wiring ACTUALLY produces a working dispatcher — it boots the REAL Open
 * composer with a SYNTHETIC credential + a MOCKED substrate (no real `claude`,
 * no api.anthropic.com), then dispatches a research agent and proves it spawned
 * on the substrate with the persona folded into the user turn + registered in
 * the shared SubagentRegistry. With NO credential the surface degrades cleanly
 * (unset — no feature flag).
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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-dispatch-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-dispatch-test-secret-0123456789'
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

/** Mocked substrate that records the prompt + answers with a completion. */
function recordingSubstrate(prompts: string[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      prompts.push(spec.prompt)
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: 'Investigated. Findings written to docs/findings.md' }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'mock-dispatch',
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

describe('Open agent-dispatch prod-boot wiring', () => {
  test('a credentialed boot wires composition.agent_dispatch to a working dispatcher', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-dispatch-test'
    const prompts: string[] = []
    const composer = buildOpenGraphComposer({
      env: process.env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      substrateFactory: (() => recordingSubstrate(prompts)) as any,
    })
    const composition = await composer({ db, project_slug: 'owner' })

    // 1) The dispatch service is wired — not unset/dead-code.
    expect(composition.agent_dispatch).toBeDefined()
    const service = composition.agent_dispatch!.service
    expect(typeof service.dispatch).toBe('function')

    // 2) Dispatching a research agent spawns a REAL turn on the substrate with
    //    the Atlas persona folded into the user turn + the task, and registers
    //    it in the shared SubagentRegistry.
    const handle = await service.dispatch({ kind: 'research', task: 'audit the login flow' })
    expect(handle.run_id).toBeTruthy()
    expect(handle.record.agent_kind).toBe('atlas')

    const outcome = await handle.completion
    expect(outcome.status).toBe('finished')
    expect(prompts.some((p) => p.includes('audit the login flow'))).toBe(true)
    // The Atlas persona reached the agent via the user turn (substrate drops system).
    expect(prompts.some((p) => p.includes('Your task:'))).toBe(true)

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)

  test('an LLM-less boot (no credential) leaves composition.agent_dispatch unset (clean degrade)', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })

    expect(composition.agent_dispatch).toBeUndefined()

    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
  }, 20_000)
})
