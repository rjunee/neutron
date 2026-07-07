/**
 * Sprint: LLM-driven onboarding prompts (2026-05-09).
 *
 * 2026-05-31 (sprint cc-substrate-migration-3-sites) — migrated from
 * fetch-mock-based tests to a `fakeSubstrate(...)` helper. The composer
 * no longer takes raw `apiKeys` + `api_base_url` + `httpFetch`; it
 * accepts a pre-built `Substrate` from `buildLlmCallSubstrate(...)`
 * and dispatches every call through it. Header-shape concerns (Bearer
 * vs x-api-key) moved one layer down into `build-llm-call-substrate.ts`'s
 * spawn-env logic and are tested there. The wire-up tests here pin:
 *   - the substrate is invoked once per LLM call
 *   - `spec.prompt` packs `<system>\n\n<user>`
 *   - typing-indicator wiring (web vs telegram topic)
 *   - persona / conventions / escalation splicing composition
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAnthropicLlmCall,
  buildPhaseSpecResolver,
} from '../build-phase-spec-resolver.ts'
import { PersonaPromptLoader } from '../persona-loader.ts'
import { CommentStore } from '../../comments/comment-store.ts'
import {
  InMemoryWebChatSenderRegistry,
  type WebChatSenderRegistry,
} from '../../http/chat-bridge.ts'
import type { ChatOutbound } from '../../../landing/server.ts'
import { _resetSkillsLoaderCache } from '../skills-loader.ts'
import type { Substrate, AgentSpec } from '../../../runtime/substrate.ts'
import type { Event } from '../../../runtime/events.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'

let tmp: string

beforeEach(() => {
  _resetSkillsLoaderCache()
  tmp = mkdtempSync(join(tmpdir(), 'neutron-resolver-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// ─── fakeSubstrate helper ───────────────────────────────────────────────────
//
// The production code path is now:
//   buildPhaseSpecResolver({ substrate, ... }) → buildAnthropicLlmCall →
//   substrate.start(spec) → SessionHandle → collectTokensToString → string
//
// The Substrate interface is small enough to stub directly here without
// going through `createClaudeCodeSubstrate` (that path is exercised by
// build-import-substrate.test.ts via spawnImpl). The fake captures every
// AgentSpec it sees so tests can assert on the rendered `spec.prompt`
// (system + user packed verbatim per build-phase-spec-resolver.ts).

interface FakeSubstrateOptions {
  /** Sequence of events the next start() call will yield. Default: a
   *  single token+completion sequence with the supplied responseText. */
  events?: Event[]
  /** Convenience: produces a token+completion sequence yielding this text. */
  responseText?: string
  /** Capture each spec passed to start() for assertion. */
  capturedSpecs?: AgentSpec[]
  /** When set, start() throws synchronously to test caller-side handling. */
  throwOnStart?: Error
  /** Default substrate_instance_id on the completion event. */
  substrate_instance_id?: string
  /** When supplied, returns DIFFERENT events on each successive call so
   *  tests that exercise multiple resolver invocations can pin per-turn
   *  shape. Default: every call yields the same `events` / `responseText`. */
  perCallResponses?: string[]
}

function fakeSubstrate(opts: FakeSubstrateOptions = {}): Substrate {
  let callIndex = 0
  return {
    start(spec: AgentSpec): SessionHandle {
      if (opts.throwOnStart !== undefined) throw opts.throwOnStart
      opts.capturedSpecs?.push(spec)
      let ev: Event[]
      if (opts.events !== undefined) {
        ev = opts.events
      } else {
        let text: string
        if (opts.perCallResponses !== undefined) {
          text = opts.perCallResponses[callIndex] ?? opts.perCallResponses[opts.perCallResponses.length - 1] ?? ''
        } else {
          text = opts.responseText ?? JSON.stringify({ body: 'hi' })
        }
        ev = [
          { kind: 'token', text },
          {
            kind: 'completion',
            usage: { input_tokens: 1, output_tokens: 1 },
            substrate_instance_id: opts.substrate_instance_id ?? 'fake-substrate',
          },
        ]
      }
      callIndex += 1
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        for (const e of ev) yield e
      })()
      return {
        events,
        respondToTool: async (): Promise<void> => {
          throw new Error('fake substrate: respondToTool unused')
        },
        cancel: async (): Promise<void> => {
          /* no-op */
        },
        tool_resolution: 'internal',
      }
    },
  }
}

describe('buildPhaseSpecResolver', () => {
  // 2026-05-12 sprint — default policy: LLM-on for every eligible phase
  // when both env vars are unset. Post-K11b1 the env opt-out gate
  // (NEUTRON_LLM_ONBOARDING_DEFAULT/_PHASES) is gone — the factory now
  // returns null ONLY when no substrate is supplied (the caller passed
  // `substrate: null` because no Anthropic credentials were resolvable
  // for the instance at composer-boot time).

  test('returns a working resolver when env vars are unset (new default-on policy)', async () => {
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({ responseText: JSON.stringify({ body: 'hi' }) }),
      env: {
        // Both NEUTRON_LLM_ONBOARDING_PHASES and _DEFAULT unset; the new
        // default rolls every phase in.
      },
    })
    expect(resolver).not.toBeNull()
  })

  test('returns null when substrate is null (no Anthropic credentials resolvable)', async () => {
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: null,
      env: { NEUTRON_LLM_ONBOARDING_PHASES: 'signup' },
    })
    expect(resolver).toBeNull()
  })

  test('returns a working resolver when explicit phase list is set + substrate is wired', async () => {
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({ responseText: JSON.stringify({ body: 'hi' }) }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
    })
    expect(resolver).not.toBeNull()
  })
})

describe('buildAnthropicLlmCall', () => {
  test('packs <system>\\n\\n<user> into spec.prompt and dispatches via substrate', async () => {
    const capturedSpecs: AgentSpec[] = []
    const llm = buildAnthropicLlmCall({
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'ok' }),
      }),
      model: 'claude-haiku-test',
    })
    const out = await llm({ system: 's', user: 'u', max_tokens: 100 })
    expect(out).toBe(JSON.stringify({ body: 'ok' }))
    expect(capturedSpecs.length).toBe(1)
    expect(capturedSpecs[0]!.prompt).toBe('s\n\nu')
    expect(capturedSpecs[0]!.tools).toEqual([])
    expect(capturedSpecs[0]!.model_preference).toEqual(['claude-haiku-test'])
    expect(capturedSpecs[0]!.max_tokens).toBe(100)
  })

  test('rethrows substrate errors with phase-spec-resolver: prefix', async () => {
    const llm = buildAnthropicLlmCall({
      substrate: fakeSubstrate({
        events: [
          { kind: 'error', message: 'upstream rate-limited', retryable: true },
        ],
      }),
      model: 'claude-haiku-test',
    })
    await expect(llm({ system: 's', user: 'u', max_tokens: 100 })).rejects.toThrow(
      /phase-spec-resolver:/,
    )
  })

  test('handles empty system (packs user only into spec.prompt)', async () => {
    const capturedSpecs: AgentSpec[] = []
    const llm = buildAnthropicLlmCall({
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'ok' }),
      }),
      model: 'claude-haiku-test',
    })
    await llm({ system: '', user: 'u', max_tokens: 100 })
    expect(capturedSpecs.length).toBe(1)
    expect(capturedSpecs[0]!.prompt).toBe('u')
  })

  test('throws when both system and user are empty (empty prompt rejected)', async () => {
    const llm = buildAnthropicLlmCall({
      substrate: fakeSubstrate(),
      model: 'claude-haiku-test',
    })
    await expect(llm({ system: '', user: '', max_tokens: 100 })).rejects.toThrow(
      /empty prompt/,
    )
  })
})

describe('typing-indicator wiring', () => {
  test('emits agent_typing_start before LLM call and agent_typing_end after (web topic)', async () => {
    const events: ChatOutbound[] = []
    const registry: WebChatSenderRegistry = new InMemoryWebChatSenderRegistry()
    registry.register('web:user-1', (ev) => events.push(ev))

    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({ responseText: JSON.stringify({ body: 'hi' }) }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      webRegistry: registry,
    })
    expect(resolver).not.toBeNull()
    await resolver!.resolve({
      project_slug: 't1',
      topic_id: 'web:user-1',
      user_id: 'user-1',
      signup_via: 'web',
      telegram_display_name: null,
      phase: 'signup',
      intent: {
        goal: 'g',
        shape: 'free-text',
        allowed_option_values: [],
        max_body_chars: 200,
      },
      captured: {},
      recent_turns: [],
      attempt_count: 0,
      rejection_reason: null,
    })
    expect(events.length).toBe(2)
    expect(events[0]!.type).toBe('agent_typing_start')
    expect(events[1]!.type).toBe('agent_typing_end')
  })

  test('does NOT emit typing indicators for telegram topics', async () => {
    const events: ChatOutbound[] = []
    const registry: WebChatSenderRegistry = new InMemoryWebChatSenderRegistry()
    // Register a sender for the tg topic too, so we'd see events if
    // they leaked through.
    registry.register('tg:123:0', (ev) => events.push(ev))

    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({ responseText: JSON.stringify({ body: 'hi' }) }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      webRegistry: registry,
    })
    await resolver!.resolve({
      project_slug: 't1',
      topic_id: 'tg:123:0',
      user_id: 'tg-user-123',
      signup_via: 'telegram',
      telegram_display_name: 'Anna',
      phase: 'signup',
      intent: {
        goal: 'g',
        shape: 'free-text',
        allowed_option_values: [],
        max_body_chars: 200,
      },
      captured: {},
      recent_turns: [],
      attempt_count: 0,
      rejection_reason: null,
    })
    expect(events.length).toBe(0)
  })
})

describe('skills-loader composition (Sprint A — GBrain methodology integration v2)', () => {
  test('splices conventions from <owner_data_dir>/skills/conventions/ .md files into every system prompt', async () => {
    // Lay out the instance data-dir with all four Sprint-A conventions.
    const ownerHome = join(tmp, 'project-home')
    const conventions = join(ownerHome, 'skills', 'conventions')
    mkdirSync(conventions, { recursive: true })
    writeFileSync(join(conventions, 'brain-first.md'), 'BRAIN_FIRST_BODY\n', 'utf8')
    writeFileSync(
      join(conventions, 'friction-protocol.md'),
      'FRICTION_BODY\n',
      'utf8',
    )
    writeFileSync(
      join(conventions, 'brain-vs-memory.md'),
      'BRAIN_VS_MEMORY_BODY\n',
      'utf8',
    )
    writeFileSync(join(conventions, 'quality.md'), 'QUALITY_BODY\n', 'utf8')

    const capturedSpecs: AgentSpec[] = []
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'hi' }),
      }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      owner_data_dir: ownerHome,
    })
    expect(resolver).not.toBeNull()
    await resolver!.resolve({
      project_slug: 't1',
      topic_id: 'web:user-1',
      user_id: 'user-1',
      signup_via: 'web',
      telegram_display_name: null,
      phase: 'signup',
      intent: {
        goal: 'g',
        shape: 'free-text',
        allowed_option_values: [],
        max_body_chars: 200,
      },
      captured: {},
      recent_turns: [],
      attempt_count: 0,
      rejection_reason: null,
    })
    expect(capturedSpecs.length).toBe(1)
    // The composed prompt packs `<system>\n\n<user>` into spec.prompt;
    // the system block must contain the conventions splice substrings.
    const prompt = capturedSpecs[0]!.prompt
    expect(prompt).toContain('# Conventions')
    expect(prompt).toContain('BRAIN_FIRST_BODY')
    expect(prompt).toContain('FRICTION_BODY')
    expect(prompt).toContain('BRAIN_VS_MEMORY_BODY')
    expect(prompt).toContain('QUALITY_BODY')
  })

  test('empty skills/ directory yields a system prompt byte-identical to the pre-Sprint-A baseline', async () => {
    const ownerHome = join(tmp, 'project-home-empty')
    mkdirSync(ownerHome, { recursive: true })

    let withSkillsPrompt: string | null = null
    let withoutSkillsPrompt: string | null = null

    const harness = async (owner_data_dir: string | null): Promise<void> => {
      const capturedSpecs: AgentSpec[] = []
      const resolver = await buildPhaseSpecResolver({
        log_slug: 't1',
        substrate: fakeSubstrate({
          capturedSpecs,
          responseText: JSON.stringify({ body: 'hi' }),
        }),
        env: {
          NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
        },
        owner_data_dir,
      })
      await resolver!.resolve({
        project_slug: 't1',
        topic_id: 'web:user-1',
        user_id: 'user-1',
        signup_via: 'web',
        telegram_display_name: null,
        phase: 'signup',
        intent: {
          goal: 'g',
          shape: 'free-text',
          allowed_option_values: [],
          max_body_chars: 200,
        },
        captured: {},
        recent_turns: [],
        attempt_count: 0,
        rejection_reason: null,
      })
      const prompt = capturedSpecs[0]!.prompt
      if (owner_data_dir === null) {
        withoutSkillsPrompt = prompt
      } else {
        withSkillsPrompt = prompt
      }
    }

    await harness(null)
    await harness(ownerHome)
    expect(withSkillsPrompt).toBe(withoutSkillsPrompt)
    // Sanity — the baseline does NOT contain a "# Conventions" block.
    expect(withoutSkillsPrompt).not.toContain('# Conventions')
  })

  test('hot-edit to a convention file is reflected on the very next resolver call (Codex r1 P2)', async () => {
    // Codex r1 P2 on Sprint A: the original wrap captured the loaded
    // body once at factory-build time, so a hot-edit needed a gateway
    // restart to take effect. The wrap now calls loadSkills() on
    // EVERY LLM call; the loader caches per (skillsDir, mtimes) so
    // unchanged files cost a handful of lstat syscalls.
    const ownerHome = join(tmp, 'project-hot-edit')
    const conventions = join(ownerHome, 'skills', 'conventions')
    mkdirSync(conventions, { recursive: true })
    const conv = join(conventions, 'brain-first.md')
    writeFileSync(conv, 'V1_BODY\n', 'utf8')

    const capturedSpecs: AgentSpec[] = []
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'hi' }),
      }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      owner_data_dir: ownerHome,
    })

    const bundle = {
      project_slug: 't1',
      topic_id: 'web:user-1',
      user_id: 'user-1',
      signup_via: 'web' as const,
      telegram_display_name: null,
      phase: 'signup' as const,
      intent: {
        goal: 'g',
        shape: 'free-text' as const,
        allowed_option_values: [],
        max_body_chars: 200,
      },
      captured: {},
      recent_turns: [],
      attempt_count: 0,
      rejection_reason: null,
    }

    await resolver!.resolve(bundle)
    expect(capturedSpecs[0]!.prompt).toContain('V1_BODY')

    // Operator hot-edits the convention. Bump mtime by 2 seconds so
    // the loader's mtime cache invalidates even on filesystems with
    // second-granularity mtimes.
    writeFileSync(conv, 'V2_BODY\n', 'utf8')
    const stat = statSync(conv)
    utimesSync(conv, stat.atime, new Date(stat.mtimeMs + 2_000))

    await resolver!.resolve(bundle)
    expect(capturedSpecs[1]!.prompt).toContain('V2_BODY')
    expect(capturedSpecs[1]!.prompt).not.toContain('V1_BODY')
  })
})

describe('persona-loader composition (ISSUE #30 — v0.1.85)', () => {
  // The phase-spec resolver wraps the LLM call with a closure that reads
  // `<owner_home>/persona/{SOUL,USER,priority-map}.md` via the
  // injected `PersonaPromptLoader` and splices the bodies ABOVE the
  // conventions block on every call. The admin-tab personality surface
  // wires its `onReload` hook to the SAME loader's `invalidate(filename)`
  // so a PATCH lands on the very next agent turn.

  const bundle = {
    project_slug: 't1',
    topic_id: 'web:user-1',
    user_id: 'user-1',
    signup_via: 'web' as const,
    telegram_display_name: null,
    phase: 'signup' as const,
    intent: {
      goal: 'g',
      shape: 'free-text' as const,
      allowed_option_values: [],
      max_body_chars: 200,
    },
    captured: {},
    recent_turns: [],
    attempt_count: 0,
    rejection_reason: null,
  }

  test('splices SOUL / USER / priority-map bodies above the base prompt on every LLM call', async () => {
    const ownerHome = join(tmp, 'project-persona-splice')
    const personaDir = join(ownerHome, 'persona')
    mkdirSync(personaDir, { recursive: true })
    writeFileSync(join(personaDir, 'SOUL.md'), 'SOUL_FROM_DISK\n', 'utf8')
    writeFileSync(join(personaDir, 'USER.md'), 'USER_FROM_DISK\n', 'utf8')
    writeFileSync(join(personaDir, 'priority-map.md'), 'PMAP_FROM_DISK\n', 'utf8')

    const personaLoader = new PersonaPromptLoader({ owner_home: ownerHome, log: () => {} })
    const capturedSpecs: AgentSpec[] = []
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'hi' }),
      }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      owner_data_dir: null, // isolate from skills-loader path
      personaLoader,
    })
    expect(resolver).not.toBeNull()
    await resolver!.resolve(bundle)
    expect(capturedSpecs.length).toBe(1)
    const prompt = capturedSpecs[0]!.prompt
    expect(prompt).toContain('# Persona')
    expect(prompt).toContain('SOUL_FROM_DISK')
    expect(prompt).toContain('USER_FROM_DISK')
    expect(prompt).toContain('PMAP_FROM_DISK')
    // Persona block precedes the base prompt (cache anchor on top).
    // The composer separates persona/conventions from the base with a
    // `\n\n---\n\n` divider, so the persona splice MUST appear before
    // the first divider in the system region.
    const base_idx = prompt.indexOf('---\n\n')
    expect(base_idx).toBeGreaterThan(prompt.indexOf('# Persona'))
  })

  test('persona-loader hot-edit lands on the very next resolver call (via invalidate)', async () => {
    const ownerHome = join(tmp, 'project-persona-hot-edit')
    const personaDir = join(ownerHome, 'persona')
    mkdirSync(personaDir, { recursive: true })
    writeFileSync(join(personaDir, 'SOUL.md'), 'SOUL_V1\n', 'utf8')

    const personaLoader = new PersonaPromptLoader({ owner_home: ownerHome, log: () => {} })
    const capturedSpecs: AgentSpec[] = []
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'hi' }),
      }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      owner_data_dir: null,
      personaLoader,
    })

    await resolver!.resolve(bundle)
    expect(capturedSpecs[0]!.prompt).toContain('SOUL_V1')

    // Simulate an admin-tab PATCH that overwrites SOUL.md and fires the
    // surface's `onReload(filename)` hook into the loader.
    writeFileSync(join(personaDir, 'SOUL.md'), 'SOUL_V2_ADMIN_EDIT\n', 'utf8')
    personaLoader.invalidate('SOUL.md')

    await resolver!.resolve(bundle)
    expect(capturedSpecs[1]!.prompt).toContain('SOUL_V2_ADMIN_EDIT')
    expect(capturedSpecs[1]!.prompt).not.toContain('SOUL_V1')
  })

  test('persona-loader + conventions both splice; persona sits ABOVE conventions', async () => {
    const ownerHome = join(tmp, 'project-persona-and-conventions')
    const personaDir = join(ownerHome, 'persona')
    const conventions = join(ownerHome, 'skills', 'conventions')
    mkdirSync(personaDir, { recursive: true })
    mkdirSync(conventions, { recursive: true })
    writeFileSync(join(personaDir, 'SOUL.md'), 'PERSONA_SOUL\n', 'utf8')
    writeFileSync(join(conventions, 'brain-first.md'), 'CONV_BRAIN_FIRST\n', 'utf8')

    const personaLoader = new PersonaPromptLoader({ owner_home: ownerHome, log: () => {} })
    const capturedSpecs: AgentSpec[] = []
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'hi' }),
      }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      owner_data_dir: ownerHome,
      personaLoader,
    })
    await resolver!.resolve(bundle)
    const prompt = capturedSpecs[0]!.prompt
    expect(prompt).toContain('# Persona')
    expect(prompt).toContain('PERSONA_SOUL')
    expect(prompt).toContain('# Conventions')
    expect(prompt).toContain('CONV_BRAIN_FIRST')
    // Persona above conventions; both above the base.
    expect(prompt.indexOf('# Persona')).toBeLessThan(prompt.indexOf('# Conventions'))
  })

  test('null personaLoader + null owner_data_dir yields baseline system prompt (regression-pin)', async () => {
    const capturedSpecs: AgentSpec[] = []
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'hi' }),
      }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      owner_data_dir: null,
      personaLoader: null,
    })
    await resolver!.resolve(bundle)
    expect(capturedSpecs[0]!.prompt).not.toContain('# Persona')
    expect(capturedSpecs[0]!.prompt).not.toContain('# Conventions')
  })

  test('missing persona/ directory yields no persona block (graceful)', async () => {
    const ownerHome = join(tmp, 'project-no-persona-dir')
    mkdirSync(ownerHome, { recursive: true })
    // Intentionally NOT creating <owner_home>/persona/

    const personaLoader = new PersonaPromptLoader({ owner_home: ownerHome, log: () => {} })
    const capturedSpecs: AgentSpec[] = []
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'hi' }),
      }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      owner_data_dir: null,
      personaLoader,
    })
    await resolver!.resolve(bundle)
    // No persona block when no files exist.
    expect(capturedSpecs[0]!.prompt).not.toContain('# Persona')
  })
})

describe('escalation-loader composition (P7.2 S3 — production wire-through)', () => {
  // Argus IMPORTANT (PR #298 round 1): the resolver factory accepts a
  // `commentStore` + `escalation_project_id` pair so the per-turn LLM
  // wrapper splices any pending `escalate_to_chat` events into the
  // system prompt above the persona / conventions blocks. The PROD
  // wiring at `gateway/index.ts:2434-2455` threads both, matching the
  // persona-loader plumbing. This test pins that wiring end-to-end:
  // real CommentStore + real escalation-loader + real resolver, with
  // only the upstream substrate stubbed via fakeSubstrate.

  const bundle = {
    project_slug: 't1',
    topic_id: 'web:user-1',
    user_id: 'user-1',
    signup_via: 'web' as const,
    telegram_display_name: null,
    phase: 'signup' as const,
    intent: {
      goal: 'g',
      shape: 'free-text' as const,
      allowed_option_values: [],
      max_body_chars: 200,
    },
    captured: {},
    recent_turns: [],
    attempt_count: 0,
    rejection_reason: null,
  }

  async function seedEscalation(
    store: CommentStore,
    project_id: string,
    opts: {
      doc_path: string
      anchor_excerpt: string
      body: string
    },
  ): Promise<void> {
    const root = await store.appendEvent(project_id, {
      event_kind: 'comment_posted',
      doc_path: opts.doc_path,
      thread_root_id: null,
      parent_event_id: null,
      anchor_start: 0,
      anchor_end: opts.anchor_excerpt.length,
      anchor_text_excerpt: opts.anchor_excerpt,
      anchor_ctx_before: '',
      anchor_ctx_after: '',
      based_on_modified_at: Date.now() - 30_000,
      author_kind: 'user',
      author_id: 'user@example.com',
      body: opts.body,
      metadata_json: null,
    })
    await store.appendEvent(project_id, {
      event_kind: 'escalate_to_chat',
      doc_path: opts.doc_path,
      thread_root_id: root.thread_root_id,
      parent_event_id: root.event.event_id,
      anchor_start: null,
      anchor_end: null,
      anchor_text_excerpt: null,
      anchor_ctx_before: null,
      anchor_ctx_after: null,
      based_on_modified_at: null,
      author_kind: 'user',
      author_id: 'user@example.com',
      body: null,
      metadata_json: JSON.stringify({
        thread_root_id: root.thread_root_id,
        doc_path: opts.doc_path,
        anchor_excerpt: opts.anchor_excerpt,
        comment_body_history: opts.body,
        trigger: 'user_button',
      }),
    })
  }

  test('wired commentStore + escalation_project_id splices <escalated_comment_threads> envelope into the next turn system prompt', async () => {
    const ownerHome = join(tmp, 'project-escalation-prod-wire')
    mkdirSync(ownerHome, { recursive: true })

    const commentStore = new CommentStore({ owner_home: ownerHome })
    const PROJECT_ID = 'default'
    await seedEscalation(commentStore, PROJECT_ID, {
      doc_path: 'notes/foo.md',
      anchor_excerpt: 'pin the SHA at write time',
      body: 'disagree — read path is bottlenecked on deflate',
    })

    // Spy on withProjectDb so we can pin the project_id the resolver
    // ends up dispatching against. The loader is the only caller in
    // production; if the resolver wrapper is wired correctly, this
    // will fire on every resolve() call.
    const projectIdsSeen: string[] = []
    const realWithProjectDb = commentStore.withProjectDb.bind(commentStore)
    commentStore.withProjectDb = async function spyWithProjectDb<T>(
      project_id: string,
      fn: (db: Parameters<typeof realWithProjectDb>[1] extends (db: infer D) => unknown ? D : never) => T | Promise<T>,
    ): Promise<T> {
      projectIdsSeen.push(project_id)
      return realWithProjectDb(project_id, fn as Parameters<typeof realWithProjectDb>[1]) as Promise<T>
    } as typeof commentStore.withProjectDb

    const capturedSpecs: AgentSpec[] = []
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'hi' }),
      }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      owner_data_dir: null,
      personaLoader: null,
      commentStore,
      escalation_project_id: PROJECT_ID,
    })
    expect(resolver).not.toBeNull()

    await resolver!.resolve(bundle)

    // Spec-conformance: the resolver wrapper drove the loader, which
    // hit the comment store against the wired project_id.
    expect(projectIdsSeen).toContain(PROJECT_ID)

    // The composed system prompt carries the <escalated_comment_threads>
    // envelope + the seeded thread context.
    expect(capturedSpecs.length).toBe(1)
    expect(capturedSpecs[0]!.prompt).toContain('<escalated_comment_threads>')
    expect(capturedSpecs[0]!.prompt).toContain('</escalated_comment_threads>')
    expect(capturedSpecs[0]!.prompt).toContain('notes/foo.md')
    expect(capturedSpecs[0]!.prompt).toContain('pin the SHA at write time')
    expect(capturedSpecs[0]!.prompt).toContain('disagree — read path is bottlenecked on deflate')

    // Consumed-on-read: a second resolver call after the first sees
    // no pending escalations, so the envelope is gone.
    await resolver!.resolve(bundle)
    expect(capturedSpecs.length).toBe(2)
    expect(capturedSpecs[1]!.prompt).not.toContain('<escalated_comment_threads>')

    commentStore.closeAll()
  })

  test('null commentStore + null escalation_project_id skips splicing (regression-pin matches persona-loader null-safety)', async () => {
    const capturedSpecs: AgentSpec[] = []
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'hi' }),
      }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      owner_data_dir: null,
      personaLoader: null,
      commentStore: null,
      escalation_project_id: null,
    })
    await resolver!.resolve(bundle)
    expect(capturedSpecs[0]!.prompt).not.toContain('<escalated_comment_threads>')
  })

  test('commentStore wired but escalation_project_id null silently skips (defensive null-safety)', async () => {
    const ownerHome = join(tmp, 'project-escalation-null-pid')
    mkdirSync(ownerHome, { recursive: true })
    const commentStore = new CommentStore({ owner_home: ownerHome })

    const capturedSpecs: AgentSpec[] = []
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'hi' }),
      }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      owner_data_dir: null,
      personaLoader: null,
      commentStore,
      escalation_project_id: null,
    })
    await resolver!.resolve(bundle)
    expect(capturedSpecs[0]!.prompt).not.toContain('<escalated_comment_threads>')
    commentStore.closeAll()
  })

  // ─── ISSUE #41 — closure-shaped escalation_project_id ──────────────
  //
  // The pre-#41 wiring pinned escalation_project_id at composer-build
  // time, so the chat composer could only ever read escalations from
  // one project (the production wiring hardcoded `default`). PR #298
  // r3 surfaced this as Codex P1: an escalation from a non-default
  // project landed in THAT project's sidecar but the chat composer
  // never read it on the next turn.
  //
  // The fix accepts `escalation_project_id` as `() => string | null`
  // and invokes it per-LLM-call so the production composer can thread
  // a live "current chat project_id" pointer through without
  // rebuilding the resolver on every escalation. The test pins:
  //   1. project_id='foo' returns envelope from foo sidecar (NOT bar)
  //   2. project_id switches to 'bar' on the next turn → envelope
  //      sources from bar sidecar (NOT foo's content)
  //   3. closure that returns null on a turn skips splicing entirely
  //   4. once foo's pending event is consumed, switching back to 'foo'
  //      yields no envelope (consumed-on-read survives the project
  //      switch — the per-project sidecar bookkeeping is intact).

  test('closure-shaped escalation_project_id resolves per LLM-call (multi-project routing — ISSUE #41)', async () => {
    const ownerHome = join(tmp, 'project-escalation-multi-project')
    mkdirSync(ownerHome, { recursive: true })

    const commentStore = new CommentStore({ owner_home: ownerHome })
    await seedEscalation(commentStore, 'foo', {
      doc_path: 'notes/foo-doc.md',
      anchor_excerpt: 'FOO-PROJECT-ANCHOR',
      body: 'foo project body discussion',
    })
    await seedEscalation(commentStore, 'bar', {
      doc_path: 'notes/bar-doc.md',
      anchor_excerpt: 'BAR-PROJECT-ANCHOR',
      body: 'bar project body discussion',
    })

    // Per-call mutable cell — the closure reads it on every LLM call.
    // The production composer reads from a WebChatSessionProjectRegistry
    // updated by the docs surface's escalate POST handler.
    let currentProjectId: string | null = 'foo'

    const projectIdsSeen: string[] = []
    const realWithProjectDb = commentStore.withProjectDb.bind(commentStore)
    commentStore.withProjectDb = async function spyWithProjectDb<T>(
      project_id: string,
      fn: (db: Parameters<typeof realWithProjectDb>[1] extends (db: infer D) => unknown ? D : never) => T | Promise<T>,
    ): Promise<T> {
      projectIdsSeen.push(project_id)
      return realWithProjectDb(project_id, fn as Parameters<typeof realWithProjectDb>[1]) as Promise<T>
    } as typeof commentStore.withProjectDb

    const capturedSpecs: AgentSpec[] = []
    const resolver = await buildPhaseSpecResolver({
      log_slug: 't1',
      substrate: fakeSubstrate({
        capturedSpecs,
        responseText: JSON.stringify({ body: 'hi' }),
      }),
      env: {
        NEUTRON_LLM_ONBOARDING_PHASES: 'signup',
      },
      owner_data_dir: null,
      personaLoader: null,
      commentStore,
      escalation_project_id: (): string | null => currentProjectId,
    })
    expect(resolver).not.toBeNull()

    // Turn 1 — closure returns 'foo'. Envelope should source from foo.
    await resolver!.resolve(bundle)
    expect(projectIdsSeen).toContain('foo')
    expect(projectIdsSeen).not.toContain('bar')
    expect(capturedSpecs.length).toBe(1)
    expect(capturedSpecs[0]!.prompt).toContain('<escalated_comment_threads>')
    expect(capturedSpecs[0]!.prompt).toContain('FOO-PROJECT-ANCHOR')
    expect(capturedSpecs[0]!.prompt).not.toContain('BAR-PROJECT-ANCHOR')

    // Turn 2 — closure returns 'bar'. Envelope should source from bar
    // ONLY; foo's pending content must NOT leak across the project
    // boundary even though both sidecars share one CommentStore.
    currentProjectId = 'bar'
    await resolver!.resolve(bundle)
    expect(projectIdsSeen).toContain('bar')
    expect(capturedSpecs.length).toBe(2)
    expect(capturedSpecs[1]!.prompt).toContain('<escalated_comment_threads>')
    expect(capturedSpecs[1]!.prompt).toContain('BAR-PROJECT-ANCHOR')
    expect(capturedSpecs[1]!.prompt).not.toContain('FOO-PROJECT-ANCHOR')

    // Turn 3 — closure returns null. Splicing skipped entirely.
    currentProjectId = null
    await resolver!.resolve(bundle)
    expect(capturedSpecs.length).toBe(3)
    expect(capturedSpecs[2]!.prompt).not.toContain('<escalated_comment_threads>')

    // Turn 4 — closure returns 'foo' again. The foo escalation was
    // consumed on turn 1 (atomic-consumed-on-read inside
    // loadPendingEscalations), so the envelope must be absent even
    // though the closure points back at the right project.
    currentProjectId = 'foo'
    await resolver!.resolve(bundle)
    expect(capturedSpecs.length).toBe(4)
    expect(capturedSpecs[3]!.prompt).not.toContain('<escalated_comment_threads>')

    commentStore.closeAll()
  })
})
