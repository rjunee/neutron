/**
 * @neutronai/channels — Telegram adapter (composed).
 *
 * Telegram adapter — single-registration ABC shape from `channels/types.ts`
 * plus the Hermes-blooded edge cases:
 * UTF-16 truncation, sync-message filtering, retry-after parsing.
 *
 * P7.3 — every outgoing message body passes through the doc-link
 * rewriter so `[label](docs:/<project_id>/<path>)` markers resolve
 * to channel-appropriate URLs (`neutron://docs/...` for project-scoped,
 * `https://vault.example.test/...` for vault legacy via
 * the `resolveDocRefs` path). When the agent also supplies a
 * `doc_refs` array on `adapter_options`, those resolve via the
 * runtime helper and append as a trailing "Linked docs:" block so
 * Telegram's auto-linkifier can render them as tappable links —
 * Telegram does not parse markdown links by default.
 */

import {
  buildDocLink,
  type BuildDocLinkInput,
  type DocRef,
  findInlineDocLinks,
  parseDocLink,
  resolveDocRefs,
  type ResolvedDocRef,
} from '@neutronai/runtime'
import type {
  ChannelAdapter,
  ChannelAdapterManifest,
  IncomingEventReceiver,
  OutgoingMessage,
} from '../../types.ts'
import type { TelegramClient } from './client.ts'
import { renderInlineKeyboard } from './inline-keyboards.ts'
import {
  type SelfEchoFilter,
  hashText,
} from './sync-message-filter.ts'
import { truncateForTelegram } from './utf16-truncation.ts'
import {
  buildWebhookHandler,
  type TelegramCallbackQueryHandler,
  type TelegramStartCommandHandler,
  type WebhookHandlerOptions,
} from './webhook-server.ts'

export interface TelegramAdapterOptions {
  client: TelegramClient
  bot_user_id: number
  /** Per-instance secret for setWebhook. */
  webhook_secret_token: string
  receiver: IncomingEventReceiver
  self_echo_filter?: SelfEchoFilter
  /**
   * Optional inline-keyboard callback handler (P2 S1 button primitive).
   * The gateway boot passes the result of `buildTelegramCallbackHandler`
   * here; when omitted, callback queries land in the webhook but get
   * dropped with a 200 OK.
   */
  on_callback_query?: TelegramCallbackQueryHandler
  /**
   * Optional `/start <payload>` bot-command handler (P2 S2 follow-up to
   * the deeplink correlator). The gateway boot passes the result of
   * `signup/telegram-start-handler.ts:buildTelegramStartHandler` here so
   * onboarding deeplinks (`t.me/<bot>?start=onboard_<correlator>`) are
   * consumable end-to-end. When omitted, `/start <payload>` falls
   * through to `decodeUpdate` as a normal user message.
   *
   * STUB NOTE: the `onConsumeStartToken` callback the gateway-side
   * factory wires in for now is a logged stub — the actual onboarding-
   * bootstrap dispatch (write `onboarding_state`, kick interview engine,
   * send first prompt) is S5/P5 work. What lands here in this PR is the
   * deeplink path being non-dangling: correlator gets consumed, JWT gets
   * validated, event gets logged with full context.
   */
  on_start_command?: TelegramStartCommandHandler
}

const MANIFEST: ChannelAdapterManifest = {
  kind: 'telegram',
  display_name: 'Telegram',
  supports_inline_choices: true,
  supports_unprompted_send: true,
}

export class TelegramAdapter implements ChannelAdapter {
  readonly manifest = MANIFEST
  private readonly client: TelegramClient
  private readonly bot_user_id: number
  private readonly secret_token: string
  private readonly receiver: IncomingEventReceiver
  private readonly self_echo_filter?: SelfEchoFilter
  private readonly on_callback_query?: TelegramCallbackQueryHandler
  private readonly on_start_command?: TelegramStartCommandHandler

  constructor(opts: TelegramAdapterOptions) {
    this.client = opts.client
    this.bot_user_id = opts.bot_user_id
    this.secret_token = opts.webhook_secret_token
    this.receiver = opts.receiver
    if (opts.self_echo_filter !== undefined) {
      this.self_echo_filter = opts.self_echo_filter
    }
    if (opts.on_callback_query !== undefined) {
      this.on_callback_query = opts.on_callback_query
    }
    if (opts.on_start_command !== undefined) {
      this.on_start_command = opts.on_start_command
    }
  }

  /**
   * Build the webhook request handler the gateway mounts under
   * `/channels/telegram/<instance>`. The handler verifies the secret token
   * before any decode work.
   */
  webhookHandler(): (req: Request) => Promise<Response> {
    const opts: WebhookHandlerOptions = {
      bot_user_id: this.bot_user_id,
      secret_token: this.secret_token,
      receiver: this.receiver,
    }
    if (this.self_echo_filter !== undefined) {
      opts.self_echo_filter = this.self_echo_filter
    }
    if (this.on_callback_query !== undefined) {
      opts.on_callback_query = this.on_callback_query
    }
    if (this.on_start_command !== undefined) {
      opts.on_start_command = this.on_start_command
    }
    return buildWebhookHandler(opts)
  }

  async send(message: OutgoingMessage): Promise<string> {
    const composed = composeBodyWithDocRefs(message)
    // Argus BLOCKING #1: when the composed body is MarkdownV2 (every
    // `.` / `-` / `(` / etc. escaped, doc-link inline links inserted),
    // a plain UTF-16 cut at 4096 can land mid-escape or mid-link and
    // Telegram rejects the whole sendMessage. The `markdown_v2` flag
    // rewinds the cut to the nearest valid MarkdownV2 boundary.
    const truncated = truncateForTelegram(composed.text, {
      markdown_v2: composed.parse_mode === 'MarkdownV2',
    })
    const { chat_id, message_thread_id } = parseTopicId(message.topic.channel_topic_id)
    const payload: {
      chat_id: number | string
      message_thread_id?: number
      text: string
      parse_mode?: 'MarkdownV2'
      reply_markup?: unknown
    } = { chat_id, text: truncated }
    if (message_thread_id !== undefined) payload.message_thread_id = message_thread_id
    if (composed.parse_mode !== undefined) payload.parse_mode = composed.parse_mode
    if (message.inline_choices && message.inline_choices.length > 0) {
      payload.reply_markup = renderInlineKeyboard(message.inline_choices)
    }
    const result = await this.client.sendMessage(payload)
    if (this.self_echo_filter) {
      this.self_echo_filter.recordSent({
        message_id: String(result.message_id),
        channel_topic_id: message.topic.channel_topic_id,
        text_hash: hashText(truncated),
        sent_at: Date.now(),
      })
    }
    return String(result.message_id)
  }

  async acknowledgeChoice(_channel_topic_id: string, callback_id: string): Promise<void> {
    await this.client.answerCallbackQuery({ callback_query_id: callback_id })
  }
}

/** Result of composing a Telegram-ready body. `parse_mode` is set only
 * when the body contains rewritten doc-link markdown that needs
 * MarkdownV2 to render as tappable links. Plain-text-only bodies
 * (no doc references) ship without parse_mode so Telegram's
 * default linkifier behaviour for bare URLs is preserved. */
interface ComposedTelegramBody {
  text: string
  parse_mode?: 'MarkdownV2'
}

/**
 * P7.3 — turn an OutgoingMessage body into the Telegram-ready text:
 *
 *   1. Rewrite every inline `[label](docs:/<project_id>/<path>)` marker
 *      to a channel-appropriate URL (`neutron://docs/...` for project-scoped,
 *      per sprint roadmap § 5).
 *   2. If `adapter_options.doc_refs` is present, resolve each entry
 *      and append a trailing "Linked docs:" block of `[label](url)`
 *      markdown links so the deep-link is tappable on Telegram.
 *
 * When EITHER #1 produced any rewrite OR #2 appended a trailing
 * block, the whole composed body is rendered in MarkdownV2 and every
 * non-link span is escape-prefixed per Telegram's MarkdownV2 rules
 * (`_*[]()~``>#+-=|{}.!\`). Plain bodies with no doc refs ship as
 * plain text so we don't have to escape arbitrary prose for callers
 * who never use the doc-link helper. Argus BLOCKING #1: before this
 * change, the rewritten inline markdown was shipped without
 * parse_mode and Telegram rendered `[label](url)` as raw text.
 *
 * The composed body still flows through `truncateForTelegram` so the
 * 4096 UTF-16-code-unit cap is respected end-to-end.
 */
function composeBodyWithDocRefs(message: OutgoingMessage): ComposedTelegramBody {
  const body = message.text
  const refs = readDocRefs(message.adapter_options)
  const resolvedRefs = refs.length > 0 ? resolveDocRefs(refs, 'telegram') : []
  const docRewrites: InlineRewrite[] = collectInlineRewrites(body)

  if (docRewrites.length === 0 && resolvedRefs.length === 0) {
    // No doc-link work: ship the body plain so legacy Telegram behaviour
    // (auto-linkify bare URLs) is preserved without forcing every send
    // path to handle MarkdownV2 escaping.
    return { text: body }
  }

  // P7.3.1 — MarkdownV2 mode is on. The blanket escape pass would turn
  // a bare `https://example.com` in the body into `https://example\.com`
  // and Telegram's auto-linkifier no longer recognises it. Detect bare
  // URLs and wrap them as `[url](url)` so they share the same escape
  // path as inline doc-link rewrites (label MarkdownV2-escaped, URL
  // payload only escapes `)` and `\`). End result on the wire: the URL
  // ships as an explicit inline link and renders as tappable text.
  const bareUrlRewrites = collectBareUrlRewrites(body, docRewrites)
  const allRewrites =
    bareUrlRewrites.length === 0
      ? docRewrites
      : [...docRewrites, ...bareUrlRewrites].sort((a, b) => a.index - b.index)

  const escapedBody = renderBodyWithInlineLinks(body, allRewrites)
  if (resolvedRefs.length === 0) {
    return { text: escapedBody, parse_mode: 'MarkdownV2' }
  }
  const trailing = formatTrailingRefBlock(resolvedRefs)
  return {
    text: `${escapedBody}\n\nLinked docs:\n${trailing}`,
    parse_mode: 'MarkdownV2',
  }
}

/** One inline `[label](docs:/...)` match resolved to its channel URL. */
interface InlineRewrite {
  /** UTF-16 index of the `[` opener in the source body. */
  index: number
  /** UTF-16 index one past the closing `)`. */
  end: number
  /** Label text (between `[` and `]`). */
  label: string
  /** Channel-resolved URL (e.g. `neutron://docs/<proj>/<encoded>`). */
  url: string
}

function collectInlineRewrites(body: string): InlineRewrite[] {
  // Argus MINOR #1: delegate the lexing to the shared
  // `findInlineDocLinks` helper so the regex stops gating out paths
  // with spaces / balanced parens. Per-match validation still goes
  // through `parseDocLink` → `buildDocLink`; entries that don't
  // resolve are skipped so the source body still passes through them
  // verbatim downstream.
  if (body.length === 0) return []
  const out: InlineRewrite[] = []
  for (const m of findInlineDocLinks(body)) {
    const parsed = parseDocLink(m.target)
    if (parsed === null) continue
    let url: string
    try {
      // P7.3 — thread the optional `line` / `range_*` anchor fields
      // through buildDocLink so a `docs:/<proj>/<path>?line=42`
      // marker rewrites to `neutron://docs/<proj>/<path>?line=42`
      // (parser → builder round-trip). Without this, the anchor
      // silently disappeared at adapter-render time even though
      // `parseDocLink` recovered it cleanly.
      const buildInput: BuildDocLinkInput = {
        project_id: parsed.project_id,
        path: parsed.path,
        channel: 'telegram',
      }
      if (parsed.line !== undefined) buildInput.line = parsed.line
      if (parsed.range_start !== undefined) buildInput.range_start = parsed.range_start
      if (parsed.range_end !== undefined) buildInput.range_end = parsed.range_end
      url = buildDocLink(buildInput)
    } catch {
      continue
    }
    out.push({ index: m.index, end: m.end, label: m.label, url })
  }
  return out
}

/**
 * P7.3.1 — find bare `http://` / `https://` URLs in the body and
 * convert them to inline-link rewrites so the downstream escape pass
 * doesn't backslash-escape `.` (etc.) inside the URL. Bare URLs in
 * plain mode auto-linkify on Telegram, but once MarkdownV2 mode is on
 * we have to spell the link out explicitly — `[url](url)` renders the
 * URL as the visible label AND keeps it tappable.
 *
 * Skip rules:
 *   - URL falls inside an existing `docs:/` rewrite range (label or
 *     target span) — the rewriter will handle that span itself.
 *   - URL is the target of an existing `[label](URL)` markdown link
 *     (heuristic: char immediately before the URL is `(` and the char
 *     before that is `]`). Wrapping that URL would produce nested
 *     brackets and break the parent link.
 *
 * Trailing punctuation strip (per the URL not greedily consuming
 * sentence-final chars): `.`, `,`, `!`, `?`, `;`, `:`, `'`, `"`. A
 * trailing `)` is stripped only when it's unbalanced (more `)` than
 * `(` inside the URL run), so `https://en.wikipedia.org/wiki/Foo_(bar)`
 * keeps its closing paren but `(see https://x.com)` drops the trailing
 * `)`.
 */
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>"`\[\]]+/g

function collectBareUrlRewrites(
  body: string,
  docRewrites: ReadonlyArray<InlineRewrite>,
): InlineRewrite[] {
  if (body.length === 0) return []
  const out: InlineRewrite[] = []
  for (const m of body.matchAll(BARE_URL_RE)) {
    const start = m.index
    if (start === undefined) continue
    let end = start + m[0].length
    while (end > start) {
      const c = body.charCodeAt(end - 1)
      // .  ,  !  ?  ;  :  '  "
      if (
        c === 0x2e ||
        c === 0x2c ||
        c === 0x21 ||
        c === 0x3f ||
        c === 0x3b ||
        c === 0x3a ||
        c === 0x27 ||
        c === 0x22
      ) {
        end--
        continue
      }
      if (c === 0x29 /* ) */) {
        let opens = 0
        let closes = 0
        for (let i = start; i < end; i++) {
          const cc = body.charCodeAt(i)
          if (cc === 0x28) opens++
          else if (cc === 0x29) closes++
        }
        if (closes > opens) {
          end--
          continue
        }
      }
      break
    }
    // Minimum sensible URL is `http://x` (8 chars). Anything shorter
    // got stripped to nothing useful — skip.
    if (end - start < 8) continue

    // Skip if URL overlaps an existing docs:/ rewrite range.
    let inDocSpan = false
    for (const r of docRewrites) {
      if (start >= r.index && start < r.end) {
        inDocSpan = true
        break
      }
    }
    if (inDocSpan) continue

    // Skip if URL is the target of an existing `[label](URL)` link —
    // wrapping would produce nested brackets and break the parent.
    if (
      start >= 2 &&
      body.charCodeAt(start - 1) === 0x28 /* ( */ &&
      body.charCodeAt(start - 2) === 0x5d /* ] */
    ) {
      continue
    }

    const urlText = body.slice(start, end)
    out.push({ index: start, end, label: urlText, url: urlText })
  }
  return out
}

/**
 * Walk the body, emitting MarkdownV2-escaped prose between inline
 * doc-link matches and `[label](url)` MarkdownV2 inline links at
 * each match. The escape sets differ inside vs outside the URL
 * payload per Telegram MarkdownV2 spec
 * (https://core.telegram.org/bots/api#markdownv2-style):
 *
 *   - Outside entities: `_*[]()~``>#+-=|{}.!` and `\` must be escaped.
 *   - Inside `(...)` of an inline link: only `)` and `\` must be
 *     escaped.
 */
function renderBodyWithInlineLinks(body: string, rewrites: InlineRewrite[]): string {
  if (rewrites.length === 0) return escapeMdV2(body)
  const out: string[] = []
  let cursor = 0
  for (const r of rewrites) {
    if (r.index > cursor) {
      out.push(escapeMdV2(body.slice(cursor, r.index)))
    }
    out.push(`[${escapeMdV2(r.label)}](${escapeMdV2LinkUrl(r.url)})`)
    cursor = r.end
  }
  if (cursor < body.length) {
    out.push(escapeMdV2(body.slice(cursor)))
  }
  return out.join('')
}

function formatTrailingRefBlock(refs: ReadonlyArray<ResolvedDocRef>): string {
  return refs
    .map((r) => `• [${escapeMdV2(r.label)}](${escapeMdV2LinkUrl(r.url)})`)
    .join('\n')
}

// Chars that must be backslash-escaped in MarkdownV2 prose. Bullet
// `•` is NOT in the special-char set so it ships verbatim.
const MD_V2_SPECIAL_RE = /([_*[\]()~`>#+\-=|{}.!\\])/g
function escapeMdV2(text: string): string {
  return text.replace(MD_V2_SPECIAL_RE, '\\$1')
}

// Inside an inline-link URL, MarkdownV2 only requires escaping `)` and
// `\`. Everything else (incl. `.`, `-`, `?`, `#`) is literal.
const MD_V2_LINK_URL_RE = /([)\\])/g
function escapeMdV2LinkUrl(url: string): string {
  return url.replace(MD_V2_LINK_URL_RE, '\\$1')
}

function readDocRefs(opts: Record<string, unknown> | undefined): DocRef[] {
  if (opts === undefined) return []
  const raw = opts['doc_refs']
  if (!Array.isArray(raw)) return []
  const refs: DocRef[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const r = entry as Record<string, unknown>
    const path = r['path']
    if (typeof path !== 'string') continue
    const ref: DocRef = { path }
    const label = r['label']
    if (typeof label === 'string') ref.label = label
    const project_id = r['project_id']
    if (typeof project_id === 'string') ref.project_id = project_id
    else if (project_id === null) ref.project_id = null
    refs.push(ref)
  }
  return refs
}

/**
 * Parse the channel_topic_id encoding from `webhook-server.renderTopicId`.
 * `chat_id` is always present; `message_thread_id` is optional. Numeric IDs
 * are returned as numbers (Telegram's chat ids are int64; JS numbers cover
 * up to 2^53 safely — Telegram has not exceeded this).
 */
function parseTopicId(channel_topic_id: string): {
  chat_id: number | string
  message_thread_id?: number
} {
  const parts = channel_topic_id.split(':')
  const chatPart = parts[0] ?? ''
  const threadPart = parts[1]
  const chatNum = Number(chatPart)
  const chat_id: number | string = Number.isFinite(chatNum) && chatPart !== '' ? chatNum : chatPart
  if (threadPart === undefined) return { chat_id }
  const threadNum = Number(threadPart)
  if (!Number.isFinite(threadNum)) return { chat_id }
  return { chat_id, message_thread_id: threadNum }
}
