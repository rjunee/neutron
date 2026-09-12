/**
 * #541 — THE ARBITER TIER, asserted where it is actually droppable.
 *
 * `trident/arbiter.ts` was built, unit-tested (`trident/arbiter.test.ts`),
 * exported from `trident/index.ts` and CONSTRUCTED NOWHERE. A whole-tree search
 * for `buildFableArbiter` outside its own test file returned the definition and
 * the re-export and nothing else — 297 lines of shipped-looking gate that no run
 * could ever reach. `trident/arbiter-wiring.test.ts` pins what it does once
 * called; this file pins that it is called, at the three links that have each
 * been independently absent in this repo before (the `resolve_phase_models`
 * lesson — a wiring key the composition INPUT TYPE does not declare is silently
 * dropped, so every piece is green in isolation and the seam ships inert):
 *
 *   1. the REAL Open composer populates `composition.trident.arbitrate` on a
 *      credentialed boot — beside `resolve_conflict`, the resolver it sits ABOVE,
 *      under the same live-credential gating;
 *   2. an LLM-less boot leaves both unset (clean degrade — a rebase conflict
 *      escalates its specific question to the owner, exactly as before);
 *   3. the composition layer copies the key onto the orchestrator options.
 *
 * Link 3 is a SOURCE assertion, scoped to the assignment, following the
 * precedent in `open/__tests__/trident-leak-fixer-wiring.test.ts` and
 * `gateway/__tests__/trident-phase-models-producer.test.ts`: booting the
 * orchestrator needs a live substrate + socket registry, which is a heavy and
 * flaky way to check that one option is copied. Links 1 and 2 are the real boot.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const CORE_MODULES_SRC = readFileSync(
  join(HERE, '..', '..', 'gateway', 'composition', 'build-core-modules.ts'),
  'utf8',
)

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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-arbiter-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-arbiter-test-secret-0123456789'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  // Force the handoff default: never adopt a host `claude` login for this boot.
  process.env['NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH'] = '1'
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

/** A substrate that answers instantly — no real `claude`, no network. */
function mockSubstrate(instanceId: string): Substrate {
  return {
    start(_spec: AgentSpec): SessionHandle {
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: 'ok' }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: instanceId,
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

async function bootComposition(): Promise<
  Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>
> {
  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: (opts: ClaudeCodeSubstrateOptions): Substrate =>
      mockSubstrate(opts.substrate_instance_id),
  })
  return await composer({ db, project_slug: 'owner' })
}

function cleanup(
  composition: Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>,
): void {
  for (const c of composition.realmode_cleanups ?? []) {
    try {
      c()
    } catch {
      /* best-effort */
    }
  }
}

describe('#541 — the Fable arbiter is wired at the Open composition boundary', () => {
  test('a credentialed boot populates arbitrate beside resolve_conflict', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-arbiter-test'
    const composition = await bootComposition()
    try {
      expect(composition.trident).toBeDefined()
      // The resolver this tier sits ABOVE — asserted so a change that keeps one
      // and drops the other is visible here rather than in production.
      expect(typeof composition.trident!.resolve_conflict).toBe('function')
      // THE LINK THIS FILE EXISTS FOR. Without it `buildFableArbiter` has no
      // production call site at all: every merge hold terminates in chat and
      // waits for the owner, which is the measured state issue #541 reports.
      expect(typeof composition.trident!.arbitrate).toBe('function')
    } finally {
      cleanup(composition)
    }
  }, 20_000)

  test('an LLM-less boot leaves both bounded agents unset (clean degrade, not a feature flag)', async () => {
    delete process.env['ANTHROPIC_API_KEY']
    const composition = await bootComposition()
    try {
      // An arbiter cannot run where no agent can. Absent is the SAME path an
      // `{kind:"unavailable"}` verdict takes: the resolver's specific question
      // still reaches the owner, and nothing is blocked or guessed.
      expect(composition.trident?.arbitrate).toBeUndefined()
      expect(composition.trident?.resolve_conflict).toBeUndefined()
    } finally {
      cleanup(composition)
    }
  }, 20_000)

  test('the composition layer copies the arbiter onto the orchestrator options', () => {
    // Scoped to the assignment itself: an unscoped match on the key name passes
    // on the unrelated mention in a comment or a type declaration.
    const src = CORE_MODULES_SRC.split('\n')
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    expect(src.includes('orchestratorOpts.arbitrate = tridentWiring.arbitrate')).toBe(true)
  })
})
