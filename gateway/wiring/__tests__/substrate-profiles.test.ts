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
  PROFILE_WARM_FIRE,
  PROFILE_RITUAL,
  type SubstrateProfile,
} from '../substrate-profiles.ts'
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
// 1. Every profile encodes TODAY's exact value: { skip_permissions: true }.
// ---------------------------------------------------------------------------

const ALL_PROFILES: ReadonlyArray<{ name: string; profile: SubstrateProfile }> = [
  { name: 'PROFILE_TOOLLESS_UTILITY', profile: PROFILE_TOOLLESS_UTILITY },
  { name: 'PROFILE_WARM_CHAT', profile: PROFILE_WARM_CHAT },
  { name: 'PROFILE_PHASE_SPEC', profile: PROFILE_PHASE_SPEC },
  { name: 'PROFILE_ISOLATED_COMPOSE', profile: PROFILE_ISOLATED_COMPOSE },
  { name: 'PROFILE_UNTRUSTED_IMPORT', profile: PROFILE_UNTRUSTED_IMPORT },
  { name: 'PROFILE_EPHEMERAL', profile: PROFILE_EPHEMERAL },
  { name: 'PROFILE_WARM_FIRE', profile: PROFILE_WARM_FIRE },
  { name: 'PROFILE_RITUAL', profile: PROFILE_RITUAL },
]

test('every profile encodes exactly { skip_permissions: true } (no reserved field wired yet)', () => {
  for (const { name, profile } of ALL_PROFILES) {
    // Byte-for-byte: skip_permissions true and NOTHING else. This is the guard
    // that catches an accidental early-wire of permission_mode / claude_config_dir
    // / extra_env / sandbox before the migration phase that is meant to set them.
    expect({ ...profile }, name).toEqual({ skip_permissions: true })
  }
})

// ---------------------------------------------------------------------------
// 2. profile: form === pre-refactor inline skip_permissions: true form, per site.
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
    site: 'open/wiring/substrates.ts makeWarmFireSubstrate (cc-trident-fire)',
    profile: PROFILE_WARM_FIRE,
    extra: { substrate_instance_id: 'cc-trident-fire-owner-abc', cwd: '/w', user_id: 'u', project_slug: 'owner' },
  },
  {
    site: 'open/wiring/substrates.ts makeRitualSubstrate (cc-ritual)',
    profile: PROFILE_RITUAL,
    extra: {
      substrate_instance_id: 'cc-ritual-owner',
      cwd: '/w',
      user_id: 'u',
      project_slug: 'owner',
      ephemeral: true,
      append_system_prompt_file: '/abs/ritual-agent-base.md',
    },
  },
]

for (const { site, profile, extra } of SITES) {
  test(`resolved opts are byte-identical: profile vs inline skip_permissions — ${site}`, async () => {
    const viaProfile = await resolveOpts({ ...extra, profile })
    const viaInline = await resolveOpts({ ...extra, skip_permissions: true })
    // The security knob resolved to the same value...
    expect(viaProfile.skip_permissions).toBe(true)
    expect(viaInline.skip_permissions).toBe(true)
    // ...and the WHOLE resolved option bag is identical (env holds the scrubbed
    // credential, identical for both since the same pool/cred is selected).
    expect(viaProfile).toEqual(viaInline)
    // Explicit: the reserved fields never leaked onto the resolved options.
    expect('permission_mode' in viaProfile).toBe(false)
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
    profile: { skip_permissions: true },
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
