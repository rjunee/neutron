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
 * background. Updates are de-duplicated by `<chat>:<message>`, remembered on disk
 * so a re-sent update runs once across a restart. A message in a forum topic is
 * answered in that topic.
 *
 * Nothing in the turn shape is Telegram-only by design: another messaging
 * channel can produce the same header + attachments + text and reuse the agent
 * side unchanged.
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import type { IncomingEvent, IncomingEventReceiver } from '@neutronai/channels/types.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { LogFields } from '@neutronai/logger'
import { TelegramRetryAfterError, type TelegramClient } from '@neutronai/channels/adapters/telegram/client.ts'
import type { TelegramAccess } from '@neutronai/channels/adapters/telegram/access.ts'
import {
  isTelegramAttachmentRef,
  type TelegramAttachmentRef,
} from '@neutronai/channels/adapters/telegram/webhook-server.ts'
import {
  TELEGRAM_PHOTO_MAX_BYTES,
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
/** How many recent update ids are remembered (on disk) to run a re-sent update once. */
export const SEEN_EVENT_CAP = 1000
/** A transcript longer than this is cut, as the web chat's attachment path does. */
export const TRANSCRIPT_MAX_CHARS = 4000
/** Total bytes of files one reply may upload; files past it are reported, not sent. */
export const REPLY_FILES_MAX_TOTAL_BYTES = 100 * 1024 * 1024
/** How long shutdown waits for turns already running. */
export const SHUTDOWN_DRAIN_MS = 10_000

export interface TelegramChatLog {
  info: (event: string, meta?: LogFields) => void
  warn: (event: string, meta?: LogFields) => void
}

export interface TelegramChatBridgeOptions {
  /** This instance's slug, carried on every turn. */
  project_slug: string
  /** The owner's user id: turns run on the owner's warm session for the project. */
  owner_user_id: string
  /** The topic key the web chat uses for a project, so both surfaces share one session. */
  project_topic_id: (project_id: string) => string
  access: TelegramAccess
  client: Pick<TelegramClient, 'sendMessage' | 'sendChatAction' | 'getFile' | 'downloadFile' | 'sendFile' | 'sendMediaGroup' | 'getMe' | 'getChatMember'>
  /** `<NEUTRON_HOME>/telegram/inbox` */
  inbox_dir: string
  /** `<NEUTRON_HOME>/telegram/seen-updates.json`: recent update ids, so a re-sent update runs once across restarts. */
  seen_path: string
  /** Runs one turn on the live agent. Null when no agent is configured. */
  chat_turn: ((turn: LiveAgentTurnRequest) => Promise<unknown>) | null
  /** Whether a model can answer for this project right now (the web chat's same check). */
  can_dispatch?: (project_id: string) => boolean
  /** The shared voice-note transcriber; null result = no transcript. */
  transcribe: (input: { bytes: Uint8Array; content_type: string; hash: string }) => Promise<string | null>
  log: TelegramChatLog
  now?: () => number
  album_window_ms?: number
  /** Size of a reply file, or null when it is not a regular file. */
  file_size?: (path: string) => number | null
  /** Wait used for Telegram's retry_after; injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Directories a reply may send files from (the instance's home). A
   * `[[file: …]]` path is resolved through symlinks and must land inside one of
   * them, so a reply can never post a file from elsewhere on the server.
   */
  reply_file_roots: ReadonlyArray<string>
  /** The general post-turn scribe the web chat runs (memory extraction); optional. */
  scribe?: (input: { text: string; topic_id: string; observed_at: number }) => void
}

interface Accepted {
  event: IncomingEvent
  chat_id: string
  /** Forum topic the message was written in; every answer goes back to it. */
  thread_id: number | undefined
  project_id: string
}

/** Where an answer goes: the chat, and the forum topic when there is one. */
interface Dest {
  chat_id: string
  thread_id: number | undefined
}

const destKey = (d: Dest): string => `${d.chat_id}:${d.thread_id ?? ''}`

const threadField = (d: Dest): { message_thread_id?: number } =>
  d.thread_id !== undefined ? { message_thread_id: d.thread_id } : {}

interface SavedAttachment {
  path: string
  content_type: string
  kind: TelegramAttachmentRef['kind']
  transcript: string | null
}

export interface TelegramChatBridge extends IncomingEventReceiver {
  /** Resolves when every turn started so far has finished (tests). */
  idle(): Promise<void>
  /**
   * Shutdown: stop accepting messages, start the turn for any album still being
   * gathered, and wait up to `timeout_ms` for running turns.
   */
  close(timeout_ms?: number): Promise<void>
}

export function buildTelegramChatBridge(opts: TelegramChatBridgeOptions): TelegramChatBridge {
  const now = opts.now ?? Date.now
  const albumWindow = opts.album_window_ms ?? ALBUM_WINDOW_MS
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
  const roots = opts.reply_file_roots.map((r) => {
    try {
      return realpathSync(r)
    } catch {
      return r
    }
  })
  const insideRoots = (path: string): boolean => {
    let real: string
    try {
      real = realpathSync(path)
    } catch {
      return false
    }
    return roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
  }
  /**
   * Read a reply file in one open: the opened file must be a regular file whose
   * resolved path is inside a root (checked against the descriptor's device and
   * inode, so swapping a symlink after the check reads nothing), and at most
   * `max` bytes are read, so a file that grows cannot exceed the cap.
   */
  const readInsideRoots = (path: string, max: number): Uint8Array => {
    const fd = openSync(path, 'r')
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) throw new Error('not a regular file')
      const real = statSync(realpathSync(path))
      if (real.dev !== st.dev || real.ino !== st.ino || !insideRoots(path)) throw new Error('outside the allowed folders')
      if (st.size > max) throw new Error('over the size limit')
      const buf = Buffer.alloc(max + 1)
      let n = 0
      for (;;) {
        const r = readSync(fd, buf, n, buf.length - n, null)
        if (r === 0) break
        n += r
        if (n > max) throw new Error('over the size limit')
      }
      return new Uint8Array(buf.subarray(0, n))
    } finally {
      closeSync(fd)
    }
  }
  const seen = new SeenUpdates(opts.seen_path, opts.log)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  /**
   * Telegram answers 429 with the seconds to wait when a chat gets messages too
   * fast. Wait that long and try again (up to three times, at most a minute
   * each) rather than dropping a chunk of the reply.
   */
  const withRetryAfter = async <T,>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call()
      } catch (err) {
        if (!(err instanceof TelegramRetryAfterError) || attempt >= 3) throw err
        await sleep(Math.min(err.retry_after_ms, 60_000))
      }
    }
  }
  let closed = false
  const albums = new Map<string, { items: Accepted[]; timer: ReturnType<typeof setTimeout>; ready: () => void }>()
  /**
   * Turns run one after another per chat, in the order their messages arrived,
   * so a quick follow-up never reaches the session ahead of the photo, voice note
   * or album it refers to (which take time to download, transcribe or gather).
   */
  const chatQueues = new Map<string, Promise<void>>()
  const enqueueChat = (chat_id: string, work: () => Promise<void>): void => {
    const prev = chatQueues.get(chat_id) ?? Promise.resolve()
    const next = prev.then(work).catch((err) => opts.log.warn('telegram_turn_failed', { chat: chat_id, error: errMsg(err) }))
    chatQueues.set(chat_id, next)
    track(
      next.finally(() => {
        if (chatQueues.get(chat_id) === next) chatQueues.delete(chat_id)
      }),
    )
  }
  /** The choices the last reply in a chat offered, so "2" can pick the second. */
  const lastOptions = new Map<string, ReadonlyArray<{ label: string; body: string; value: string }>>()
  const inFlight = new Set<Promise<void>>()

  const track = (p: Promise<void>): void => {
    inFlight.add(p)
    fireAndForget('telegram-chat.track', p.finally(() => inFlight.delete(p)))
  }

  const say = async (to: Dest, text: string): Promise<void> => {
    await withRetryAfter(() => opts.client.sendMessage({ chat_id: to.chat_id, text, ...threadField(to) })).catch((err: unknown) => {
      opts.log.warn('telegram_send_failed', { chat: to.chat_id, error: errMsg(err) })
    })
  }
  const typing = (to: Dest): void => {
    fireAndForget('telegram-chat.typing', opts.client.sendChatAction({ chat_id: to.chat_id, action: 'typing', ...threadField(to) }))
  }

  const handleCommand = async (event: IncomingEvent, to: Dest, chat_type: string): Promise<boolean> => {
    const chat_id = to.chat_id
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
        await say(to, "You're already paired.")
        return true
      }
      const code = opts.access.issueCode({ user_id, name: event.user.display_name })
      await say(
        to,
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
        await say(to, `Paired ${r.name}.`)
      } else {
        await say(to, 'That code is unknown or has expired. Ask for a new one with /start in a private chat with me.')
      }
      return true
    }
    // connect
    const title = typeof event.adapter_metadata?.['chat_title'] === 'string' ? (event.adapter_metadata['chat_title'] as string) : undefined
    const r = opts.access.connect({ chat_id, chat_type, by_user_id: user_id, ...(title !== undefined ? { title } : {}) })
    if (r.ok) {
      opts.log.info('telegram_chat_connected', { chat: chat_id, project: r.project_id, by: user_id })
      const sees = await botSeesGroupMessages(chat_id)
      await say(
        to,
        (r.already ? 'This chat is already connected.' : 'This chat is connected.') +
          (sees
            ? ''
            : " But I can only see commands here: in BotFather turn off this bot's group privacy (/setprivacy → Disable), or make me an admin of this group, then remove and re-add me."),
      )
    } else if (r.reason === 'not_a_group') {
      await say(to, 'Send /connect inside the group you want to connect.')
    } else if (r.reason === 'no_default_project') {
      await say(to, 'No project is set up for Telegram on this instance yet.')
    }
    return true
  }

  /**
   * With Telegram's default group privacy a bot sees only commands, so ordinary
   * group messages would never arrive. It sees everything when privacy is off
   * or when it is an admin of the group. Unknown (an API error) counts as yes,
   * so a transient failure never produces a false warning.
   */
  const botSeesGroupMessages = async (chat_id: string): Promise<boolean> => {
    try {
      const me = await opts.client.getMe()
      if (me.can_read_all_group_messages === true) return true
      const member = await opts.client.getChatMember({ chat_id, user_id: me.id })
      return member.status === 'administrator' || member.status === 'creator'
    } catch (err) {
      opts.log.warn('telegram_privacy_check_failed', { chat: chat_id, error: errMsg(err) })
      return true
    }
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
        if (transcript !== null) {
          writeFileSync(`${path}.txt`, transcript, { mode: 0o600 })
          transcript = capTranscript(transcript)
        }
      }
      return { path, content_type, kind: ref.kind, transcript }
    } catch (err) {
      opts.log.warn('telegram_attachment_download_failed', { chat: chat_id, kind: ref.kind, error: errMsg(err) })
      return null
    }
  }

  const sendReply = async (to: Dest, body: string): Promise<void> => {
    const { text, files, rejected } = extractReplyFiles(body)
    for (const part of chunkTelegramText(text)) {
      if (part.trim().length > 0) await say(to, part)
    }
    // Sizes first, bytes later: each upload step reads only its own files, so a
    // reply never holds more than one album in memory, and the whole reply is
    // capped at REPLY_FILES_MAX_TOTAL_BYTES.
    const planned: Array<{ kind: 'photo' | 'video' | 'document'; path: string; filename: string; content_type: string }> = []
    const skipped = [...rejected]
    const sizes = new Map<string, number>()
    let total = 0
    for (const path of files) {
      if (!insideRoots(path)) {
        skipped.push(path)
        continue
      }
      const size = fileSize(path)
      if (size === null || size > TELEGRAM_UPLOAD_MAX_BYTES || total + size > REPLY_FILES_MAX_TOTAL_BYTES) {
        skipped.push(path)
        continue
      }
      sizes.set(path, size)
      total += size
      planned.push({ path, ...classifyReplyFile(path, size) })
    }
    for (const step of planReplyUploads(planned)) {
      const items = 'album' in step ? step.album : [step.single]
      try {
        const uploads = items.map((u) => {
          // The file may have changed since it was sized; the caps hold on what
          // was actually read.
          const planned = sizes.get(u.path) ?? 0
          const cap0 = u.kind === 'photo' ? TELEGRAM_PHOTO_MAX_BYTES : TELEGRAM_UPLOAD_MAX_BYTES
          const bytes = readInsideRoots(u.path, Math.min(cap0, REPLY_FILES_MAX_TOTAL_BYTES - (total - planned)))
          const cap = u.kind === 'photo' ? TELEGRAM_PHOTO_MAX_BYTES : TELEGRAM_UPLOAD_MAX_BYTES
          if (bytes.byteLength > cap || total - planned + bytes.byteLength > REPLY_FILES_MAX_TOTAL_BYTES) {
            throw new Error(`${u.filename} grew past the size limit`)
          }
          total += bytes.byteLength - planned
          sizes.set(u.path, bytes.byteLength)
          return { kind: u.kind, upload: { bytes, filename: u.filename, content_type: u.content_type } }
        })
        if ('album' in step) {
          await withRetryAfter(() => opts.client.sendMediaGroup({
            chat_id: to.chat_id,
            ...threadField(to),
            items: uploads.map((u) => ({ type: u.kind === 'video' ? ('video' as const) : ('photo' as const), file: u.upload })),
          }))
        } else {
          const u = uploads[0] as (typeof uploads)[number]
          await withRetryAfter(() => opts.client.sendFile({
            method: u.kind === 'photo' ? 'sendPhoto' : u.kind === 'video' ? 'sendVideo' : 'sendDocument',
            chat_id: to.chat_id,
            ...threadField(to),
            file: u.upload,
          }))
        }
      } catch (err) {
        opts.log.warn('telegram_file_send_failed', { chat: to.chat_id, error: errMsg(err) })
        await say(to, `Could not send ${items.map((u) => u.filename).join(', ')}.`)
      }
    }
    if (skipped.length > 0) {
      opts.log.warn('telegram_reply_files_skipped', { chat: to.chat_id, count: skipped.length })
      await say(to, `Could not send ${skipped.length === 1 ? 'one file' : `${skipped.length} files`} (missing, not an absolute path, or over the size limit).`)
    }
  }

  const runTurn = async (items: Accepted[]): Promise<void> => {
    const first = items[0]
    if (first === undefined) return
    const { chat_id, project_id } = first
    const to: Dest = { chat_id, thread_id: first.thread_id }
    if (opts.chat_turn === null || (opts.can_dispatch !== undefined && !opts.can_dispatch(project_id))) {
      await say(to, "I can't answer yet: this instance has no AI credential configured.")
      return
    }
    typing(to)
    const saved: SavedAttachment[] = []
    const texts: string[] = []
    let failedFiles = 0
    for (const a of items) {
      const message_id = String(a.event.adapter_metadata?.['message_id'] ?? '')
      for (const ref of a.event.body.attachments ?? []) {
        if (!isTelegramAttachmentRef(ref)) continue
        const s = await saveAttachment(chat_id, message_id, ref)
        if (s !== null) saved.push(s)
        else failedFiles++
      }
      const t = a.event.body.text.trim()
      if (t.length > 0) texts.push(t)
    }
    if (failedFiles > 0) {
      await say(to, `I couldn't receive ${failedFiles === 1 ? 'one file' : `${failedFiles} files`} (Telegram lets bots download up to 20 MB).`)
      // Nothing else came with it: there is no message to answer.
      if (saved.length === 0 && texts.length === 0) return
    }
    // A bare answer to the last reply's choices ("2", or the choice's words)
    // is sent as that choice's value, as a tap on a button would be.
    const offered = lastOptions.get(destKey(to))
    lastOptions.delete(destKey(to))
    const chosen = items.length === 1 && saved.length === 0 && offered !== undefined ? pickOption(texts[0] ?? '', offered) : null
    const user_text = chosen ?? composeTelegramTurnText({ items: items.map((i) => i.event), chat_id, saved, texts })
    // Replies are posted in order, one after the other, even when the runner
    // emits several messages for one turn.
    let chain: Promise<void> = Promise.resolve()
    const send = (ev: ChatOutbound): void => {
      if (ev.type === 'agent_message') {
        const body = withOptionsAsText(ev.body, ev.options)
        if (ev.options !== undefined && ev.options.length > 0) lastOptions.set(destKey(to), ev.options)
        chain = chain.then(() => sendReply(to, body)).catch((err) => {
          opts.log.warn('telegram_reply_failed', { chat: chat_id, error: errMsg(err) })
        })
      } else if (ev.type === 'agent_typing_start') {
        typing(to)
      }
    }
    if (opts.scribe !== undefined && chosen === null) {
      try {
        // The turn text already carries every transcript (inline or as the
        // `[voice]` line), so it goes to the scribe as it is.
        opts.scribe({
          text: user_text,
          topic_id: opts.project_topic_id(project_id),
          observed_at: first.event.received_at,
        })
      } catch (err) {
        opts.log.warn('telegram_scribe_failed', { chat: chat_id, error: errMsg(err) })
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
        // A Telegram message never joins a web-chat turn (or another chat's) as
        // an injection: its answer must come back to this chat.
        reply_sink: `telegram:${chat_id}${first.thread_id !== undefined ? `:${first.thread_id}` : ''}`,
        observed_at: first.event.received_at,
      })
    } catch (err) {
      opts.log.warn('telegram_turn_failed', { chat: chat_id, error: errMsg(err) })
      chain = chain.then(() => say(to, 'Something went wrong handling that message. Please send it again.'))
    }
    await chain
  }

  const flushAlbum = (key: string): void => {
    const album = albums.get(key)
    if (album === undefined) return
    albums.delete(key)
    clearTimeout(album.timer)
    album.ready()
  }

  return {
    async receive(event: IncomingEvent): Promise<void> {
      if (event.channel_kind !== 'telegram' || closed) return
      const chat_id = String(event.adapter_metadata?.['chat_id'] ?? event.channel_topic_id.split(':')[0] ?? '')
      const chat_type = String(event.adapter_metadata?.['chat_type'] ?? '')
      if (chat_id.length === 0) return
      // An edit is not a new message; acting on it would run a second turn.
      if (event.adapter_metadata?.['edited'] === true) return
      if (!seen.claim(event.event_id)) return
      const rawThread = event.adapter_metadata?.['message_thread_id']
      const thread_id = typeof rawThread === 'number' && Number.isInteger(rawThread) ? rawThread : undefined
      let handled: boolean
      try {
        handled = await handleCommand(event, { chat_id, thread_id }, chat_type)
      } catch (err) {
        // An unreadable access file refuses changes (see TelegramAccess); say
        // nothing in the chat, log it for the operator.
        opts.log.warn('telegram_command_failed', { chat: chat_id, error: errMsg(err) })
        return
      }
      if (handled) return
      const project_id = opts.access.deliveryProject({ chat_id, user_id: event.user.channel_user_id })
      if (project_id === null) {
        opts.log.info('telegram_message_dropped', { chat: chat_id, user: event.user.channel_user_id })
        return
      }
      const accepted: Accepted = { event, chat_id, thread_id, project_id }
      const group = event.adapter_metadata?.['media_group_id']
      if (typeof group === 'string' && group.length > 0) {
        const key = `${chat_id}:${group}`
        const album = albums.get(key)
        if (album !== undefined) {
          album.items.push(accepted)
          return
        }
        // The album takes its place in the chat's queue now, at its first item,
        // and runs once gathered.
        const items: Accepted[] = [accepted]
        let ready!: () => void
        const gathered = new Promise<void>((resolve) => { ready = resolve })
        albums.set(key, { items, timer: setTimeout(() => flushAlbum(key), albumWindow), ready })
        enqueueChat(chat_id, () => gathered.then(() => runTurn(items)))
        return
      }
      enqueueChat(chat_id, () => runTurn([accepted]))
    },
    async idle(): Promise<void> {
      for (const key of [...albums.keys()]) flushAlbum(key)
      while (inFlight.size > 0) await Promise.all([...inFlight])
    },
    async close(timeout_ms: number = SHUTDOWN_DRAIN_MS): Promise<void> {
      closed = true
      for (const key of [...albums.keys()]) flushAlbum(key)
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeout_ms)
      })
      await Promise.race([Promise.all([...inFlight]).then(() => undefined), deadline])
      if (timer !== undefined) clearTimeout(timer)
      if (inFlight.size > 0) opts.log.warn('telegram_shutdown_turns_running', { count: inFlight.size })
    },
  }
}

/**
 * Recent update ids, kept on disk so a re-sent update runs once even when the
 * process restarted between starting the turn and Telegram receiving the 200.
 * Bounded to {@link SEEN_EVENT_CAP}; a write failure is logged and the id is
 * still remembered in memory.
 */
class SeenUpdates {
  private ids: string[]
  private readonly set: Set<string>
  constructor(
    private readonly path: string,
    private readonly log: TelegramChatLog,
  ) {
    this.ids = []
    try {
      if (existsSync(path)) {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
        if (Array.isArray(parsed)) this.ids = parsed.filter((v): v is string => typeof v === 'string').slice(-SEEN_EVENT_CAP)
      }
    } catch {
      this.ids = []
    }
    this.set = new Set(this.ids)
  }

  /** True the first time an id is seen; false for a repeat. */
  claim(id: string): boolean {
    if (this.set.has(id)) return false
    this.set.add(id)
    this.ids.push(id)
    while (this.ids.length > SEEN_EVENT_CAP) {
      const old = this.ids.shift()
      if (old !== undefined) this.set.delete(old)
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const tmp = `${this.path}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(this.ids), { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch (err) {
      this.log.warn('telegram_seen_write_failed', { error: errMsg(err) })
    }
    return true
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
  const lines: string[] = [
    `[telegram chat=${input.chat_id} from="${from}" user=${user} msg=${msg}]`,
    TELEGRAM_REPLY_NOTE,
  ]
  if (input.saved.length > 0) {
    lines.push(
      '<user_attachments>',
      'The user attached these local files with their message. Open images and PDFs',
      'with the Read tool. Voice notes and audio carry their transcript inline below;',
      'do not Read the raw audio bytes:',
    )
    // A captionless voice note's transcript is the message itself (the
    // `[voice]` line below), so its attachment line points there instead of
    // repeating it.
    const voiceIsMessage = input.texts.length === 0
    const firstAudio = input.saved.find((s) => s.kind === 'voice' || s.kind === 'audio')
    for (const s of input.saved) {
      if (s.kind === 'voice' || s.kind === 'audio') {
        const what = s.kind === 'voice' ? 'voice note' : 'audio'
        lines.push(
          s.transcript === null
            ? `- ${s.path} (${s.content_type}) — ${what}; transcription unavailable`
            : voiceIsMessage && s === firstAudio
              ? `- ${s.path} (${s.content_type}) — ${what}; transcript is the message below`
              : `- ${s.path} (${s.content_type}) — ${what}; transcript: ${oneLine(s.transcript)}`,
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

/**
 * Told to the agent on every Telegram turn, right under the header: where the
 * reply goes and how to send a file with it.
 */
export const TELEGRAM_REPLY_NOTE =
  '(Your reply goes to this Telegram chat. To send a file with it, put each file on its own line of the reply as [[file: /absolute/path]]; images go as photos, mp4 as video, anything else as a document; at most 10 files. Only files inside a project folder (Projects/<project>/), telegram/outbox/ or a folder the operator allowed can be sent; copy a file there first if needed.)'

/**
 * A reply that offers choices carries them in `options`, already stripped from
 * the body. Telegram gets them as a numbered list the person can answer in words.
 */
export function withOptionsAsText(body: string, options: ReadonlyArray<{ label: string; body: string }> | undefined): string {
  if (options === undefined || options.length === 0) return body
  const list = options.map((o, i) => `${i + 1}. ${o.body.length > 0 ? o.body : o.label}`).join('\n')
  return `${body.trimEnd()}\n\n${list}\n\nReply with the number or the words.`
}

/**
 * The value of the choice a reply names: its number in the list, its words, or
 * its label. Null when the reply is anything else (it is then sent as written).
 */
export function pickOption(text: string, options: ReadonlyArray<{ label: string; body: string; value: string }>): string | null {
  const t = text.trim()
  if (t.length === 0) return null
  const n = /^\d{1,2}$/.test(t) ? Number(t) : NaN
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return (options[n - 1] as { value: string }).value
  const lower = t.toLowerCase()
  const hit = options.find((o) => o.body.trim().toLowerCase() === lower || o.label.trim().toLowerCase() === lower)
  return hit !== undefined ? hit.value : null
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

function capTranscript(s: string): string {
  const t = s.trim()
  return t.length > TRANSCRIPT_MAX_CHARS ? `${t.slice(0, TRANSCRIPT_MAX_CHARS)}… [transcript truncated]` : t
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
