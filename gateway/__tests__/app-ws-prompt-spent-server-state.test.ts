/**
 * ISSUES #419 — a resurrected Retry button must not RENDER as live.
 *
 * #415 closed the dangerous half: `claim_button_prompt` gates on
 * `ButtonStore.resolve`'s `was_new`, so a second tap never dispatches and the
 * agent never re-runs. It deliberately did not close this half — the clients
 * still DREW the button as live, because the only record that a prompt had been
 * answered was a session-scoped React value. A reply row's TTL is ten years, so
 * the affordance never ages out; any remount put a tappable Retry back on an
 * already-answered prompt, the owner tapped, and nothing happened.
 *
 * The fix makes spent-ness SERVER state: the claim stamps `chosen_value` onto
 * the agent message that carried the prompt, and the surface fans a
 * `prompt_resolved` frame. This file exercises that through the REAL gateway
 * (real `Bun.serve` + real surface + real `AppChatStore` over real SQLite +
 * real `ButtonStore` + the real `buildButtonPromptClaim`) and feeds every
 * inbound frame into a REAL chat-core `SyncEngine`, which is what the clients
 * actually render from.
 *
 * SCOPE IS DELIBERATE. Everything here runs in the GENERAL topic (no
 * `project_id`), which is where the reported Retry bubbles lived. #415 learned
 * this the hard way: a mutation survived a project-scoped test because the view
 * filtered the row out for an unrelated reason, and only a General-scope test
 * killed it.
 *
 * THE REMOUNT IS THE TEST. A test that only proves the button is inert within
 * one session does not cover this bug — the defect needs the component to
 * remount and lose its `useState`. So the durable client Store outlives the
 * "session", and the assertion is made by a FRESH reader with an EMPTY
 * optimistic map, exactly as a remounted surface reads it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AppWsAdapter,
  InMemoryAppWsSessionRegistry,
  createAppWsAuthResolver,
} from '@neutronai/channels/index.ts'
import type { IncomingEvent, Topic } from '@neutronai/channels/types.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { buildButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { AppChatStore, ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import {
  InMemoryStore,
  SyncEngine,
  normalizeInbound,
  normalizePromptResolved,
  spentChoiceValue,
} from '@neutronai/chat-core/index.ts'
import type { ChatMessage } from '@neutronai/chat-core/index.ts'

import { composeHttpHandler } from '../http/compose.ts'
import { createAppWsSurface } from '../http/app-ws-surface.ts'
import { buildButtonPromptClaim } from '../wiring/build-button-prompt-claim.ts'

const TOPIC = 'app:sam'
/** The production Retry affordance, verbatim (`build-live-agent-turn.ts`). */
const RETRY_TURN_VALUE = '__retry_turn__'
/** Ten years — the TTL every reply row carries. These never age out. */
const REPLY_ROW_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1_000

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'spent-419-'))
  seedMigratedDb(join(tmp, 'owner.db'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

interface Harness {
  base: string
  buttonStore: ButtonStore
  chatStore: AppChatStore
  adapter: AppWsAdapter
  /** Every `button_choice` the surface actually dispatched onward. */
  dispatched: string[]
  close(): Promise<void>
}

/** The GENERAL topic — no `project_id`. See the scope note in the header. */
const topic: Topic = {
  topic_id: TOPIC,
  channel_kind: 'app_socket',
  channel_topic_id: TOPIC,
  project_id: null,
  privacy_mode: 'regular',
}

async function startGateway(): Promise<Harness> {
  const registry = new InMemoryAppWsSessionRegistry()
  const chatStore = new AppChatStore({ db })
  const buttonStore = new ButtonStore({ db })
  const dispatched: string[] = []
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async (_e: IncomingEvent) => {} },
    chat_log: chatStore,
  })
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const surface = createAppWsSurface({
    adapter,
    registry,
    auth,
    project_slug: 'demo',
    // The REAL claim, not a lookalike — it is what decides `was_new`.
    claim_button_prompt: buildButtonPromptClaim({ buttonStore }),
    on_button_choice: async ({ choice_value }) => {
      dispatched.push(choice_value)
    },
  })
  const composed = composeHttpHandler({
    appWs: { handler: surface.handler, websocket: surface.websocket },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    buttonStore,
    chatStore,
    adapter,
    dispatched,
    close: async () => {
      await server.stop(true)
    },
  }
}

/**
 * Emit the production-shaped Retry prompt: a real `ButtonStore` row with the
 * ten-year TTL, then the agent message that carries it, through the REAL
 * adapter — so the prompt id lands in the durable row's `meta` the same way it
 * does in production. Returns the prompt id.
 */
async function emitRetryPrompt(h: Harness): Promise<string> {
  const prompt = buildButtonPrompt({
    body: 'That one took too long.',
    options: [{ label: 'A', body: 'Retry', value: RETRY_TURN_VALUE }],
    allow_freeform: true,
    expires_in_ms: REPLY_ROW_TTL_MS,
  })
  const emitted = await h.buttonStore.emit(prompt, { topic_id: TOPIC })
  await h.adapter.send({
    topic,
    text: 'That one took too long.',
    inline_choices: [{ label: 'Retry', callback_data: RETRY_TURN_VALUE }],
    adapter_options: { prompt_id: emitted.prompt_id, allow_freeform: true },
  })
  return emitted.prompt_id
}

/** A durable client store + the sync engine over it — the client's local disk. */
interface ClientDisk {
  store: InMemoryStore
  engine: SyncEngine
}
function freshDisk(): ClientDisk {
  const store = new InMemoryStore()
  return { store, engine: new SyncEngine(store) }
}

/**
 * Feed a raw server frame into the client exactly as `MobileChatSession` /
 * `WebChatSession` do: a `prompt_resolved` goes through `applyPromptResolved`,
 * anything message-shaped through `applyInbound`. Nothing here hand-writes
 * `chosen_value` — the value must arrive from the server or not at all.
 */
async function applyFrame(disk: ClientDisk, raw: unknown): Promise<void> {
  const resolved = normalizePromptResolved(raw)
  if (resolved !== null) {
    await disk.engine.applyPromptResolved(TOPIC, resolved)
    return
  }
  const msg = normalizeInbound(raw)
  if (msg === null) return
  await disk.engine.applyInbound(TOPIC, msg)
}

/**
 * What a REMOUNTED surface renders for the prompt row: it reads the durable
 * local store and has an EMPTY optimistic map (the `useState` / `Map` the
 * remount threw away). Non-null = the row draws collapsed; null = it draws a
 * live, tappable button.
 */
async function spentAfterRemount(disk: ClientDisk, promptId: string): Promise<string | null> {
  const rows = await disk.store.list(TOPIC)
  const row = rows.find((m: ChatMessage) => m.prompt_id === promptId)
  if (row === undefined) throw new Error('the prompt message is not in the local store')
  return spentChoiceValue(row, /* the remount has no session memory */ null)
}

/** Open a socket and collect every inbound frame. */
async function connect(
  h: Harness,
): Promise<{ ws: WebSocket; frames: Record<string, unknown>[]; close(): void }> {
  const frames: Record<string, unknown>[] = []
  const ws = new WebSocket(`${h.base.replace('http', 'ws')}/ws/app/chat?token=sam`)
  ws.addEventListener('message', (ev) => {
    frames.push(JSON.parse(String(ev.data)) as Record<string, unknown>)
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`)))
  })
  const out = { ws, frames, close: (): void => ws.close() }
  await waitFor(() => frames.some((f) => f['type'] === 'session_ready'))
  return out
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('ISSUES #419 — an answered prompt renders as spent from SERVER state', () => {
  it('a REMOUNT still draws the answered Retry as spent (the actual bug)', async () => {
    const h = await startGateway()
    const disk = freshDisk()
    try {
      const conn = await connect(h)
      const promptId = await emitRetryPrompt(h)
      // The client receives the prompt and stores it. Live button, correctly.
      await waitFor(() => conn.frames.some((f) => f['type'] === 'agent_message'))
      for (const f of conn.frames) await applyFrame(disk, f)
      expect(await spentAfterRemount(disk, promptId)).toBeNull()

      // The owner taps Retry.
      conn.ws.send(
        JSON.stringify({
          v: 1,
          type: 'button_choice',
          prompt_id: promptId,
          choice_value: RETRY_TURN_VALUE,
        }),
      )
      await waitFor(() => h.dispatched.length === 1)
      await waitFor(() => conn.frames.some((f) => f['type'] === 'prompt_resolved'))
      for (const f of conn.frames) await applyFrame(disk, f)
      conn.close()

      // REMOUNT: the component is gone, its `chosenByPrompt` with it. Only the
      // durable local store survives — which is precisely the state in which the
      // old code resurrected a live Retry button.
      expect(await spentAfterRemount(disk, promptId)).toBe(RETRY_TURN_VALUE)
    } finally {
      await h.close()
    }
  })

  it('fans a `prompt_resolved` naming the message, the prompt and the value', async () => {
    const h = await startGateway()
    try {
      const conn = await connect(h)
      const promptId = await emitRetryPrompt(h)
      await waitFor(() => conn.frames.some((f) => f['type'] === 'agent_message'))
      const agentMsg = conn.frames.find((f) => f['type'] === 'agent_message')

      conn.ws.send(
        JSON.stringify({
          v: 1,
          type: 'button_choice',
          prompt_id: promptId,
          choice_value: RETRY_TURN_VALUE,
        }),
      )
      await waitFor(() => conn.frames.some((f) => f['type'] === 'prompt_resolved'))
      const resolved = conn.frames.find((f) => f['type'] === 'prompt_resolved')
      expect(resolved).toMatchObject({
        v: 1,
        type: 'prompt_resolved',
        message_id: agentMsg?.['message_id'],
        prompt_id: promptId,
        chosen_value: RETRY_TURN_VALUE,
      })
      conn.close()
    } finally {
      await h.close()
    }
  })

  it('a COLD OPEN (fresh install, resume from 0) replays the prompt already spent', async () => {
    const h = await startGateway()
    try {
      const first = await connect(h)
      const promptId = await emitRetryPrompt(h)
      await waitFor(() => first.frames.some((f) => f['type'] === 'agent_message'))
      first.ws.send(
        JSON.stringify({
          v: 1,
          type: 'button_choice',
          prompt_id: promptId,
          choice_value: RETRY_TURN_VALUE,
        }),
      )
      await waitFor(() => first.frames.some((f) => f['type'] === 'prompt_resolved'))
      first.close()

      // A SECOND device with nothing on disk asks for the whole transcript. It
      // never saw the tap or the live frame, so the only way it can know the
      // prompt is answered is the message itself.
      const second = await connect(h)
      const disk = freshDisk()
      second.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: 0 }))
      await waitFor(() => second.frames.some((f) => f['type'] === 'agent_message'))
      for (const f of second.frames) await applyFrame(disk, f)
      second.close()

      expect(await spentAfterRemount(disk, promptId)).toBe(RETRY_TURN_VALUE)
    } finally {
      await h.close()
    }
  })

  it('a re-tap on a resurrected button is still refused, and HEALS the stale surface', async () => {
    const h = await startGateway()
    try {
      const conn = await connect(h)
      const promptId = await emitRetryPrompt(h)
      await waitFor(() => conn.frames.some((f) => f['type'] === 'agent_message'))
      const tap = JSON.stringify({
        v: 1,
        type: 'button_choice',
        prompt_id: promptId,
        choice_value: RETRY_TURN_VALUE,
      })
      conn.ws.send(tap)
      await waitFor(() => h.dispatched.length === 1)
      await waitFor(() => conn.frames.filter((f) => f['type'] === 'prompt_resolved').length === 1)

      // The second tap — the one a stale surface sends. #415 makes it inert.
      conn.ws.send(tap)
      await waitFor(() => conn.frames.filter((f) => f['type'] === 'prompt_resolved').length === 2)
      // Still exactly one dispatch: the agent did NOT run again.
      expect(h.dispatched).toEqual([RETRY_TURN_VALUE])
      // And the refused tap still told the client the truth, so the surface that
      // sent it corrects itself instead of sitting there offering a dead button.
      expect(conn.frames.filter((f) => f['type'] === 'prompt_resolved')[1]).toMatchObject({
        prompt_id: promptId,
        chosen_value: RETRY_TURN_VALUE,
      })
      conn.close()
    } finally {
      await h.close()
    }
  })

  it('the recorded answer is FIRST-WRITE-WINS — a later tap cannot rewrite it', async () => {
    const h = await startGateway()
    try {
      // A two-option prompt, so a second tap can offer a genuinely different value.
      const prompt = buildButtonPrompt({
        body: 'Import your history?',
        options: [
          { label: 'A', body: 'Yes', value: 'yes' },
          { label: 'B', body: 'Skip', value: 'skip' },
        ],
        expires_in_ms: REPLY_ROW_TTL_MS,
      })
      const conn = await connect(h)
      const emitted = await h.buttonStore.emit(prompt, { topic_id: TOPIC })
      await h.adapter.send({
        topic,
        text: 'Import your history?',
        inline_choices: [
          { label: 'Yes', callback_data: 'yes' },
          { label: 'Skip', callback_data: 'skip' },
        ],
        adapter_options: { prompt_id: emitted.prompt_id },
      })
      await waitFor(() => conn.frames.some((f) => f['type'] === 'agent_message'))

      const send = (value: string): void =>
        conn.ws.send(
          JSON.stringify({
            v: 1,
            type: 'button_choice',
            prompt_id: emitted.prompt_id,
            choice_value: value,
          }),
        )
      send('yes')
      await waitFor(() => conn.frames.filter((f) => f['type'] === 'prompt_resolved').length === 1)
      send('skip')
      await waitFor(() => conn.frames.filter((f) => f['type'] === 'prompt_resolved').length === 2)

      // Both frames report `yes`. The refused tap re-broadcasts the recorded
      // answer; it never overwrites it on the clients or on disk.
      for (const f of conn.frames.filter((fr) => fr['type'] === 'prompt_resolved')) {
        expect(f['chosen_value']).toBe('yes')
      }
      const disk = freshDisk()
      for (const f of conn.frames) await applyFrame(disk, f)
      expect(await spentAfterRemount(disk, emitted.prompt_id)).toBe('yes')
      conn.close()
    } finally {
      await h.close()
    }
  })
})
