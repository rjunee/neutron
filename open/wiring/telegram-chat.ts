/**
 * Telegram chat → the project's live agent session, and the agent's reply →
 * back to the same Telegram chat.
 *
 * WHAT IT IS. The receiver the Telegram webhook hands decoded updates to. Before
 * it existed the webhook decoded an update and gave it to a router whose topic
 * handler was a no-op, so a Telegram message reached nothing. This module is the
 * missing half:
 *
 *   1. ACCESS. A message is delivered only when its sender is on the instance's
 *      Telegram access list AND its chat is connected to a project
 *      (`channels/adapters/telegram/access.ts`). Everything else is dropped with
 *      no reply, except three commands:
 *        - `/start` in a private chat — a person not yet allowed gets a pairing
 *          code; an allowed person is told so.
 *        - `/pair <code>` from an allowed person — admits whoever holds the code.
 *          This is how a group gains its second member without the operator.
 *        - `/connect` from an allowed person inside a group — connects the group
 *          to the default project.
 *   2. MEDIA. Photos, voice notes, audio, documents and videos are downloaded
 *      (after the access check, so a stranger never costs a download) into
 *      `<NEUTRON_HOME>/telegram/inbox/<chat>/`. Voice notes and audio are
 *      transcribed with the SAME transcriber the web chat uses (the owner's
 *      Settings choice: local whisper.cpp or the hosted API). The items of one
 *      album arrive as separate updates and are gathered into one turn.
 *   3. THE TURN. The message becomes a turn on the project's warm session — the
 *      SAME session the web chat drives for that project (same topic key), so one
 *      project has one conversation whichever surface a message came from. The
 *      turn text starts with one header line naming the chat and the sender:
 *
 *        [telegram chat=<chat_id> from="<name>" user=<user_id> msg=<message_id>]
 *
 *      followed by a `<user_attachments>` block of local paths (with the
 *      transcript inline for audio) when files came with it, then the words. A
 *      voice note with no caption reads `[voice] <transcript>`.
 *   4. THE REPLY. The agent's reply goes back to the chat it came from. Lines of
 *      the form `[[file: /absolute/path]]` are lifted out and posted as photos,
 *      videos or documents (`channels/adapters/telegram/reply-files.ts`).
 *
 * The webhook must answer Telegram quickly or Telegram re-sends the update, so
 * `receive` returns as soon as the message is accepted; the turn runs in the
 * background. Updates are de-duplicated by `<chat>:<message>`.
 *
 * Nothing in the turn shape is Telegram-only by design: another messaging
 * channel can produce the same header + attachments + text and reuse the agent
 * side unchanged.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { IncomingEvent, IncomingEventReceiver } from '@neutronai/channels/types.ts'
import type { TelegramClient, TelegramUpload } from '@neutronai/channels/adapters/telegram/client.ts'
import type { TelegramAccess } from '@neutronai/channels/adapters/telegram/access.ts'
import {
  isTelegramAttachmentRef,
  type TelegramAttachmentRef,
} from '@neutronai/channels/adapters/telegram/webhook-server.ts'
import {
  TELEGRAM_UPLOAD_MAX_BYTES,
  chunkTelegramText,
  classifyReplyFile,
  extractReplyFiles,
  planReplyUploads,
} from '@neutronai/channels/adapters/telegram/reply-files.ts'
import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'
import type { LiveAgentTurnRequest } from '@neutronai/gateway/http/chat-sender-registry.ts'

/** Bot API downloads are capped at 20 MB for bots. */
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024
/** How long to wait for the rest of an album after its first item. */
export const ALBUM_WINDOW_MS = 1500
const SEEN_EVENT_CAP = 1000

export interface TelegramChatLog {
  info: (event: string, meta?: Record<string, unknown>) => void
  warn: (event: string, meta?: Record<string, unknown>) => void
}

export interface TelegramChatBridgeOptions {
  /** This instance's slug, carried on every turn. */
  project_slug: string
  /** The owner's user id: turns run on the owner's warm session for the project. */
  owner_user_id: string
  /** The topic key the web chat uses for a project, so both surfaces share one session. */
  project_topic_id: (project_id: string) => string
  access: TelegramAccess
  client: Pick<TelegramClient, 'sendMessage' | 'sendChatAction' | 'getFile' | 'downloadFile' | 'sendFile' | 'sendMediaGroup'>
  /** `<NEUTRON_HOME>/telegram/inbox` */
  inbox_dir: string
  /** Runs one turn on the live agent. Null when no agent is configured. */
  chat_turn: ((turn: LiveAgentTurnRequest) => Promise<unknown>) | null
  /** The shared voice-note transcriber; null result = no transcript. */
  transcribe: (input: { bytes: Uint8Array; content_type: string; hash: string }) => Promise<string | null>
  log: TelegramChatLog
  now?: () => number
  album_window_ms?: number
  /** Read a reply file; injectable for tests. */
  read_file?: (path: string) => Uint8Array
  /** Size of a reply file, or null when it is not a regular file. */
  file_size?: (path: string) => number | null
}

interface Accepted {
  event: IncomingEvent
  chat_id: string
  project_id: string
}

interface SavedAttachment {
  path: string
  content_type: string
  kind: TelegramAttachmentRef['kind']
  transcript: string | null
}

export interface TelegramChatBridge extends IncomingEventReceiver {
  /** Resolves when every turn started so far has finished (tests, shutdown). */
  idle(): Promise<void>
}

export function buildTelegramChatBridge(opts: TelegramChatBridgeOptions): TelegramChatBridge {
  const now = opts.now ?? Date.now
  const albumWindow = opts.album_window_ms ?? ALBUM_WINDOW_MS
  const readFile = opts.read_file ?? ((p: string) => new Uint8Array(readFileSync(p)))
  const fileSize =
    opts.file_size ??
    ((p: string): number | null => {
      try {
        const st = statSync(p)
        return st.isFile() ? st.size : null
      } catch {
        return null
      }
    })
  const seen = new Set<string>()
  const albums = new Map<string, { items: Accepted[]; timer: ReturnType<typeof setTimeout> }>()
  const inFlight = new Set<Promise<void>>()

  const track = (p: Promise<void>): void => {
    inFlight.add(p)
    void p.finally(() => inFlight.delete(p))
  }

  const say = async (chat_id: string, text: string): Promise<void> => {
    try {
      await opts.client.sendMessage({ chat_id, text })
    } catch (err) {
      opts.log.warn('telegram_send_failed', { chat: chat_id, error: errMsg(err) })
    }
  }

  const handleCommand = async (event: IncomingEvent, chat_id: string, chat_type: string): Promise<boolean> => {
    const m = /^\/(start|pair|connect)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(event.body.text.trim())
    if (m === null) return false
    const command = (m[1] ?? '').toLowerCase()
    const arg = (m[2] ?? '').trim()
    const user_id = event.user.channel_user_id
    const allowed = opts.access.isAllowedUser(user_id)
    if (command === 'start') {
      // Private chats only: a code shown in a group is a code anyone there can use.
      if (chat_type !== 'private') return true
      if (allowed) {
        await say(chat_id, "You're already paired.")
        return true
      }
      const code = opts.access.issueCode({ user_id, name: event.user.display_name })
      await say(
        chat_id,
        `Your pairing code is ${code}. Ask someone who is already paired to send /pair ${code} in your group. The code works for one hour.`,
      )
      opts.log.info('telegram_pairing_code_issued', { user: user_id })
      return true
    }
    // `/pair` and `/connect` from a stranger get no answer, so the bot does not
    // confirm to a stranger that it is listening.
    if (!allowed) return true
    if (command === 'pair') {
      if (chat_type !== 'private' && opts.access.chatProject(chat_id) === null) return true
      const r = opts.access.pair({ code: arg, by_user_id: user_id })
      if (r.ok) {
        opts.log.info('telegram_user_paired', { user: r.user_id, by: user_id })
        await say(chat_id, `Paired ${r.name}.`)
      } else {
        await say(chat_id, 'That code is unknown or has expired. Ask for a new one with /start in a private chat with me.')
      }
      return true
    }
    // connect
    const title = typeof event.adapter_metadata?.['chat_title'] === 'string' ? (event.adapter_metadata['chat_title'] as string) : undefined
    const r = opts.access.connect({ chat_id, chat_type, by_user_id: user_id, ...(title !== undefined ? { title } : {}) })
    if (r.ok) {
      opts.log.info('telegram_chat_connected', { chat: chat_id, project: r.project_id, by: user_id })
      await say(chat_id, r.already ? 'This chat is already connected.' : 'This chat is connected.')
    } else if (r.reason === 'not_a_group') {
      await say(chat_id, 'Send /connect inside the group you want to connect.')
    } else if (r.reason === 'no_default_project') {
      await say(chat_id, 'No project is set up for Telegram on this instance yet.')
    }
    return true
  }

  const saveAttachment = async (chat_id: string, message_id: string, ref: TelegramAttachmentRef): Promise<SavedAttachment | null> => {
    if (ref.file_size !== undefined && ref.file_size > TELEGRAM_DOWNLOAD_MAX_BYTES) {
      opts.log.warn('telegram_attachment_too_large', { chat: chat_id, kind: ref.kind, bytes: ref.file_size })
      return null
    }
    try {
      const file = await opts.client.getFile(ref.file_id)
      if (file.file_path === undefined) return null
      const bytes = await opts.client.downloadFile(file.file_path, TELEGRAM_DOWNLOAD_MAX_BYTES)
      const { ext, content_type } = attachmentType(ref, file.file_path)
      const dir = join(opts.inbox_dir, safeSegment(chat_id))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, `${stamp(now())}-${safeSegment(message_id)}-${ref.kind}.${ext}`)
      writeFileSync(path, bytes, { mode: 0o600 })
      let transcript: string | null = null
      if (ref.kind === 'voice' || ref.kind === 'audio') {
        try {
          transcript = await opts.transcribe({ bytes, content_type, hash: ref.file_unique_id ?? ref.file_id })
        } catch (err) {
          opts.log.warn('telegram_transcription_failed', { chat: chat_id, error: errMsg(err) })
        }
        if (transcript !== null) writeFileSync(`${path}.txt`, transcript, { mode: 0o600 })
      }
      return { path, content_type, kind: ref.kind, transcript }
    } catch (err) {
      opts.log.warn('telegram_attachment_download_failed', { chat: chat_id, kind: ref.kind, error: errMsg(err) })
      return null
    }
  }

  const sendReply = async (chat_id: string, body: string): Promise<void> => {
    const { text, files, rejected } = extractReplyFiles(body)
    for (const part of chunkTelegramText(text)) {
      if (part.trim().length > 0) await say(chat_id, part)
    }
    const uploads: Array<{ kind: 'photo' | 'video' | 'document'; path: string; upload: TelegramUpload }> = []
    const skipped = [...rejected]
    for (const path of files) {
      const size = fileSize(path)
      if (size === null || size > TELEGRAM_UPLOAD_MAX_BYTES) {
        skipped.push(path)
        continue
      }
      const c = classifyReplyFile(path)
      try {
        uploads.push({ kind: c.kind, path, upload: { bytes: readFile(path), filename: c.filename, content_type: c.content_type } })
      } catch {
        skipped.push(path)
      }
    }
    for (const step of planReplyUploads(uploads)) {
      try {
        if ('album' in step) {
          await opts.client.sendMediaGroup({
            chat_id,
            items: step.album.map((u) => ({ type: u.kind === 'video' ? 'video' : 'photo', file: u.upload })),
          })
        } else {
          const u = step.single
          await opts.client.sendFile({
            method: u.kind === 'photo' ? 'sendPhoto' : u.kind === 'video' ? 'sendVideo' : 'sendDocument',
            chat_id,
            file: u.upload,
          })
        }
      } catch (err) {
        opts.log.warn('telegram_file_send_failed', { chat: chat_id, error: errMsg(err) })
        const names = 'album' in step ? step.album.map((u) => u.upload.filename) : [step.single.upload.filename]
        await say(chat_id, `Could not send ${names.join(', ')}.`)
      }
    }
    if (skipped.length > 0) {
      opts.log.warn('telegram_reply_files_skipped', { chat: chat_id, count: skipped.length })
      await say(chat_id, `Could not send ${skipped.length === 1 ? 'one file' : `${skipped.length} files`} (missing, not absolute, or over 50 MB).`)
    }
  }

  const runTurn = async (items: Accepted[]): Promise<void> => {
    const first = items[0]
    if (first === undefined) return
    const { chat_id, project_id } = first
    if (opts.chat_turn === null) {
      await say(chat_id, "I can't answer yet: this instance has no AI credential configured.")
      return
    }
    void opts.client.sendChatAction({ chat_id, action: 'typing' }).catch(() => undefined)
    const saved: SavedAttachment[] = []
    const texts: string[] = []
    for (const a of items) {
      const message_id = String(a.event.adapter_metadata?.['message_id'] ?? '')
      for (const ref of a.event.body.attachments ?? []) {
        if (!isTelegramAttachmentRef(ref)) continue
        const s = await saveAttachment(chat_id, message_id, ref)
        if (s !== null) saved.push(s)
      }
      const t = a.event.body.text.trim()
      if (t.length > 0) texts.push(t)
    }
    const user_text = composeTelegramTurnText({ items: items.map((i) => i.event), chat_id, saved, texts })
    // Replies are posted in order, one after the other, even when the runner
    // emits several messages for one turn.
    let chain: Promise<void> = Promise.resolve()
    const send = (ev: ChatOutbound): void => {
      if (ev.type === 'agent_message') {
        const body = ev.body
        chain = chain.then(() => sendReply(chat_id, body)).catch((err) => {
          opts.log.warn('telegram_reply_failed', { chat: chat_id, error: errMsg(err) })
        })
      } else if (ev.type === 'agent_typing_start') {
        void opts.client.sendChatAction({ chat_id, action: 'typing' }).catch(() => undefined)
      }
    }
    opts.log.info('telegram_turn_dispatched', { chat: chat_id, project: project_id, messages: items.length, files: saved.length })
    try {
      await opts.chat_turn({
        project_slug: opts.project_slug,
        user_id: opts.owner_user_id,
        topic_id: opts.project_topic_id(project_id),
        project_id,
        user_text,
        send,
        observed_at: first.event.received_at,
      })
    } catch (err) {
      opts.log.warn('telegram_turn_failed', { chat: chat_id, error: errMsg(err) })
      chain = chain.then(() => say(chat_id, 'Something went wrong handling that message. Please send it again.'))
    }
    await chain
  }

  const flushAlbum = (key: string): void => {
    const album = albums.get(key)
    if (album === undefined) return
    albums.delete(key)
    track(runTurn(album.items).catch((err) => opts.log.warn('telegram_turn_failed', { error: errMsg(err) })))
  }

  return {
    async receive(event: IncomingEvent): Promise<void> {
      if (event.channel_kind !== 'telegram') return
      const chat_id = String(event.adapter_metadata?.['chat_id'] ?? event.channel_topic_id.split(':')[0] ?? '')
      const chat_type = String(event.adapter_metadata?.['chat_type'] ?? '')
      if (chat_id.length === 0) return
      // An edit is not a new message; acting on it would run a second turn.
      if (event.adapter_metadata?.['edited'] === true) return
      if (seen.has(event.event_id)) return
      seen.add(event.event_id)
      if (seen.size > SEEN_EVENT_CAP) {
        const oldest = seen.values().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
      if (await handleCommand(event, chat_id, chat_type)) return
      const project_id = opts.access.deliveryProject({ chat_id, user_id: event.user.channel_user_id })
      if (project_id === null) {
        opts.log.info('telegram_message_dropped', { chat: chat_id, user: event.user.channel_user_id })
        return
      }
      const accepted: Accepted = { event, chat_id, project_id }
      const group = event.adapter_metadata?.['media_group_id']
      if (typeof group === 'string' && group.length > 0) {
        const key = `${chat_id}:${group}`
        const album = albums.get(key)
        if (album !== undefined) {
          album.items.push(accepted)
          return
        }
        albums.set(key, { items: [accepted], timer: setTimeout(() => flushAlbum(key), albumWindow) })
        return
      }
      track(runTurn([accepted]).catch((err) => opts.log.warn('telegram_turn_failed', { error: errMsg(err) })))
    },
    async idle(): Promise<void> {
      for (const [key, album] of albums) {
        clearTimeout(album.timer)
        flushAlbum(key)
      }
      while (inFlight.size > 0) await Promise.all([...inFlight])
    },
  }
}

/**
 * The turn text for one Telegram message (or one album): the header line, the
 * attachments block, then the words. Exported for tests and for any other
 * messaging channel that wants the same shape.
 */
export function composeTelegramTurnText(input: {
  items: ReadonlyArray<IncomingEvent>
  chat_id: string
  saved: ReadonlyArray<SavedAttachment>
  texts: ReadonlyArray<string>
}): string {
  const first = input.items[0]
  const from = (first?.user.display_name ?? '').replace(/["\n\r]/g, '')
  const user = first?.user.channel_user_id ?? ''
  const msg = String(first?.adapter_metadata?.['message_id'] ?? '')
  const lines: string[] = [`[telegram chat=${input.chat_id} from="${from}" user=${user} msg=${msg}]`]
  if (input.saved.length > 0) {
    lines.push(
      '<user_attachments>',
      'The user attached these local files with their message. Open images and PDFs',
      'with the Read tool. Voice notes and audio carry their transcript inline below;',
      'do not Read the raw audio bytes:',
    )
    for (const s of input.saved) {
      if (s.kind === 'voice' || s.kind === 'audio') {
        lines.push(
          s.transcript !== null
            ? `- ${s.path} (${s.content_type}) — ${s.kind === 'voice' ? 'voice note' : 'audio'}; transcript: ${oneLine(s.transcript)}`
            : `- ${s.path} (${s.content_type}) — ${s.kind === 'voice' ? 'voice note' : 'audio'}; transcription unavailable`,
        )
      } else {
        lines.push(`- ${s.path} (${s.content_type})`)
      }
    }
    lines.push('</user_attachments>')
  }
  if (input.texts.length > 0) {
    lines.push(input.texts.join('\n\n'))
  } else {
    const voice = input.saved.find((s) => s.kind === 'voice' || s.kind === 'audio')
    if (voice !== undefined) {
      lines.push(`[voice] ${voice.transcript !== null ? oneLine(voice.transcript) : '(transcription unavailable)'}`)
    } else if (input.saved.length > 0) {
      lines.push('Sent an attachment.')
    }
  }
  return lines.join('\n')
}

function attachmentType(ref: TelegramAttachmentRef, file_path: string): { ext: string; content_type: string } {
  const fromPath = /\.([A-Za-z0-9]{1,8})$/.exec(file_path)?.[1]?.toLowerCase()
  const fromName = ref.file_name !== undefined ? /\.([A-Za-z0-9]{1,8})$/.exec(ref.file_name)?.[1]?.toLowerCase() : undefined
  switch (ref.kind) {
    case 'photo':
      return { ext: 'jpg', content_type: 'image/jpeg' }
    case 'voice':
      return { ext: 'ogg', content_type: 'audio/ogg' }
    case 'video':
    case 'video_note':
      return { ext: 'mp4', content_type: ref.mime_type ?? 'video/mp4' }
    case 'audio': {
      const ext = fromName ?? fromPath ?? 'mp3'
      return { ext, content_type: ref.mime_type ?? AUDIO_MIME[ext] ?? 'audio/mpeg' }
    }
    case 'document': {
      const ext = fromName ?? fromPath ?? 'bin'
      return { ext, content_type: ref.mime_type ?? 'application/octet-stream' }
    }
  }
}

const AUDIO_MIME: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' }

function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || '_'
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
