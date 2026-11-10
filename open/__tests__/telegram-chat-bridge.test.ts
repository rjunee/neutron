/**
 * Telegram chat bridge — end to end against a local mock of the Bot API.
 *
 * Real pieces: the webhook handler (`buildWebhookHandler`), the decoder, the
 * `TelegramClient` (pointed at a local Bun server that speaks the Bot API), the
 * access file on disk and the bridge. Fake pieces: the agent turn (records the
 * request and replies) and the transcriber (returns a fixed transcript).
 *
 * Pins the acceptance in `docs/spec-items/telegram-group-chats.md`:
 *   - a stranger's message is dropped and costs no download and no turn
 *   - `/start` in a private chat issues a code; `/pair <code>` from an allowed
 *     member admits a second member; `/connect` connects a group
 *   - a photo arrives as a local file in the turn's attachments block
 *   - a voice note arrives as `[voice] <transcript>` with its local path
 *   - an album becomes ONE turn
 *   - the turn runs on the project's web-chat topic (one session per project)
 *   - the reply is posted to the chat, with `[[file: …]]` lines sent as a
 *     document and a video
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { TelegramAccess, telegramAccessPath } from '@neutronai/channels/adapters/telegram/access.ts'
import { TelegramClient } from '@neutronai/channels/adapters/telegram/client.ts'
import { buildWebhookHandler, type TelegramUpdate } from '@neutronai/channels/adapters/telegram/webhook-server.ts'
import type { LiveAgentTurnRequest } from '@neutronai/gateway/http/chat-sender-registry.ts'

import { TRANSCRIPT_MAX_CHARS, buildTelegramChatBridge, type TelegramChatBridge, type TelegramChatBridgeOptions } from '../wiring/telegram-chat.ts'

// ── mock Bot API ────────────────────────────────────────────────────────────
interface ApiCall {
  method: string
  json?: Record<string, unknown>
  form?: Record<string, string>
  files?: Record<string, { name: string; type: string; size: number }>
}
const calls: ApiCall[] = []
const FILES: Record<string, Uint8Array> = {
  'photos/file_1.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
  'photos/file_2.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]),
  'voice/file_3.oga': new Uint8Array([0x4f, 0x67, 0x67, 0x53, 9, 9]),
}
let server: ReturnType<typeof Bun.serve>
let base: string
const TOKEN = '123:test-token'

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const fileMatch = /^\/file\/bot[^/]+\/(.+)$/.exec(url.pathname)
      if (fileMatch !== null) {
        const bytes = FILES[fileMatch[1] ?? '']
        return bytes === undefined ? new Response('nf', { status: 404 }) : new Response(bytes)
      }
      const m = /^\/bot[^/]+\/(\w+)$/.exec(url.pathname)
      if (m === null) return new Response('nf', { status: 404 })
      const method = m[1] as string
      const call: ApiCall = { method }
      if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
        const form = await req.formData()
        call.form = {}
        call.files = {}
        for (const [k, v] of form.entries()) {
          if (typeof v === 'string') call.form[k] = v
          else call.files[k] = { name: (v as File).name, type: (v as File).type, size: (v as File).size }
        }
      } else {
        call.json = (await req.json()) as Record<string, unknown>
      }
      calls.push(call)
      if (method === 'getFile') {
        const id = String(call.json?.['file_id'])
        const path = id === 'photo-a' ? 'photos/file_1.jpg' : id === 'photo-b' ? 'photos/file_2.jpg' : id === 'voice-1' ? 'voice/file_3.oga' : undefined
        return Response.json({ ok: true, result: { file_id: id, ...(path !== undefined ? { file_path: path } : {}) } })
      }
      if (method === 'sendMediaGroup') return Response.json({ ok: true, result: [{ message_id: 1, chat: { id: 1 }, date: 1 }] })
      if (method === 'sendChatAction') return Response.json({ ok: true, result: true })
      return Response.json({ ok: true, result: { message_id: calls.length, chat: { id: 1 }, date: 1 } })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => server.stop(true))

// ── fixture ─────────────────────────────────────────────────────────────────
const PARENT_ONE = 111
const PARENT_TWO = 222
const STRANGER = 999
const GROUP = -100500

let home: string
let turns: LiveAgentTurnRequest[]
let replyFor: (turn: LiveAgentTurnRequest) => string
let bridge: TelegramChatBridge
let handler: (req: Request) => Promise<Response>
let updateId = 0
let messageId = 0

function seedAccess(state: unknown): void {
  const p = telegramAccessPath(home)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(state))
}

beforeEach(() => {
  calls.length = 0
  home = mkdtempSync(join(tmpdir(), 'tg-bridge-'))
  turns = []
  replyFor = () => 'ok'
  seedAccess({
    default_project_id: 'family',
    users: { [String(PARENT_ONE)]: { name: 'Parent One' } },
    chats: {},
  })
  bridge = buildTelegramChatBridge(bridgeOptions())
  handler = buildWebhookHandler({ bot_user_id: 1, secret_token: 'sec', receiver: bridge, rate_limit: { windowMs: 60_000, maxRequests: 1000 } })
})

function bridgeOptions(): TelegramChatBridgeOptions {
  return {
    project_slug: 'inst',
    owner_user_id: 'owner',
    project_topic_id: (p) => `app:owner:${p}`,
    access: new TelegramAccess(telegramAccessPath(home)),
    client: new TelegramClient(TOKEN, { base_url: base }),
    inbox_dir: join(home, 'telegram', 'inbox'),
    seen_path: join(home, 'telegram', 'seen-updates.json'),
    chat_turn: async (turn) => {
      turns.push(turn)
      turn.send({ type: 'agent_message', body: replyFor(turn) })
      return { ok: true }
    },
    transcribe: async () => 'she read all four words',
    log: { info: () => undefined, warn: () => undefined },
    album_window_ms: 30,
  }
}
afterEach(() => rmSync(home, { recursive: true, force: true }))

async function post(message: Record<string, unknown>, opts: { from?: number; chat?: { id: number; type: string; title?: string } } = {}): Promise<void> {
  const fromId = opts.from ?? PARENT_ONE
  const update = {
    update_id: ++updateId,
    message: {
      message_id: ++messageId,
      from: { id: fromId, first_name: fromId === PARENT_ONE ? 'Parent' : fromId === PARENT_TWO ? 'Second' : 'Who', last_name: fromId === PARENT_ONE ? 'One' : 'Two' },
      chat: opts.chat ?? { id: GROUP, type: 'group', title: 'Home' },
      date: 1700000000,
      ...message,
    },
  } as TelegramUpdate
  const res = await handler(
    new Request('http://x/webhook/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'sec', 'content-type': 'application/json' },
      body: JSON.stringify(update),
    }),
  )
  expect(res.status).toBe(200)
}

const sentTexts = (): string[] => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.json?.['text']))

describe('telegram chat bridge', () => {
  test('nothing is delivered until a group is connected; /connect by an allowed member connects it', async () => {
    await post({ text: 'hello before connect' })
    await bridge.idle()
    expect(turns.length).toBe(0)

    await post({ text: '/connect@family_bot' })
    await bridge.idle()
    expect(sentTexts()).toContain('This chat is connected.')
    expect(new TelegramAccess(telegramAccessPath(home)).chatProject(String(GROUP))).toBe('family')

    await post({ text: 'hello after connect' })
    await bridge.idle()
    expect(turns.length).toBe(1)
    const t = turns[0] as LiveAgentTurnRequest
    expect(t.topic_id).toBe('app:owner:family')
    expect(t.project_id).toBe('family')
    expect(t.user_id).toBe('owner')
    expect(t.user_text).toBe(`[telegram chat=${GROUP} from="Parent One" user=${PARENT_ONE} msg=${messageId}]\nhello after connect`)
    expect(sentTexts()).toContain('ok')
  })

  test("a stranger's message in a connected group is dropped: no turn, no download, no reply", async () => {
    seedAccess({ default_project_id: 'family', users: { [String(PARENT_ONE)]: { name: 'P' } }, chats: { [String(GROUP)]: { project_id: 'family' } } })
    await post({ caption: 'hi', photo: [{ file_id: 'photo-a' }] }, { from: STRANGER })
    await post({ text: '/connect' }, { from: STRANGER })
    await post({ text: '/pair ABCDEF' }, { from: STRANGER })
    await bridge.idle()
    expect(turns.length).toBe(0)
    expect(calls).toEqual([])
  })

  test('a second parent pairs: /start in private gives a code, /pair in the group admits them', async () => {
    seedAccess({ default_project_id: 'family', users: { [String(PARENT_ONE)]: { name: 'P' } }, chats: { [String(GROUP)]: { project_id: 'family' } } })
    await post({ text: '/start' }, { from: PARENT_TWO, chat: { id: PARENT_TWO, type: 'private' } })
    await bridge.idle()
    const codeMsg = sentTexts().find((t) => t.startsWith('Your pairing code is')) ?? ''
    const code = /code is ([A-Z2-9]{6})/.exec(codeMsg)?.[1]
    expect(code).toBeDefined()
    // /start in the group never shows a code.
    calls.length = 0
    await post({ text: '/start' }, { from: PARENT_TWO })
    await bridge.idle()
    expect(calls).toEqual([])

    await post({ text: `/pair ${code}` })
    await bridge.idle()
    expect(sentTexts()).toContain('Paired Second Two.')
    await post({ text: 'from the second parent' }, { from: PARENT_TWO })
    await bridge.idle()
    expect(turns.length).toBe(1)
    expect(turns[0]?.user_text).toContain(`from="Second Two" user=${PARENT_TWO}`)
  })

  test('a photo and a voice note arrive as local files; the voice note reads [voice] <transcript>', async () => {
    seedAccess({ default_project_id: 'family', users: { [String(PARENT_ONE)]: { name: 'P' } }, chats: { [String(GROUP)]: { project_id: 'family' } } })
    await post({ caption: 'her page', photo: [{ file_id: 'thumb' }, { file_id: 'photo-a', file_unique_id: 'ua' }] })
    await post({ voice: { file_id: 'voice-1', file_unique_id: 'uv', mime_type: 'audio/ogg' } })
    await bridge.idle()
    expect(turns.length).toBe(2)
    const photoTurn = turns[0]?.user_text ?? ''
    const photoPath = /- (\S+\.jpg) \(image\/jpeg\)/.exec(photoTurn)?.[1] ?? ''
    expect(photoPath.startsWith(join(home, 'telegram', 'inbox', String(GROUP)))).toBe(true)
    expect(Array.from(readFileSync(photoPath))).toEqual(Array.from(FILES['photos/file_1.jpg'] as Uint8Array))
    expect(photoTurn.endsWith('\nher page')).toBe(true)

    const voiceTurn = turns[1]?.user_text ?? ''
    expect(voiceTurn).toContain('voice note; transcript is the message below')
    expect(voiceTurn.endsWith('\n[voice] she read all four words')).toBe(true)
    const voicePath = /- (\S+\.ogg) \(audio\/ogg\)/.exec(voiceTurn)?.[1] ?? ''
    expect(existsSync(voicePath)).toBe(true)
    expect(readFileSync(`${voicePath}.txt`, 'utf8')).toBe('she read all four words')
  })

  test('an album becomes one turn', async () => {
    seedAccess({ default_project_id: 'family', users: { [String(PARENT_ONE)]: { name: 'P' } }, chats: { [String(GROUP)]: { project_id: 'family' } } })
    await post({ media_group_id: 'alb', caption: 'both pages', photo: [{ file_id: 'photo-a' }] })
    await post({ media_group_id: 'alb', photo: [{ file_id: 'photo-b' }] })
    await bridge.idle()
    expect(turns.length).toBe(1)
    const text = turns[0]?.user_text ?? ''
    expect((text.match(/\(image\/jpeg\)/g) ?? []).length).toBe(2)
    expect(text.endsWith('\nboth pages')).toBe(true)
  })

  test('a reply with [[file: …]] lines posts the text, then a document and a video', async () => {
    seedAccess({ default_project_id: 'family', users: { [String(PARENT_ONE)]: { name: 'P' } }, chats: { [String(GROUP)]: { project_id: 'family' } } })
    const pdf = join(home, 'sheet.pdf')
    const mp4 = join(home, 'reply.mp4')
    writeFileSync(pdf, '%PDF-1.4 test')
    writeFileSync(mp4, 'fake-mp4')
    replyFor = () => `Here is tomorrow's sheet and the reply.\n[[file: ${pdf}]]\n[[file: ${mp4}]]\n[[file: ${join(home, 'missing.pdf')}]]`
    await post({ text: 'send the sheet' })
    await bridge.idle()
    const methods = calls.map((c) => c.method).filter((m) => m !== 'sendChatAction')
    expect(methods).toEqual(['sendMessage', 'sendDocument', 'sendVideo', 'sendMessage'])
    expect(sentTexts()[0]).toBe("Here is tomorrow's sheet and the reply.")
    const doc = calls.find((c) => c.method === 'sendDocument')
    expect(doc?.form?.['chat_id']).toBe(String(GROUP))
    expect(doc?.files?.['document']).toMatchObject({ name: 'sheet.pdf', type: 'application/pdf' })
    expect(calls.find((c) => c.method === 'sendVideo')?.files?.['video']?.name).toBe('reply.mp4')
    expect(sentTexts()[1]).toContain('Could not send one file')
  })

  test('two photos in one reply go out as one album', async () => {
    seedAccess({ default_project_id: 'family', users: { [String(PARENT_ONE)]: { name: 'P' } }, chats: { [String(GROUP)]: { project_id: 'family' } } })
    const a = join(home, 'a.png')
    const b = join(home, 'b.jpg')
    writeFileSync(a, 'png')
    writeFileSync(b, 'jpg')
    replyFor = () => `[[file: ${a}]]\n[[file: ${b}]]`
    await post({ text: 'previews?' })
    await bridge.idle()
    const group = calls.find((c) => c.method === 'sendMediaGroup')
    expect(JSON.parse(group?.form?.['media'] ?? '[]')).toEqual([
      { type: 'photo', media: 'attach://file0' },
      { type: 'photo', media: 'attach://file1' },
    ])
    expect(sentTexts()).toEqual([])
  })

  test('a re-sent update runs once', async () => {
    seedAccess({ default_project_id: 'family', users: { [String(PARENT_ONE)]: { name: 'P' } }, chats: { [String(GROUP)]: { project_id: 'family' } } })
    const update = { update_id: 77, message: { message_id: 4242, from: { id: PARENT_ONE, first_name: 'P' }, chat: { id: GROUP, type: 'group' }, date: 1, text: 'once' } }
    for (let i = 0; i < 2; i++) {
      await handler(new Request('http://x/webhook/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'sec' }, body: JSON.stringify(update) }))
    }
    await bridge.idle()
    expect(turns.length).toBe(1)
  })

  test('no agent configured: the chat is told, nothing crashes', async () => {
    seedAccess({ default_project_id: 'family', users: { [String(PARENT_ONE)]: { name: 'P' } }, chats: { [String(GROUP)]: { project_id: 'family' } } })
    const noAgent = buildTelegramChatBridge({
      project_slug: 'inst',
      owner_user_id: 'owner',
      project_topic_id: (p) => `app:owner:${p}`,
      access: new TelegramAccess(telegramAccessPath(home)),
      client: new TelegramClient(TOKEN, { base_url: base }),
      inbox_dir: join(home, 'inbox'),
      seen_path: join(home, 'seen.json'),
      chat_turn: null,
      transcribe: async () => null,
      log: { info: () => undefined, warn: () => undefined },
    })
    await noAgent.receive({
      channel_kind: 'telegram',
      channel_topic_id: String(GROUP),
      user: { channel_user_id: String(PARENT_ONE), display_name: 'P' },
      body: { text: 'hi' },
      event_id: 'x:1',
      received_at: 1,
      adapter_metadata: { chat_id: String(GROUP), chat_type: 'group', message_id: 1 },
    })
    await noAgent.idle()
    expect(sentTexts()[0]).toContain('no AI credential')
  })

  test('a message in a forum topic is answered in that topic', async () => {
    seedAccess({ default_project_id: 'family', users: { [String(PARENT_ONE)]: { name: 'P' } }, chats: { [String(GROUP)]: { project_id: 'family' } } })
    await post({ text: 'in a topic', message_thread_id: 77 }, { chat: { id: GROUP, type: 'supergroup' } })
    await bridge.idle()
    expect(turns.length).toBe(1)
    const reply = calls.find((c) => c.method === 'sendMessage')
    expect(reply?.json?.['message_thread_id']).toBe(77)
    expect(calls.find((c) => c.method === 'sendChatAction')?.json?.['message_thread_id']).toBe(77)
  })

  test('a re-sent update runs once even after a restart', async () => {
    seedAccess({ default_project_id: 'family', users: { [String(PARENT_ONE)]: { name: 'P' } }, chats: { [String(GROUP)]: { project_id: 'family' } } })
    const update = { update_id: 78, message: { message_id: 5151, from: { id: PARENT_ONE, first_name: 'P' }, chat: { id: GROUP, type: 'group' }, date: 1, text: 'once across restarts' } }
    const send = (h: (req: Request) => Promise<Response>) =>
      h(new Request('http://x/webhook/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'sec' }, body: JSON.stringify(update) }))
    await send(handler)
    await bridge.idle()
    // A new bridge over the same NEUTRON_HOME is a restarted process.
    const restarted = buildTelegramChatBridge(bridgeOptions())
    await send(buildWebhookHandler({ bot_user_id: 1, secret_token: 'sec', receiver: restarted }))
    await restarted.idle()
    expect(turns.length).toBe(1)
  })

  test('a long transcript is cut before it reaches the turn', async () => {
    seedAccess({ default_project_id: 'family', users: { [String(PARENT_ONE)]: { name: 'P' } }, chats: { [String(GROUP)]: { project_id: 'family' } } })
    const long = buildTelegramChatBridge({ ...bridgeOptions(), transcribe: async () => 'word '.repeat(5000) })
    await long.receive({
      channel_kind: 'telegram',
      channel_topic_id: String(GROUP),
      user: { channel_user_id: String(PARENT_ONE), display_name: 'P' },
      body: { text: '', attachments: [{ kind: 'voice', file_id: 'voice-1' }] },
      event_id: `${GROUP}:9001`,
      received_at: 1,
      adapter_metadata: { chat_id: String(GROUP), chat_type: 'group', message_id: 9001 },
    })
    await long.idle()
    const text = turns[0]?.user_text ?? ''
    expect(text).toContain('[transcript truncated]')
    expect(text.length).toBeLessThan(TRANSCRIPT_MAX_CHARS + 600)
    // The captionless note's transcript appears once, as the message.
    expect(text).toContain('transcript is the message below')
  })

  test('close() starts a gathered album and waits for running turns', async () => {
    seedAccess({ default_project_id: 'family', users: { [String(PARENT_ONE)]: { name: 'P' } }, chats: { [String(GROUP)]: { project_id: 'family' } } })
    const slow = buildTelegramChatBridge({ ...bridgeOptions(), album_window_ms: 60_000 })
    const h = buildWebhookHandler({ bot_user_id: 1, secret_token: 'sec', receiver: slow })
    await h(new Request('http://x/webhook/telegram', {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'sec' },
      body: JSON.stringify({ update_id: 90, message: { message_id: 9100, from: { id: PARENT_ONE, first_name: 'P' }, chat: { id: GROUP, type: 'group' }, date: 1, media_group_id: 'late', photo: [{ file_id: 'photo-a' }] } }),
    }))
    expect(turns.length).toBe(0)
    await slow.close(5_000)
    expect(turns.length).toBe(1)
    // Closed: nothing new is accepted.
    await slow.receive({
      channel_kind: 'telegram',
      channel_topic_id: String(GROUP),
      user: { channel_user_id: String(PARENT_ONE), display_name: 'P' },
      body: { text: 'after close' },
      event_id: `${GROUP}:9200`,
      received_at: 1,
      adapter_metadata: { chat_id: String(GROUP), chat_type: 'group', message_id: 9200 },
    })
    await slow.idle()
    expect(turns.length).toBe(1)
  })
})
