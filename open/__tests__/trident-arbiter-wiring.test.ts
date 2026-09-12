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
import { makeTridentRun } from '@neutronai/trident/testing/make-trident-run.ts'
import {
  githubSpawnEnvRef,
  setGithubSpawnEnvResolver,
} from '../../gateway/wiring/substrate-profiles.ts'
import { githubProcessEnv } from '../../github/credential.ts'
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

/** Every spawn the boot performs, by `substrate_instance_id` — the PROFILE's
 *  effect on the environment is only visible here, at the real spawn site. */
const spawned: ClaudeCodeSubstrateOptions[] = []

async function bootComposition(): Promise<
  Awaited<ReturnType<ReturnType<typeof buildOpenGraphComposer>>>
> {
  spawned.length = 0
  const composer = buildOpenGraphComposer({
    env: process.env,
    substrateFactory: (opts: ClaudeCodeSubstrateOptions): Substrate => {
      spawned.push(opts)
      return mockSubstrate(opts.substrate_instance_id)
    },
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

  test('the arbiter spawns WITHOUT a GitHub credential, while the resolver beside it keeps one', async () => {
    // THE PRIVILEGE BOUNDARY, ASSERTED AT THE REAL SPAWN SITE. `arbiter.ts` argues
    // it cannot approve or merge because `FORBIDDEN_OPTION_IDS` keeps those out of
    // its option set. On the DEFAULT profile that argument was false where it
    // counts: `PROFILE_EPHEMERAL` grants `GH_TOKEN` plus a git credential helper,
    // and the turn carries `Bash` under `--dangerously-skip-permissions`, so
    // `gh pr merge` and `git push` were reachable from the PROCESS no matter what
    // the option set said — with only a prompt sentence in between, against
    // evidence that embeds another agent's text.
    //
    // DIFFERENTIAL, on purpose. Asserting only "the arbiter has no token" passes
    // on a boot where NOTHING got a credential (a broken resolver, an unconnected
    // instance), which would retire this guard silently. The resolver is the
    // control: same factory, same boot, same ephemeral shape, and it SHOULD carry
    // the credential because it commits nothing but does work in a real checkout
    // that trident later pushes.
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-arbiter-profile-test'
    // ARM THE CREDENTIAL RESOLVER. A bare test boot has no GitHub credential
    // connected, so EVERY spawn comes back without `GH_TOKEN` — which would make
    // the assertion below pass for the wrong reason and quietly retire this guard.
    // Registering a synthetic resolver is what makes the control meaningful: the
    // credential IS available, and the profile is the only thing deciding who sees
    // it. Restored in the `finally` so no other test inherits it.
    const composition = await bootComposition()
    // ARMED AFTER THE BOOT, because the composer registers its own resolver during
    // composition and an unconnected test instance resolves to nothing — which
    // would make every spawn credential-free and the assertion below pass for the
    // wrong reason, quietly retiring this guard. Overriding it here is what makes
    // the control meaningful: the credential IS available, and the profile is the
    // only thing deciding who sees it. Restored in the `finally`.
    const priorResolver = githubSpawnEnvRef.resolve
    setGithubSpawnEnvResolver(async () => githubProcessEnv('ghs_synthetic_arbiter_token'))
    try {
      const arbitrate = composition.trident?.arbitrate
      const resolve = composition.trident?.resolve_conflict
      expect(typeof arbitrate).toBe('function')
      expect(typeof resolve).toBe('function')

      // The substrate is built lazily, per call, with the run's cwd — so the only
      // way to see what the profile did is to actually invoke the seam.
      await arbitrate!({
        run: makeTridentRun({ id: 'r1', slug: 's', repo_path: tmpDir, task: 't' }),
        repo_path: tmpDir,
        question: 'Does a correct resolution exist?',
        evidence: 'shared.ts still carries markers',
        options: [{ id: 'retry-resolution', description: 'try again' }],
      })
      await resolve!({
        repo_path: tmpDir,
        branch: 'feat-x',
        base_branch: 'main',
        run: makeTridentRun({ id: 'r1', slug: 's', repo_path: tmpDir, task: 't' }),
        conflicted_files: ['shared.ts'],
      })

      const arbiterSpawn = spawned.find((o) => o.substrate_instance_id.startsWith('cc-trident-arbiter'))
      const resolverSpawn = spawned.find((o) => o.substrate_instance_id.startsWith('cc-trident-resolve'))
      expect(arbiterSpawn, 'the arbiter never spawned').toBeDefined()
      expect(resolverSpawn, 'the resolver never spawned').toBeDefined()

      // THE CONTROL: the credential really is available on this boot.
      expect(resolverSpawn!.env?.['GH_TOKEN']).toBeTruthy()
      // THE ASSERTION: and the arbiter does not get it.
      expect(arbiterSpawn!.env?.['GH_TOKEN']).toBeUndefined()
      // Nor the git credential helper that makes a raw `git push` work.
      const arbiterEnvText = JSON.stringify(arbiterSpawn!.env ?? {})
      expect(arbiterEnvText).not.toContain('x-access-token')
      expect(arbiterEnvText).not.toContain('ghs_synthetic_arbiter_token')
    } finally {
      githubSpawnEnvRef.resolve = priorResolver
      cleanup(composition)
    }
  }, 20_000)

  test('the composition layer copies the arbiter onto the orchestrator options', () => {
    // SUPPLEMENTARY, NOT LOAD-BEARING — and that distinction is the point. A
    // source match is green against the line sitting in DEAD CODE, which is
    // exactly the shape of the bug this class of test is supposed to catch
    // (verified: putting the assignment behind `if (false)` leaves this test
    // green). The behavioural guard is
    // `gateway/composition/build-core-modules-trident-arbiter-wiring.test.ts`,
    // which drives the real composed orchestrator to a real merge and asserts the
    // arbiter was CONSULTED. This one is kept only because it names the exact
    // assignment, so deleting the line fails here with a clearer message than a
    // merge that stops consulting an arbiter.
    //
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
