/**
 * BYTE-IDENTITY safety net for the tool-security-redesign Step 0 refactor
 * (`docs/plans/tool-security-redesign-2026-07-20.md`, correction #6).
 *
 * The refactor collapses the 8 hand-copied
 * `buildLlmCallSubstrate({ ..., skip_permissions: true })` option bags into
 * named `SubstrateProfile` constants passed as `profile:`. This refactor is
 * BEHAVIOUR-PRESERVING: the RESOLVED `ClaudeCodeSubstrateOptions` handed to the
 * underlying substrate MUST be byte-identical before and after.
 *
 * This test freezes that guarantee two ways:
 *  1. Every profile constant equals `{ skip_permissions: true }` exactly (the
 *     value the 8 sites hand-copied today). A future accidental divergence — or
 *     an early wiring of the reserved permission_mode/sandbox fields — fails here.
 *  2. For EACH of the 8 production call sites, the resolved options produced by
 *     the NEW `profile:` form deep-equal the resolved options produced by the
 *     PRE-REFACTOR inline `skip_permissions: true` form, holding every other
 *     per-call input identical. A refactor that changes any resolved value is a
 *     BUG, not an improvement — and this test is the whole net that catches it.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildLlmCallSubstrate,
  type BuildLlmCallSubstrateInput,
} from '../build-llm-call-substrate.ts'
import {
  PROFILE_TOOLLESS_UTILITY,
  PROFILE_WARM_CHAT,
  PROFILE_PHASE_SPEC,
  PROFILE_ISOLATED_COMPOSE,
  PROFILE_UNTRUSTED_IMPORT,
  PROFILE_EPHEMERAL,
  PROFILE_ARBITER,
  PROFILE_LEAK_FIXER,
  PROFILE_WARM_FIRE,
  type SubstrateProfile,
} from '../substrate-profiles.ts'
// The two pool defaults the fire window is bracketed against — imported from the
// real constants rather than restated, so a change to either is caught here.
import {
  DEFAULT_TURN_ABSOLUTE_CEILING_MS,
  DEFAULT_TURN_INACTIVITY_MS,
} from '@neutronai/runtime/adapters/claude-code/persistent/signatures.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { newCredentialPool, type CredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'neutron-subprof-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

/** Fake substrate factory that captures the composed options per `start()`. */
function captureFactory(): {
  substrateFactory: (opts: ClaudeCodeSubstrateOptions) => Substrate
  seen: Array<ClaudeCodeSubstrateOptions>
} {
  const seen: Array<ClaudeCodeSubstrateOptions> = []
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start(_spec: AgentSpec): SessionHandle {
      seen.push(opts)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield {
          kind: 'completion',
          substrate_instance_id: opts.substrate_instance_id,
          session: { id: 'sess', last_active_at: Date.now() },
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      })()
      return {
        events,
        respondToTool: async () => undefined,
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  })
  return { substrateFactory, seen }
}

function runSpec(): AgentSpec {
  return { prompt: 'hello', tools: [], model_preference: ['claude-opus-4-7'], max_tokens: 100 }
}

function freshPool(): CredentialPool {
  return newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'oauth-1', kind: 'oauth', secret: 'oauth-secret' }],
  })
}

/**
 * Build with `input`, drive one dispatch through the capture factory, and return
 * the single resolved `ClaudeCodeSubstrateOptions` the factory received. Strips
 * the always-present `env` (holds the scrubbed secret — identical for both forms
 * given the same pool, but keeping it out makes the deep-equal about the option
 * bag, not the credential value) and asserts `env` shape separately.
 */
async function resolveOpts(
  input: Omit<BuildLlmCallSubstrateInput, 'substrateFactory' | 'pool'>,
): Promise<ClaudeCodeSubstrateOptions> {
  const { substrateFactory, seen } = captureFactory()
  const sub = buildLlmCallSubstrate({ pool: freshPool(), substrateFactory, ...input })
  expect(sub).not.toBeNull()
  const handle = sub!.start(runSpec())
  for await (const _ev of handle.events) {
    // drain
  }
  expect(seen.length).toBe(1)
  return seen[0]!
}

// ---------------------------------------------------------------------------
// 1. Every profile records its complete security policy.
// ---------------------------------------------------------------------------

const ALL_PROFILES: ReadonlyArray<{ name: string; profile: SubstrateProfile }> = [
  { name: 'PROFILE_TOOLLESS_UTILITY', profile: PROFILE_TOOLLESS_UTILITY },
  { name: 'PROFILE_WARM_CHAT', profile: PROFILE_WARM_CHAT },
  { name: 'PROFILE_PHASE_SPEC', profile: PROFILE_PHASE_SPEC },
  { name: 'PROFILE_ISOLATED_COMPOSE', profile: PROFILE_ISOLATED_COMPOSE },
  { name: 'PROFILE_UNTRUSTED_IMPORT', profile: PROFILE_UNTRUSTED_IMPORT },
  { name: 'PROFILE_EPHEMERAL', profile: PROFILE_EPHEMERAL },
  { name: 'PROFILE_LEAK_FIXER', profile: PROFILE_LEAK_FIXER },
  { name: 'PROFILE_ARBITER', profile: PROFILE_ARBITER },
  { name: 'PROFILE_WARM_FIRE', profile: PROFILE_WARM_FIRE },
]

test('every profile records the expected bypass, confinement, credential, and model policy', () => {
  for (const { name, profile } of ALL_PROFILES) {
    // Exact-object equality makes each security knob fail closed on drift.
    //
    // PROFILE_WARM_FIRE is the single deliberate exception. It is enumerated BY
    // NAME rather than the assertion being relaxed for everyone, so a SECOND
    // profile that starts wiring a field still fails this test — which is the
    // whole reason the test exists.
    // The GitHub grant is part of the frozen shape ON PURPOSE: flipping a
    // profile from `false` to `true` hands every substrate on it push access to
    // the owner's repos, so it must fail here until the change is stated.
    const GRANTS: Record<string, boolean> = {
      PROFILE_TOOLLESS_UTILITY: false,
      PROFILE_WARM_CHAT: true,
      PROFILE_PHASE_SPEC: false,
      PROFILE_ISOLATED_COMPOSE: false,
      PROFILE_UNTRUSTED_IMPORT: false,
      PROFILE_EPHEMERAL: true,
      // The purity-preflight reword turn commits nothing and pushes nothing — the outer
      // preflight does both — so it carries no credential. Flipping this to `true` must fail
      // here until someone states why a reword needs push access to the owner's repos.
      PROFILE_LEAK_FIXER: false,
      // #541 — the arbiter JUDGES; the caller applies every decision. Its whole safety
      // argument is that it cannot approve, merge or waive review, and on a credentialed
      // profile all three were reachable from its Bash regardless of the option set.
      // Flipping this to `true` must fail here until someone states why a read-only judge
      // needs push access to the owner's repos.
      PROFILE_ARBITER: false,
      PROFILE_WARM_FIRE: true,
    }
    // The frontier-model FLOOR is frozen for the same reason the GitHub grant is,
    // pointing the other way: flipping a profile from `true` to `false` is what
    // put the owner's project chat on Haiku for a day, and flipping one from
    // `false` to `true` would silently overrule a caller that picked FAST_MODEL
    // on purpose. Either direction must fail here until it is stated.
    const MODEL_FLOORS: Record<string, boolean> = {
      PROFILE_TOOLLESS_UTILITY: false,
      PROFILE_WARM_CHAT: true,
      PROFILE_PHASE_SPEC: false,
      PROFILE_ISOLATED_COMPOSE: false,
      PROFILE_UNTRUSTED_IMPORT: false,
      PROFILE_EPHEMERAL: false,
      PROFILE_LEAK_FIXER: false,
      PROFILE_ARBITER: false,
      PROFILE_WARM_FIRE: false,
    }
    const github_credential = GRANTS[name]
    expect(github_credential, `${name} has no recorded GitHub grant`).toBeDefined()
    const frontier_model_floor = MODEL_FLOORS[name]
    expect(frontier_model_floor, `${name} has no recorded model floor`).toBeDefined()
    if (name === 'PROFILE_WARM_FIRE') {
      expect({ ...profile }, name).toEqual({
        skip_permissions: false,
        restricted: true,
        permission_mode: 'acceptEdits',
        github_credential: true,
        frontier_model_floor: false,
        turn_inactivity_ms: 30 * 60_000,
      })
      continue
    }
    const isTrident = ['PROFILE_EPHEMERAL', 'PROFILE_LEAK_FIXER', 'PROFILE_ARBITER'].includes(name)
    expect({ ...profile }, name).toEqual({
      skip_permissions: !isTrident,
      ...(isTrident
        ? {
            restricted: true,
            // NOT one value for every Trident profile: the arbiter has no tools, so the
            // mode that denies every would-be prompt costs it nothing; the profiles whose
            // agents must WRITE and RUN are inert under it (measured on claude 2.1.270).
            permission_mode: name === 'PROFILE_ARBITER' ? ('dontAsk' as const) : ('acceptEdits' as const),
          }
        : {}),
      github_credential: github_credential!,
      frontier_model_floor: frontier_model_floor!,
    })
  }
})

/**
 * THE MODE THAT DENIES EVERYTHING IS NOT A SAFE DEFAULT, IT IS AN OFF SWITCH (#630).
 *
 * Measured on the installed `claude` 2.1.270, in a scratch cwd, `--restricted
 * --permission-mode dontAsk --tools Read,Write,Edit,Bash`:
 *
 *   Write  -> "Permission to use Write has been denied because Claude Code is
 *              running in don't ask mode"
 *   Bash   -> the same sentence for Bash
 *
 * — for a file INSIDE the agent's own working directory. So a profile whose agent
 * has to produce anything is INERT under `dontAsk`, and a unit test that only pins
 * the constant cannot see it: every argv assertion still passes while the build
 * lane silently does nothing. That is the failure this case exists to make loud.
 *
 * Under `acceptEdits` the same measurement writes the file and runs the in-cwd
 * shell command with no prompt, and confinement STILL holds: an outside-cwd Read
 * is refused by the CLI ("--restricted confines the file tools to the working
 * directory") and an outside-cwd `cat` is refused by the command gate.
 *
 * Both directions, deliberately: the acting profiles must NOT carry `dontAsk`, and
 * the tool-less arbiter must — otherwise "everything is acceptEdits" would satisfy
 * the first half alone.
 */
test('a profile whose agent must act never carries the mode that denies every tool', () => {
  const MUST_ACT = {
    PROFILE_EPHEMERAL,
    PROFILE_LEAK_FIXER,
    PROFILE_WARM_FIRE,
  } as const
  for (const [name, profile] of Object.entries(MUST_ACT)) {
    expect(profile.restricted, `${name} must stay confined`).toBe(true)
    expect(profile.skip_permissions, `${name} must not bypass`).toBe(false)
    expect(profile.permission_mode, `${name} would be inert under dontAsk`).toBe('acceptEdits')
  }
  // The complement. The arbiter grants NO tools, so the strictest prompt policy
  // costs it nothing — and if this ever relaxes, the reason has to be argued.
  expect(PROFILE_ARBITER.permission_mode).toBe('dontAsk')
  expect(PROFILE_ARBITER.restricted).toBe(true)
  expect(PROFILE_ARBITER.skip_permissions).toBe(false)
})

test('the fire window is BELOW the absolute ceiling, so the ceiling stays the terminal authority', () => {
  // A window at or above the ceiling would make the ceiling unreachable and a
  // wedged launcher effectively immortal — the failure this fix must not cause
  // while removing the one it does.
  expect(PROFILE_WARM_FIRE.turn_inactivity_ms).toBeLessThan(DEFAULT_TURN_ABSOLUTE_CEILING_MS)
  // ...and comfortably ABOVE the default, or it would not fix anything.
  expect(PROFILE_WARM_FIRE.turn_inactivity_ms).toBeGreaterThan(DEFAULT_TURN_INACTIVITY_MS)
})

// ---------------------------------------------------------------------------
// 2. Every enumerated production site resolves its profile onto spawn options.
//    Each entry mirrors one of the 8 production call sites' distinguishing
//    per-call inputs; the ONLY thing that changed at the site was
//    `skip_permissions: true` → `profile: PROFILE_X`.
// ---------------------------------------------------------------------------

const SITES: ReadonlyArray<{
  site: string
  profile: SubstrateProfile
  /** The per-call inputs the site passes ALONGSIDE the security knob. */
  extra: Omit<BuildLlmCallSubstrateInput, 'substrateFactory' | 'pool' | 'profile' | 'skip_permissions'>
}> = [
  {
    site: 'open/composer.ts cc-synthesis (untrusted import)',
    profile: PROFILE_UNTRUSTED_IMPORT,
    extra: { substrate_instance_id: 'cc-synthesis-owner', cwd: '/w', user_id: 'u', project_slug: 'owner' },
  },
  {
    site: 'open/wiring/memory.ts cc-scribe',
    profile: PROFILE_TOOLLESS_UTILITY,
    extra: { substrate_instance_id: 'cc-scribe-owner', cwd: '/w', user_id: 'u', project_slug: 'owner', ephemeral: true },
  },
  {
    site: 'open/wiring/memory.ts cc-reflection',
    profile: PROFILE_TOOLLESS_UTILITY,
    extra: { substrate_instance_id: 'cc-reflection-owner', cwd: '/w', user_id: 'u', project_slug: 'owner', ephemeral: true },
  },
  {
    site: 'open/wiring/memory.ts cc-reflect',
    profile: PROFILE_TOOLLESS_UTILITY,
    extra: { substrate_instance_id: 'cc-reflect-owner', cwd: '/w', user_id: 'u', project_slug: 'owner', ephemeral: true },
  },
  {
    site: 'open/wiring/substrates.ts cc-llm (phase-spec)',
    profile: PROFILE_PHASE_SPEC,
    extra: { substrate_instance_id: 'cc-llm-owner', cwd: '/w', user_id: 'u', project_slug: 'owner' },
  },
  {
    site: 'open/wiring/substrates.ts cc-agent (warm chat)',
    profile: PROFILE_WARM_CHAT,
    extra: { substrate_instance_id: 'cc-agent-owner', cwd: '/w', user_id: 'u', project_slug: 'owner', enableToolBridge: true },
  },
  {
    site: 'open/wiring/substrates.ts makeComposeSubstrate (cc-compose)',
    profile: PROFILE_ISOLATED_COMPOSE,
    extra: { substrate_instance_id: 'cc-compose-owner', cwd: '/w', user_id: 'u', project_slug: 'owner' },
  },
  {
    site: 'open/wiring/substrates.ts makeEphemeralSubstrate (cc-trident)',
    profile: PROFILE_EPHEMERAL,
    extra: { substrate_instance_id: 'cc-trident-owner', cwd: '/w', user_id: 'u', project_slug: 'owner', ephemeral: true },
  },
  {
    site: 'open/composer.ts makeEphemeralSubstrate (cc-trident-leakfix)',
    profile: PROFILE_LEAK_FIXER,
    extra: {
      substrate_instance_id: 'cc-trident-leakfix-owner',
      cwd: '/w',
      user_id: 'u',
      project_slug: 'owner',
      ephemeral: true,
    },
  },
  {
    site: 'open/composer.ts makeEphemeralSubstrate (cc-trident-arbiter)',
    profile: PROFILE_ARBITER,
    extra: {
      substrate_instance_id: 'cc-trident-arbiter-owner',
      cwd: '/w',
      user_id: 'u',
      project_slug: 'owner',
      ephemeral: true,
    },
  },
  {
    site: 'open/wiring/substrates.ts makeWarmFireSubstrate (cc-trident-fire)',
    profile: PROFILE_WARM_FIRE,
    extra: { substrate_instance_id: 'cc-trident-fire-owner-abc', cwd: '/w', user_id: 'u', project_slug: 'owner' },
  },
]

for (const { site, profile, extra } of SITES) {
  test(`resolved security opts match the named profile — ${site}`, async () => {
    const viaProfile = await resolveOpts({ ...extra, profile })
    const viaInline = await resolveOpts({ ...extra, skip_permissions: true })
    // The profile's bypass policy is explicit for every site.
    const isTrident = [PROFILE_EPHEMERAL, PROFILE_LEAK_FIXER, PROFILE_ARBITER, PROFILE_WARM_FIRE].includes(profile)
    expect(viaProfile.skip_permissions).toBe(!isTrident)
    expect(viaInline.skip_permissions).toBe(true)
    // Trident sites deliberately diverge from the legacy bypass control.
    if (isTrident) {
      expect(viaProfile.restricted).toBe(true)
      expect(viaProfile.permission_mode).toBe(profile === PROFILE_ARBITER ? 'dontAsk' : 'acceptEdits')
      expect(viaInline.restricted).toBeUndefined()
      expect(viaInline.permission_mode).toBeUndefined()
    }
    if (profile === PROFILE_WARM_FIRE) {
      expect(viaInline.turn_inactivity_ms).toBeUndefined()
      expect(viaProfile.turn_inactivity_ms).toBe(30 * 60_000)
    } else if (profile === PROFILE_WARM_CHAT) {
      // The owner's chat is the ONLY site that carries the frontier-model floor.
      // If this key ever stops appearing here, the Haiku regression is back.
      expect(viaProfile.frontier_model_floor).toBe(true)
      expect(viaInline.frontier_model_floor).toBeUndefined()
      const { frontier_model_floor, ...rest } = viaProfile
      expect(rest).toEqual(viaInline)
    } else if (!isTrident) {
      expect(viaProfile).toEqual(viaInline)
      // Every OTHER site must be untouched by both applied fields.
      expect(viaProfile.turn_inactivity_ms).toBeUndefined()
      expect(viaProfile.frontier_model_floor).toBeUndefined()
    }
    // Explicit: the reserved fields never leaked onto the resolved options.
    expect('permission_mode' in viaProfile).toBe(isTrident)
    expect('sandbox' in viaProfile).toBe(false)
  })
}

// ---------------------------------------------------------------------------
// 3. Backward compat: the legacy per-call skip_permissions input still works
//    when NO profile is threaded (tests / callers that set it inline).
// ---------------------------------------------------------------------------

test('legacy skip_permissions input still resolves when no profile is supplied', async () => {
  const opts = await resolveOpts({ substrate_instance_id: 'legacy', cwd: '/w', skip_permissions: true })
  expect(opts.skip_permissions).toBe(true)
})

test('a profile skip_permissions value WINS over the legacy inline field', async () => {
  // Contrived (no production site does this) but pins the documented precedence:
  // profile field wins over the legacy per-call input on collision.
  const opts = await resolveOpts({
    substrate_instance_id: 'prec',
    cwd: '/w',
    skip_permissions: false,
    profile: { skip_permissions: true, github_credential: false, frontier_model_floor: false },
  })
  expect(opts.skip_permissions).toBe(true)
})

test('no skip_permissions anywhere ⇒ option is left unset (unchanged default)', async () => {
  const opts = await resolveOpts({ substrate_instance_id: 'none', cwd: '/w' })
  expect('skip_permissions' in opts).toBe(false)
})

// ---------------------------------------------------------------------------
// 4. Executor-mode reminders (plan task 4) — append_system_prompt_file threading.
//    The ritual substrate threads its unattended-executor system prompt file
//    onto ClaudeCodeSubstrateOptions.appendSystemPromptFile; absence keeps the
//    substrate's default (repl-agent-base.md, the chat persona).
//
//    SCOPE (Argus r1): these two tests cover ONLY the build-llm-call-substrate
//    layer against the FAKE capture factory — they prove the value lands on the
//    intermediate ClaudeCodeSubstrateOptions bag, NOT that the REAL default
//    factory forwards it to the spawned argv. That end-to-end wiring (the seam
//    that actually dropped the prompt) is proven in
//    `runtime/adapters/claude-code/persistent/__tests__/append-system-prompt-wiring.test.ts`.
// ---------------------------------------------------------------------------

test('append_system_prompt_file threads onto ClaudeCodeSubstrateOptions.appendSystemPromptFile', async () => {
  const opts = await resolveOpts({
    substrate_instance_id: 'cc-ritual',
    cwd: '/w',
    append_system_prompt_file: '/abs/ritual-agent-base.md',
  })
  expect(opts.appendSystemPromptFile).toBe('/abs/ritual-agent-base.md')
})

test('absent append_system_prompt_file leaves appendSystemPromptFile unset (default persona)', async () => {
  const opts = await resolveOpts({ substrate_instance_id: 'no-append', cwd: '/w' })
  expect('appendSystemPromptFile' in opts).toBe(false)
})
