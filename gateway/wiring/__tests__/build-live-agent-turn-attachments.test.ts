/**
 * M2 modality threading — chat-attachment → live-agent-turn prompt injection.
 *
 * The runner resolves a turn's `attachments` upload URLs to local blob paths and
 * splices a `<user_attachments>` fragment into the DISPATCHED prompt (so the CC
 * REPL can `Read` the image/PDF) WITHOUT mutating `turn.user_text` (that text
 * feeds capture/reflection/scribe/persistence). This locks:
 *   (a) the WARM turn embeds the resolved path before the user's message;
 *   (b) the COLD first turn embeds it via `composeFirstTurnPrompt`;
 *   (c) `turn.user_text` handed to the reflection/scribe seam is UNCHANGED (no
 *       fragment pollution);
 *   (d) an unresolvable URL is skipped (turn still dispatches);
 *   (e) no attachments ⇒ no `<user_attachments>` block.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ChatOutbound } from '@neutronai/landing/server.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import { buildLiveAgentTurn } from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore
const now = 1_000_000

const PDF_URL = '/api/app/upload/u-1/deadbeefdeadbeef.pdf'
const PDF_PATH = '/home/owner/chat-attachments/u-1/deadbeefdeadbeef.pdf'
const PNG_URL = '/api/app/upload/u-1/cafef00dcafef00d.png'
const PNG_PATH = '/home/owner/chat-attachments/u-1/cafef00dcafef00d.png'

/** Stub resolver: maps the two known upload URLs to local paths, null else. */
const resolveAttachment = (url: string): { path: string; content_type: string } | null => {
  if (url === PDF_URL) return { path: PDF_PATH, content_type: 'application/pdf' }
  if (url === PNG_URL) return { path: PNG_PATH, content_type: 'image/png' }
  return null
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-att-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new ButtonStore({ db, now: () => now })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeStubSubstrate(specs: AgentSpec[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: 'ok' }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'stub',
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

function makeTurn(
  sent: ChatOutbound[],
  user_text: string,
  attachments?: readonly string[],
): LiveAgentTurnRequest {
  const turn: LiveAgentTurnRequest = {
    project_slug: 'alice',
    user_id: 'u-1',
    topic_id: 'web:u-1',
    user_text,
    send: (e) => sent.push(e),
    observed_at: now,
  }
  if (attachments !== undefined) turn.attachments = attachments
  return turn
}

describe('build-live-agent-turn — attachment threading', () => {
  test('(b) the COLD first turn embeds the resolved PDF path in the prompt', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      resolveAttachment,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })
    await run(makeTurn(sent, 'what does this say?', [PDF_URL]))
    expect(specs.length).toBe(1)
    expect(specs[0]!.prompt).toContain('<user_attachments>')
    expect(specs[0]!.prompt).toContain(PDF_PATH)
    expect(specs[0]!.prompt).toContain('(application/pdf)')
  })

  test('(a) the WARM turn embeds the path BEFORE the user message', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      resolveAttachment,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })
    await run(makeTurn(sent, 'first message')) // cold, no attachment
    await run(makeTurn(sent, 'and this image?', [PNG_URL])) // warm, with attachment
    expect(specs.length).toBe(2)
    const warm = specs[1]!.prompt
    expect(warm).toContain(PNG_PATH)
    expect(warm).toContain('and this image?')
    // Fragment precedes the user's message text.
    expect(warm.indexOf(PNG_PATH)).toBeLessThan(warm.indexOf('and this image?'))
  })

  test('(c) turn.user_text handed to the reflection seam is UNPOLLUTED by the path', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    let seenUserText: string | null = null
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      resolveAttachment,
      reflection: {
        loadContext: () => null,
        onTurnComplete: (t) => {
          seenUserText = t.user_text
        },
      },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })
    await run(makeTurn(sent, 'read my doc', [PDF_URL]))
    // The prompt carries the path…
    expect(specs[0]!.prompt).toContain(PDF_PATH)
    // …but the user_text the seam judges is exactly what the user typed.
    expect(seenUserText).toBe('read my doc')
    expect(seenUserText as unknown as string).not.toContain(PDF_PATH)
    // The persisted user-turn history bubble is likewise unpolluted.
    const persisted = await store.latestTurnByTopic({ topic_id: 'web:u-1', before: now, now })
    expect(persisted?.body ?? '').not.toContain(PDF_PATH)
  })

  test('(d) an unresolvable attachment URL is skipped; the turn still dispatches', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      resolveAttachment,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })
    await run(makeTurn(sent, 'here', ['/api/app/upload/u-1/not-a-real-hash.pdf']))
    expect(specs.length).toBe(1)
    // Nothing resolved → no <user_attachments> block, but the turn ran + replied.
    expect(specs[0]!.prompt).not.toContain('<user_attachments>')
    expect(sent.some((e) => e.type === 'agent_message')).toBe(true)
  })

  test('(e) no attachments → no <user_attachments> block', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      resolveAttachment,
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })
    await run(makeTurn(sent, 'plain text only'))
    expect(specs[0]!.prompt).not.toContain('<user_attachments>')
  })

  test('no resolver wired → attachments ignored (no block, turn runs)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const run = buildLiveAgentTurn({
      substrate: makeStubSubstrate(specs),
      personaLoader: { async load() { return '' } },
      buttonStore: store,
      project_slug: 'alice',
      owner_home: tmp,
      model: 'test-model',
      now: () => now,
    })
    await run(makeTurn(sent, 'here', [PDF_URL]))
    expect(specs.length).toBe(1)
    expect(specs[0]!.prompt).not.toContain('<user_attachments>')
  })
})
