/**
 * ISSUES #204 — unit coverage for the live-agent chat turn runner
 * (post-onboarding spec § ITEM 1, `build-live-agent-turn.ts`).
 *
 * Stubbed substrate (no real `claude` spawn); REAL ButtonStore over an
 * on-disk migrated project.db so persistence assertions exercise the same
 * SQL the gateway runs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import { buildButtonPrompt } from '../../../channels/button-primitive.ts'
import type { ChatOutbound } from '../../../landing/server.ts'
import type { Event } from '../../../runtime/events.ts'
import type { AgentSpec, Substrate } from '../../../runtime/substrate.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import { buildLiveAgentTurn } from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore
let now = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  now = 1_000_000
  store = new ButtonStore({ db, now: () => now })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/** Substrate stub: records every spec, replies with canned token events. */
function makeStubSubstrate(opts: {
  reply?: string
  error?: string
  specs: AgentSpec[]
}): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      opts.specs.push(spec)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        if (opts.error !== undefined) {
          yield { kind: 'error', message: opts.error, retryable: false }
          return
        }
        const text = opts.reply ?? 'stub reply'
        // Two token chunks so accumulation (not just passthrough) is covered.
        yield { kind: 'token', text: text.slice(0, 3) }
        yield { kind: 'token', text: text.slice(3) }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'stub',
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {
          throw new Error('not used')
        },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

function makeRunner(over: {
  substrate: Substrate
  persona?: string | null
  transcriptEntries?: Array<Record<string, unknown>>
}) {
  const personaLoader = {
    async load(): Promise<string> {
      if (over.persona === null) throw new Error('loader exploded')
      return over.persona ?? ''
    },
  }
  const transcript =
    over.transcriptEntries !== undefined
      ? {
          append: (entry: Record<string, unknown>): unknown => {
            over.transcriptEntries!.push(entry)
            return entry
          },
        }
      : undefined
  return buildLiveAgentTurn({
    substrate: over.substrate,
    personaLoader,
    buttonStore: store,
    ...(transcript !== undefined ? { transcript } : {}),
    project_slug: 'alice',
    owner_home: tmp,
    model: 'test-model',
    now: () => now,
  })
}

function makeTurn(over: Partial<LiveAgentTurnRequest> & { sent: ChatOutbound[] }): LiveAgentTurnRequest {
  const { sent, ...rest } = over
  return {
    project_slug: 'alice',
    user_id: 'u-1',
    topic_id: 'web:u-1',
    user_text: 'what projects do I have?',
    send: (e) => sent.push(e),
    observed_at: now,
    ...rest,
  }
}

describe('build-live-agent-turn — reply path', () => {
  test('dispatches the substrate, sends ONE agent_message, persists the reply row', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ reply: 'Here are your projects.', specs }) })
    const result = await run(makeTurn({ sent }))

    expect(result.outcome).toBe('replied')
    expect(result.reply_prompt_id).not.toBeNull()
    // One reply envelope, full accumulated text, freeform-open, no buttons.
    const replies = sent.filter((e) => e.type === 'agent_message')
    expect(replies).toHaveLength(1)
    const reply = replies[0] as { body: string; prompt_id?: string; allow_freeform?: boolean }
    expect(reply.body).toBe('Here are your projects.')
    expect(reply.prompt_id).toBe(result.reply_prompt_id!)
    expect(reply.allow_freeform).toBe(true)
    // Persisted as a button_prompts row (the durable history record —
    // spec § 1.5: body-only sends are live-wire only; the messages table
    // is unwired by design).
    const row = await store.peek(result.reply_prompt_id!)
    expect(row).not.toBeNull()
    expect(row!.topic_id).toBe('web:u-1')
  })

  test('persona content lands in the FIRST turn prompt; later turns send only the user text', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({
      substrate: makeStubSubstrate({ specs }),
      persona: '<persona_file name="SOUL.md">You are Kairos, sovereign clarity.</persona_file>',
    })
    await run(makeTurn({ sent }))
    expect(specs).toHaveLength(1)
    expect(specs[0]!.prompt).toContain('You are Kairos, sovereign clarity.')
    expect(specs[0]!.prompt).toContain('what projects do I have?')
    // Warm second turn: the REPL transcript carries the context.
    await run(makeTurn({ sent, user_text: 'and the second one?' }))
    expect(specs).toHaveLength(2)
    expect(specs[1]!.prompt).toBe('and the second one?')
    expect(specs[1]!.prompt).not.toContain('Kairos')
  })

  test('missing persona files → generic fallback prompt, no hard-fail (spec § 1.6 step 2)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ specs }), persona: '' })
    const result = await run(makeTurn({ sent }))
    expect(result.outcome).toBe('replied')
    expect(specs[0]!.prompt).toContain('personal Neutron assistant')
  })

  test('a THROWING persona loader still completes the turn on the fallback', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ specs }), persona: null })
    const result = await run(makeTurn({ sent }))
    expect(result.outcome).toBe('replied')
    expect(sent.filter((e) => e.type === 'agent_message')).toHaveLength(1)
  })

  test('per-(project, topic) session keying rides metering_context.project_id', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ specs }) })
    await run(makeTurn({ sent }))
    expect(specs[0]!.metering_context).toEqual({ project_id: 'general' })
    await run(
      makeTurn({ sent, topic_id: 'web:u-1:minas-tirith', project_id: 'minas-tirith' }),
    )
    expect(specs[1]!.metering_context).toEqual({
      project_id: 'minas-tirith',
    })
    // Project topics get their own first-turn context (scoped fragment).
    expect(specs[1]!.prompt).toContain('minas-tirith')
  })

  test('declares the read-only built-in tool surface on every spec', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ specs }) })
    await run(makeTurn({ sent }))
    expect(specs[0]!.tools.map((t) => t.name)).toEqual(['Read', 'Glob', 'Grep'])
  })

  test('appends user + agent turns to the operator transcript', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const entries: Array<Record<string, unknown>> = []
    const run = makeRunner({
      substrate: makeStubSubstrate({ reply: 'noted.', specs }),
      transcriptEntries: entries,
    })
    await run(makeTurn({ sent }))
    expect(entries.map((e) => e['role'])).toEqual(['user', 'agent'])
    expect(entries[0]!['body']).toBe('what projects do I have?')
    expect(entries[1]!['body']).toBe('noted.')
  })
})

describe('build-live-agent-turn — user-turn persistence (onboarding-native pairing)', () => {
  test('resolves the previous unresolved reply row with the typed text as __freeform__', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ specs }) })
    // Turn 1 leaves an unresolved reply row R1.
    const r1 = await run(makeTurn({ sent }))
    expect(r1.reply_prompt_id).not.toBeNull()
    now += 1_000
    // Turn 2's typed text becomes R1's resolution → history renders
    // [agent R1][user T2] in order.
    await run(makeTurn({ sent, user_text: 'tell me more', observed_at: now }))
    const { turns } = await store.listHistoryByTopic({
      topic_id: 'web:u-1',
      before: now + 1,
      before_prompt_id: null,
      limit: 10,
      now: now + 1,
    })
    const r1Turn = turns.find((t) => t.prompt_id === r1.reply_prompt_id)
    expect(r1Turn).toBeDefined()
    expect(r1Turn!.resolved).toBe(true)
    expect((r1Turn as { resolution_text: string }).resolution_text).toBe('tell me more')
  })

  test('resolves an unanswered project seed prompt with the typed text (project-topic first message)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const seed = buildButtonPrompt({
      body: 'Want me to brief you on what I know about this project?',
      options: [{ label: 'A', body: 'Tell me what you know', value: 'tell-me-what-you-know' }],
      allow_freeform: true,
    })
    await store.emit(seed, { topic_id: 'web:u-1:minas-tirith' })
    const run = makeRunner({ substrate: makeStubSubstrate({ specs }) })
    await run(
      makeTurn({
        sent,
        topic_id: 'web:u-1:minas-tirith',
        project_id: 'minas-tirith',
        user_text: 'what is the latest here?',
      }),
    )
    const resolved = await store.peek(seed.prompt_id)
    expect(resolved!.resolved_at).not.toBeNull()
    expect(resolved!.resolution_freeform_text).toBe('what is the latest here?')
  })
})

describe('build-live-agent-turn — failure shapes (anti-silence contract)', () => {
  test('substrate error event → friendly failure bubble, outcome=failed, NO reply row', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ error: 'HTTP 401: bad credential', specs }) })
    const result = await run(makeTurn({ sent }))
    expect(result.outcome).toBe('failed')
    expect(result.reply_prompt_id).toBeNull()
    const replies = sent.filter((e) => e.type === 'agent_message')
    expect(replies).toHaveLength(1)
    // Friendly copy, never the raw substrate error.
    expect((replies[0] as { body: string }).body).not.toContain('401')
  })

  test('a failed first turn does NOT consume the context-sent marker (retry re-sends persona)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const failing = makeStubSubstrate({ error: 'boom', specs })
    const succeeding = makeStubSubstrate({ specs })
    let current: Substrate = failing
    const flipper: Substrate = { start: (spec) => current.start(spec) }
    const run = makeRunner({ substrate: flipper, persona: 'PERSONA-MARKER' })
    await run(makeTurn({ sent }))
    current = succeeding
    await run(makeTurn({ sent, user_text: 'retry' }))
    // Both dispatches carried the full first-turn context.
    expect(specs[0]!.prompt).toContain('PERSONA-MARKER')
    expect(specs[1]!.prompt).toContain('PERSONA-MARKER')
  })

  test('empty reply text → failure bubble, outcome=failed', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ reply: '   ', specs }) })
    const result = await run(makeTurn({ sent }))
    expect(result.outcome).toBe('failed')
    expect(sent.filter((e) => e.type === 'agent_message')).toHaveLength(1)
  })

  test('a throwing send never escapes the runner (dead socket mid-turn)', async () => {
    const specs: AgentSpec[] = []
    const run = makeRunner({ substrate: makeStubSubstrate({ specs }) })
    const result = await run(
      makeTurn({
        sent: [],
        send: () => {
          throw new Error('socket closed')
        },
      }),
    )
    // Reply row still persisted — reconnect hydration recovers the turn.
    expect(result.outcome).toBe('replied')
    expect(result.reply_prompt_id).not.toBeNull()
  })

  test('first-turn prompt splices recent topic history for short-term memory', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    // A resolved prior exchange exists on the topic (e.g. onboarding handoff).
    const prior = buildButtonPrompt({
      body: 'Welcome! Your workspace is ready.',
      options: [],
      allow_freeform: true,
    })
    await store.emit(prior, { topic_id: 'web:u-1' })
    await store.resolve({
      choice: {
        prompt_id: prior.prompt_id,
        choice_value: '__freeform__',
        freeform_text: 'thanks!',
        chosen_at: now,
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
    })
    now += 500
    const run = makeRunner({ substrate: makeStubSubstrate({ specs }) })
    await run(makeTurn({ sent, observed_at: now }))
    expect(specs[0]!.prompt).toContain('<recent_conversation>')
    expect(specs[0]!.prompt).toContain('Welcome! Your workspace is ready.')
    expect(specs[0]!.prompt).toContain('User: thanks!')
  })
})
