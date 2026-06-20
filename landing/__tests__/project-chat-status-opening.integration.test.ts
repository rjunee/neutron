/**
 * Integration test (2026-06-19, owner live-dogfood) covering BOTH bugs that
 * share the per-project-topic / `button_prompts` code path:
 *
 *   BUG #308 — the project opening must SUMMARIZE STATUS.md (one-liner +
 *   status/priority + open threads + an ask-for-corrections line + a
 *   per-project next-action hook), not emit the generic hardcoded
 *   "Want me to dig into <topic>?".
 *
 *   BUG #310 — project chat history must be PRESERVED. Project-topic stub
 *   turns are persisted to `button_prompts` (regardless of live-agent
 *   eligibility), and the landing client renders the FULL backlog on a
 *   topic switch, not just the single live-re-emitted message.
 *
 * This bridges the real layers end to end:
 *   composer (buildOnboardingHandoffHook, deterministic path)
 *     -> ButtonStore (sqlite)
 *     -> chat-bridge (handleProjectTopicInbound via bridge.handleInbound)
 *     -> ButtonStore reads (server history contract)
 *     -> landing ChatClient hydration (rendered DOM).
 *
 * Assertions are real (persisted store rows + rendered DOM bubbles), not
 * bookkeeping.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { ButtonStore, type ChatHistoryTurn } from '../../channels/button-store.ts'
import {
  buildOnboardingHandoffHook,
  type ReadProjectDocFn,
} from '../../gateway/realmode-composer/build-onboarding-handoff.ts'
import {
  buildWebChatBridge,
  InMemoryWebChatSenderRegistry,
  webTopicId,
} from '../../gateway/http/chat-bridge.ts'
import { InMemoryConsumedTokens } from '@neutronai/runtime/__tests__/start-token-testkit.ts'
import type { ChatOutbound } from '../server.ts'
import type { ImportResult } from '../../onboarding/history-import/types.ts'
import type { InterviewEngine } from '../../onboarding/interview/engine.ts'

// STATUS.md the materializer would have written for this project (shape per
// `onboarding/wow-moment/project-materializer.ts` renderStatusMd) plus an
// "Open threads" section a worked project would carry.
const STATUS_MD = `---
name: acme
status: active
priority: P1
one_liner: ${JSON.stringify('DTC skincare brand, launching in two weeks')}
remote: local
last_updated: 2026-06-19
---

# Status

Acme is the direct-to-consumer skincare venture with Casey; the first product line ships in two weeks and the convertible note is still open.

## Open threads

- close the convertible note at the 8M cap
- finalize the launch-week email sequence
`

function fakeImportResult(name: string): ImportResult {
  return {
    entities: [],
    topics: [],
    proposed_projects: [
      {
        name,
        rationale: `Pass-2 summary for ${name}.`,
        suggested_topics: [`${name} topic A`, `${name} topic B`],
      },
    ],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {
      typical_message_length: 'medium',
      formality: 'casual',
      directness: 'direct',
      hedging_frequency: 'low',
    },
    facts: {},
  } as unknown as ImportResult
}

// Minimal engine stub — the project-topic inbound path never drives the
// onboarding engine (its state is per-user on General), so start/advance
// are never called here.
const noopEngine = {
  async start() {
    throw new Error('engine.start not used on project topics')
  },
  async advance() {
    throw new Error('engine.advance not used on project topics')
  },
} as unknown as InterviewEngine

// ── Client harness (happy-dom), mirrored from chat-history-hydrate.test.ts ──

interface FakeWebSocket {
  addEventListener(type: string, fn: (ev?: unknown) => void): void
  send(): void
  close(): void
  fireOpen(): void
  fireMessage(data: unknown): void
}

let activeSockets: FakeWebSocket[] = []
let mod: typeof import('../chat.ts')

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'https://t-test.neutron.test/chat' })
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSING = 2
    static CLOSED = 3
    readyState = 0
    private readonly listeners: Record<string, ((ev?: unknown) => void)[]> = {
      open: [],
      message: [],
      close: [],
      error: [],
    }
    constructor() {
      const fake: FakeWebSocket = {
        addEventListener: (type, fn): void => {
          this.listeners[type]?.push(fn)
        },
        send: (): void => {},
        close: (): void => {},
        fireOpen: (): void => {
          this.readyState = 1
          for (const fn of this.listeners['open'] ?? []) fn({})
        },
        fireMessage: (data): void => {
          for (const fn of this.listeners['message'] ?? []) {
            fn({ data: typeof data === 'string' ? data : JSON.stringify(data) })
          }
        },
      }
      activeSockets.push(fake)
      ;(this as unknown as Record<string, unknown>).addEventListener = fake.addEventListener
      ;(this as unknown as Record<string, unknown>).send = fake.send
      ;(this as unknown as Record<string, unknown>).close = fake.close
    }
  }
  Object.defineProperty(window.location, 'replace', {
    value: () => {},
    writable: true,
    configurable: true,
  })
  mod = await import('../chat.ts')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/** Single-shot fetch stub returning the supplied history body. */
function installHistoryFetch(body: Record<string, unknown>): void {
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<Response> =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe('per-project chat: STATUS.md opening (#308) + preserved history (#310)', () => {
  let tmp: string
  let db: ProjectDb
  let store: ButtonStore
  // Shared, explicitly-advanced clock so opening / stub turns get distinct,
  // strictly-ascending created_at (the history endpoint orders by
  // (created_at, prompt_id), so same-ms rows would scramble).
  let nowMs: number
  const clock = (): number => nowMs

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-project-chat-integ-'))
    db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    nowMs = Date.parse('2026-06-19T12:00:00.000Z')
    store = new ButtonStore({ db, now: clock })
    activeSockets = []
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('opening summarizes STATUS.md; stub turns persist; full transcript renders on switch-back', async () => {
    const generalTopic = webTopicId('u-1')
    const projectTopic = `${generalTopic}:acme`

    // ── BUG #308 — emit the project opening from the real handoff hook,
    // with a doc reader that surfaces STATUS.md (and no README / summary).
    const reader: ReadProjectDocFn = (_slug, relpath) =>
      relpath === 'STATUS.md' ? STATUS_MD : null
    const hook = buildOnboardingHandoffHook({ buttonStore: store, readProjectDoc: reader })
    await hook.emitProjectSeeds({
      project_slug: 'owner',
      user_id: 'u-1',
      primary_projects: ['Acme'],
      import_result: fakeImportResult('Acme'),
      observed_at: clock(),
    })

    const readAll = async (): Promise<ChatHistoryTurn[]> => {
      const { turns } = await store.listHistoryByTopic({
        topic_id: projectTopic,
        before: nowMs + 5 * 60_000,
        before_prompt_id: null,
        limit: 50,
        now: nowMs + 5 * 60_000,
      })
      return turns
    }

    const openingRows = await readAll()
    expect(openingRows.length).toBe(1)
    const opening = openingRows[0]!
    // Summarizes STATUS.md — one-liner + standing + priority + corrections
    // + a per-project next-action hook pulled from the open-threads list.
    expect(opening.body).toContain('DTC skincare brand')
    expect(opening.body).toContain("Here's where Acme stands")
    expect(opening.body).toContain('active')
    expect(opening.body).toContain('P1')
    expect(opening.body.toLowerCase()).toContain('update it')
    expect(opening.body).toContain('close the convertible note at the 8M cap')
    // NOT the retired generic-only opener.
    expect(opening.body).not.toContain('Want me to dig into Acme topic A?')

    // ── BUG #310 — drive two project-topic user messages through the real
    // bridge stub path (no live-agent runner wired => not eligible). Each
    // turn must persist: resolve the prior row with the typed text + emit a
    // new stub reply row.
    const registry = new InMemoryWebChatSenderRegistry()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'owner',
      resolveKey: async () => null,
      consumedTokens: new InMemoryConsumedTokens(),
      engine: noopEngine,
      registry,
      buttonStore: store,
      now: clock,
    })

    const sent: ChatOutbound[] = []
    nowMs += 60_000
    await bridge.handleInbound({
      project_slug: 'owner',
      user_id: 'u-1',
      active_topic_id: projectTopic,
      event: { type: 'user_message', body: 'How is the convertible note going?' },
      send: (e) => sent.push(e),
    })
    nowMs += 60_000
    await bridge.handleInbound({
      project_slug: 'owner',
      user_id: 'u-1',
      active_topic_id: projectTopic,
      event: { type: 'user_message', body: 'And the launch emails?' },
      send: (e) => sent.push(e),
    })

    // Three rows now PERSIST (opening + 2 stub replies) — pre-fix the stub
    // turns were live-only and never written, so a switch-back showed at
    // most the single re-emitted row.
    const afterTurns = await readAll()
    expect(afterTurns.length).toBe(3)
    const openingAfter = afterTurns.find((t) => t.prompt_id === opening.prompt_id)!
    expect(openingAfter.resolved).toBe(true)
    expect(openingAfter.resolved ? openingAfter.resolution_text : '').toBe(
      'How is the convertible note going?',
    )
    // Exactly one row remains unresolved — the newest stub (the active
    // prompt the live re-emit owns).
    expect(afterTurns.filter((t) => !t.resolved).length).toBe(1)
    expect(afterTurns[0]!.resolved).toBe(false)

    // ── Render the preserved backlog in the landing client. The fetch stub
    // returns the REAL store read (the server history wire shape).
    const historyBody = {
      ok: true,
      turns: afterTurns,
      has_more: false,
      oldest_returned_at: afterTurns[afterTurns.length - 1]!.created_at,
      oldest_returned_prompt_id: afterTurns[afterTurns.length - 1]!.prompt_id,
    }
    installHistoryFetch(historyBody)

    document.body.innerHTML = `
      <header><div id="status"></div></header>
      <div id="log-wrap"><div id="log"></div><button id="new-pill" hidden></button></div>
      <footer><textarea id="input"></textarea><button id="send"></button></footer>
    `
    const log = document.getElementById('log') as HTMLElement
    Object.defineProperty(log, 'scrollHeight', {
      get: () => log.children.length * 50,
      configurable: true,
    })
    Object.defineProperty(log, 'clientHeight', { value: 200, configurable: true })
    const client = new mod.ChatClient({
      url: 'wss://t-test.neutron.test/ws/chat',
      start_token: 't',
      log,
      status: document.getElementById('status') as HTMLElement,
      input: document.getElementById('input') as HTMLTextAreaElement,
      sendBtn: document.getElementById('send') as HTMLButtonElement,
      topic_id: projectTopic,
      now: () => nowMs + 60 * 60_000,
    })
    client.connect()
    const socket = activeSockets[0]!
    socket.fireOpen()
    await flush()

    // The newest unresolved row (active prompt) is re-emitted live (as the
    // server's reEmitActiveSeedPromptIfAny would), carrying its prompt_id.
    const active = afterTurns[0]!
    socket.fireMessage({
      type: 'agent_message',
      body: active.body,
      prompt_id: active.prompt_id,
      topic_id: projectTopic,
      allow_freeform: true,
      options: [],
    })
    await flush()

    // FULL transcript renders: 3 agent runs (opening + 2 stub replies) and
    // 2 user runs (both typed messages) — not just the single latest.
    const agentRuns = log.querySelectorAll('.run.run-agent:not([data-transient="typing"])')
    const userRuns = log.querySelectorAll('.run.run-user')
    expect(agentRuns.length).toBe(3)
    expect(userRuns.length).toBe(2)

    const allText = log.textContent ?? ''
    // The STATUS-summary opening (the OLDEST turn) is present, proving older
    // turns hydrate rather than only the latest.
    expect(allText).toContain("Here's where Acme stands")
    expect(allText).toContain('How is the convertible note going?')
    expect(allText).toContain('And the launch emails?')

    client.dispose()
  })
})
