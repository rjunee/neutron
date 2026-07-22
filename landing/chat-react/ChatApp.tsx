/**
 * landing/chat-react — the assistant-ui composition for the Neutron web chat.
 *
 * Built from assistant-ui PRIMITIVES (the styled `Thread` was removed from the
 * core package in 0.14.x), so every surface — message bubbles, the streaming
 * indicator, the composer, the topic rail, the connection banner — is our own
 * markup over assistant-ui's behaviour. This is what lets us match the existing
 * dark theme and reach parity with the vanilla client's affordances while the
 * runtime still owns optimistic state, streaming, and scroll management.
 *
 * Styling references CSS classes defined in `chat-react.html` (`car-*`), so no
 * CSS framework is bundled.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  MessagePartPrimitive,
  AssistantRuntimeProvider,
  useMessage,
  useMessagePartText,
  useComposer,
  useComposerRuntime,
} from '@assistant-ui/react'
import { Markdown } from './Markdown.tsx'
import { ChatErrorBoundary } from './ChatErrorBoundary.tsx'
import { PlansPane } from './PlansPane.tsx'
import { useChatRuntime } from './useNeutronChat.ts'

import type { ChatMessageOption, ChatMessageUploadAffordance, PromptKind, ReactionChip } from '@neutronai/chat-core'
import type { ChatViewModel, RenderMessage, ImportProgressVM, SystemNoticeVM } from './controller.ts'
import type { NeutronChatController } from './controller.ts'
import type { BootstrapConfig, ProjectTab } from './config.ts'
import type { AttachmentDraft } from './useAttachmentDraft.ts'
import { fetchAttachmentObjectUrl, isAuthedAttachmentUrl, importHistoryZip, isExportZip } from './uploads.ts'
import { isImageAttachmentUrl } from './message-adapter.ts'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/**
 * The bearer + fetch the bubble's image renderer needs. The chat-attachment
 * GET (`/api/app/upload/<user>/<hash>.<ext>`) is bearer-authed, so a plain
 * `<img src>` would 401 — {@link AttachmentImage} fetches the blob WITH the
 * token and renders an object URL instead. Null disables authed fetching (the
 * adapter then renders the raw URL, fine for `data:` / external images).
 */
interface UploadsCtx {
  token: string
  /** Page origin — only same-origin attachment URLs take the authed (bearer)
   *  fetch path, so the token never leaks cross-origin. */
  origin: string
  fetchImpl?: FetchImpl
}
const UploadsContext = createContext<UploadsCtx | null>(null)

/** Basename of an attachment URL (strips the path + any query/hash), for the
 *  non-image file chip's display + download name. Falls back to 'attachment'. */
function attachmentBasename(url: string): string {
  const withoutQuery = url.split(/[?#]/, 1)[0] ?? url
  const last = withoutQuery.split('/').pop() ?? ''
  return last.length > 0 ? decodeURIComponent(last) : 'attachment'
}

/**
 * Render one attachment. A same-origin `/api/app/upload/…` URL is bearer-authed,
 * so we fetch it with the token and show the resulting `blob:` object URL
 * (revoked on unmount / src change). `data:` / `blob:` / external `https:` URLs
 * render directly — no auth, no fetch.
 *
 * An IMAGE renders as an `<img>`; a NON-image (e.g. a PDF) renders as a
 * downloadable file chip (basename + open/download link) using the SAME authed
 * fetch — so a document never paints as a broken `<img>`.
 */
function AttachmentImage({ src }: { src: string }): React.JSX.Element {
  const uploads = useContext(UploadsContext)
  const needsAuth = uploads !== null && isAuthedAttachmentUrl(src, uploads.origin)
  const isImage = isImageAttachmentUrl(src)
  const [objUrl, setObjUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!needsAuth || uploads === null) return
    let active = true
    let created: string | null = null
    const ac = new AbortController()
    const fetchOpts: Parameters<typeof fetchAttachmentObjectUrl>[1] = {
      token: uploads.token,
      signal: ac.signal,
    }
    if (uploads.fetchImpl !== undefined) fetchOpts.fetchImpl = uploads.fetchImpl
    fetchAttachmentObjectUrl(src, fetchOpts)
      .then((url) => {
        if (active) {
          created = url
          setObjUrl(url)
        } else {
          revokeObjectUrl(url)
        }
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
      ac.abort()
      if (created !== null) revokeObjectUrl(created)
    }
  }, [src, needsAuth, uploads])

  // Non-image attachment (PDF, …) → a downloadable file chip, never an <img>.
  if (!isImage) {
    const name = attachmentBasename(src)
    const href = needsAuth ? objUrl : src
    if (needsAuth && failed) return <span className="car-attach-error">📎 {name} unavailable</span>
    if (needsAuth && href === null) {
      return <span className="car-attach-loading">📎 {name}…</span>
    }
    return (
      <a
        className="car-attach-file"
        href={href ?? src}
        download={name}
        target="_blank"
        rel="noreferrer"
      >
        📎 {name}
      </a>
    )
  }

  if (!needsAuth) return <img src={src} alt="attachment" className="car-attach-img" />
  if (failed) return <span className="car-attach-error">📎 image unavailable</span>
  if (objUrl === null) return <span className="car-attach-loading">Loading image…</span>
  return <img src={objUrl} alt="attachment" className="car-attach-img" />
}

function revokeObjectUrl(url: string): void {
  ;(globalThis as { URL?: { revokeObjectURL?: (u: string) => void } }).URL?.revokeObjectURL?.(url)
}

/** Custom assistant-ui Image content part → the authed renderer. */
function AttachmentImagePart({ image }: { image: string }): React.JSX.Element {
  return <AttachmentImage src={image} />
}

/**
 * Custom text content part.
 *
 * AGENT messages render as sanitized GitHub-flavored MARKDOWN (headings, lists,
 * bold/italic, links, code blocks, tables) via the shared {@link Markdown}
 * component — the agent speaks markdown, so a raw "**bold**" should render bold.
 * USER messages stay PLAIN text (`white-space: pre-line`) — a person typing
 * literal asterisks means asterisks, and plain text also dodges the streaming
 * concern below for the user's own echoes.
 *
 * Track B Phase 4 (edit/delete) — assistant-ui's default Text part smooths
 * (typewriter-reveals) any text change whose new value extends the displayed
 * one. An edit that APPENDS to a delivered message (e.g. "Hi Sam" → "Hi Sam
 * (edited)") looks exactly like a streaming append, so the default defers the
 * new body behind a `requestAnimationFrame` reveal — the edited text only
 * appears once the animation runs (and never under jsdom/happy-dom, where RAF
 * doesn't flush). Neutron already streams via chat-core partials, so the plain
 * branch disables assistant-ui's typewriter (`smooth={false}`); the markdown
 * branch reads the live part text directly (`useMessagePartText`), so a streamed
 * agent reply re-renders its markdown per token with no extra smoothing layer. */
/**
 * P-A — in-app doc-link navigation. Carries the page origin + an "open this
 * doc" callback down to the message-bubble markdown (which only reaches the
 * render tree via context, like {@link ButtonsContext}). When present, a tap on
 * an agent's `[name](docs:/<id>/<path>)` link (rewritten to the web doc-link
 * URL) switches to the Documents tab + opens that doc instead of opening a new
 * browser tab.
 */
interface DocLinkCtx {
  origin: string
  onOpenDoc: (projectId: string, path: string) => void
}
const DocLinkContext = createContext<DocLinkCtx | null>(null)

function TextPart(): React.JSX.Element {
  const message = useMessage()
  const part = useMessagePartText()
  const docLink = useContext(DocLinkContext)
  if (message.role === 'assistant') {
    return docLink !== null ? (
      <Markdown text={part.text} onDocLink={docLink.onOpenDoc} origin={docLink.origin} />
    ) : (
      <Markdown text={part.text} />
    )
  }
  return (
    <p className="car-text" style={{ whiteSpace: 'pre-line' }}>
      <MessagePartPrimitive.Text smooth={false} />
    </p>
  )
}

/** Part-component map: route image parts through the authed renderer and render
 *  text without assistant-ui's typewriter smoothing (see {@link TextPart}). */
const PART_COMPONENTS = { Image: AttachmentImagePart, Text: TextPart } as const

/**
 * Track B Phase 4 — per-message reaction data + an add/remove callback, shared
 * down to the assistant-ui message components (which only receive the rendered
 * message id via `useMessage`). Keyed by the render `id` so a bubble can look
 * up its own chips + the wire message id to react against.
 */
interface ReactionsCtx {
  byRenderId: Map<string, { messageId: string | null; reactions: ReactionChip[] }>
  onReact: (messageId: string, emoji: string, reactedBySelf: boolean) => void
}
const ReactionsContext = createContext<ReactionsCtx | null>(null)

/**
 * Reaction chips for a single message bubble.
 *
 * BUG 5 (2026-06-29) — Ryan doesn't want reactions on web. The add-reaction
 * "＋" trigger + emoji picker are NO LONGER rendered, so a fresh chat shows no
 * reaction affordance at all (a message with no reactions renders nothing).
 * Existing chips (e.g. one an agent set via the backend store) still display
 * and a self-chip can still be tapped to remove it — the backend reaction store
 * + `controller.react` path are untouched (agent-native parity preserved); only
 * the user-facing ADD UI is gone. A bubble with no wire message id yet
 * (optimistic, not server-acked) can't carry reactions, so it renders nothing.
 */
function MessageReactions(): React.JSX.Element | null {
  const ctx = useContext(ReactionsContext)
  const message = useMessage()
  if (ctx === null) return null
  const entry = ctx.byRenderId.get(message.id)
  if (entry === undefined || entry.messageId === null) return null
  const messageId = entry.messageId
  const { reactions } = entry
  if (reactions.length === 0) return null

  return (
    <div className="car-reactions">
      {reactions.map((chip) => (
        <button
          key={chip.emoji}
          type="button"
          className={`car-reaction${chip.reactedBySelf ? ' car-reaction-self' : ''}`}
          onClick={() => ctx.onReact(messageId, chip.emoji, chip.reactedBySelf)}
          aria-label={`${chip.emoji} ${chip.count}${chip.reactedBySelf ? ', reacted' : ''}`}
        >
          {chip.emoji} {chip.count}
        </button>
      ))}
    </div>
  )
}

/**
 * Track B Phase 4 (edit/delete) — per-message edit state + author edit/delete
 * callbacks, shared to the bubbles (which only get the render id via
 * `useMessage`). Keyed by render `id`; `canMutate` marks the bubbles this client
 * authored (so only the user's own `user` messages offer Edit/Delete — the agent
 * is immutable from the web client; the server would reject it anyway).
 */
interface EditsCtx {
  byRenderId: Map<
    string,
    { messageId: string | null; text: string; edited: boolean; deleted: boolean; canMutate: boolean }
  >
  onEdit: (messageId: string, body: string) => void
  onDelete: (messageId: string) => void
}
const EditsContext = createContext<EditsCtx | null>(null)

/** The "edited" marker shown under an edited (non-deleted) bubble. */
function EditedMarker(): React.JSX.Element | null {
  const ctx = useContext(EditsContext)
  const message = useMessage()
  if (ctx === null) return null
  const entry = ctx.byRenderId.get(message.id)
  if (entry === undefined || !entry.edited || entry.deleted) return null
  return <span className="car-edited" aria-label="edited">edited</span>
}

/**
 * Edit/Delete affordance for a user's own message + the in-place editor. Reads
 * the message id + current text from {@link EditsContext}. Editing swaps the
 * bubble actions for a textarea with Save/Cancel; Delete tombstones the message.
 * Renders nothing for a bubble the client can't mutate or that's deleted.
 */
function MessageActions(): React.JSX.Element | null {
  const ctx = useContext(EditsContext)
  const message = useMessage()
  const [draft, setDraft] = useState<string | null>(null)
  if (ctx === null) return null
  const entry = ctx.byRenderId.get(message.id)
  if (entry === undefined || entry.messageId === null || entry.deleted || !entry.canMutate) return null
  const messageId = entry.messageId

  if (draft !== null) {
    const save = (): void => {
      const next = draft.trim()
      if (next.length > 0 && next !== entry.text) ctx.onEdit(messageId, next)
      setDraft(null)
    }
    return (
      <div className="car-edit">
        <textarea
          className="car-edit-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Edit message"
          autoFocus
        />
        <div className="car-edit-actions">
          <button type="button" className="car-edit-btn" onClick={() => setDraft(null)}>
            Cancel
          </button>
          <button type="button" className="car-edit-btn car-edit-save" onClick={save}>
            Save
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="car-msg-actions">
      <button
        type="button"
        className="car-msg-action"
        onClick={() => setDraft(entry.text)}
        aria-label="Edit message"
      >
        Edit
      </button>
      <button
        type="button"
        className="car-msg-action car-msg-action-danger"
        onClick={() => ctx.onDelete(messageId)}
        aria-label="Delete message"
      >
        Delete
      </button>
    </div>
  )
}

/**
 * W5 GAP-4 — per-message delivery-failure state + a retry callback, shared to the
 * bubbles (which only get the render id via `useMessage`). Keyed by render `id`
 * (= the client_msg_id for user sends). When a send's ack never arrives its
 * status flips `sent`→`failed` ({@link deliveryFor}), and this surfaces the ⚠️
 * "Failed — retry" affordance instead of a stuck 🕓 clock — mirroring the mobile
 * `deliveryState`/`deliveryGlyph('failed') → '⚠️'` mapping so web and mobile agree.
 * Agent-native parity: retry re-drives the same idempotent send the reconnect path
 * would.
 */
interface DeliveryCtx {
  /** renderId → true when that user message failed to deliver. */
  byRenderId: Map<string, boolean>
  onRetry: (renderId: string) => void
}
const DeliveryContext = createContext<DeliveryCtx | null>(null)

/** The ⚠️ "Failed — retry" affordance under a user bubble whose send timed out
 *  awaiting its ack. Renders nothing for any non-failed message. */
function RetryAffordance(): React.JSX.Element | null {
  const ctx = useContext(DeliveryContext)
  const message = useMessage()
  if (ctx === null) return null
  if (ctx.byRenderId.get(message.id) !== true) return null
  return (
    <button
      type="button"
      className="car-msg-failed"
      onClick={() => ctx.onRetry(message.id)}
      aria-label="Message failed to send — retry"
    >
      ⚠️ Failed — retry
    </button>
  )
}

/** Build the renderId → failed index (only user sends can fail). */
function buildDeliveryIndex(messages: readonly RenderMessage[]): Map<string, boolean> {
  const map = new Map<string, boolean>()
  for (const m of messages) {
    if (m.role === 'user' && m.delivery === 'failed') map.set(m.id, true)
  }
  return map
}

/**
 * P1b (onboarding / quick-reply buttons) — per-message option metadata + a
 * choose callback, shared down to the assistant-ui message components (which
 * only receive the render id via `useMessage`). Keyed by the render `id` so an
 * agent bubble can look up its own options + post the choice back. Mirrors the
 * reactions/edits context pattern so buttons render off the controller's
 * `RenderMessage` (not via an assistant-ui custom content part).
 */
interface ButtonsCtx {
  byRenderId: Map<
    string,
    {
      options: readonly ChatMessageOption[]
      promptId: string | null
      kind: PromptKind | null
      chosenValue: string | null
    }
  >
  onChoose: (renderId: string, promptId: string | null, value: string) => void
}
const ButtonsContext = createContext<ButtonsCtx | null>(null)

/**
 * FIX #338 — per-message time metadata (iMessage/Telegram style): a subtle
 * trailing `timeLabel` ("14:32"), the full `dateTitle` for the time's hover
 * tooltip ("Jul 3, 2026, 2:32 PM"), and a `dayDivider` label ("Today" /
 * "Yesterday" / "Mon Jul 1") rendered as a centered separator ABOVE the first
 * message of a new calendar day (null otherwise). Computed once per render over
 * the ordered message list (adjacency needs the whole list) and keyed by render
 * id so each bubble looks up its own entry, like {@link ButtonsContext}.
 */
interface MetaEntry {
  timeLabel: string
  dateTitle: string
  dayDivider: string | null
}
interface MetaCtx {
  byRenderId: Map<string, MetaEntry>
}
const MetaContext = createContext<MetaCtx | null>(null)

/** The human-readable choice text for a button. BUG 3 — render `body` (the real
 *  choice text, e.g. "Yes, ChatGPT export"), NOT `label` (the "A"/"B"/"C" letter
 *  legend the server still ships for Telegram's text rendering). `body` defaults
 *  to `label` in `parseOptions`, so this is safe for options without a body. */
function optionText(opt: ChatMessageOption): string {
  return opt.body.length > 0 ? opt.body : opt.label
}

/** One option button. Tap posts the option's `value` (NOT label) — the routing
 *  key the server's outstanding-prompt store maps back to a canonical choice. */
function ChoiceButton({
  opt,
  onChoose,
}: {
  opt: ChatMessageOption
  onChoose: (value: string) => void
}): React.JSX.Element {
  const variant =
    opt.decoration?.style === 'destructive'
      ? ' car-choice-destructive'
      : opt.decoration?.style === 'primary'
        ? ' car-choice-primary'
        : ''
  const text = optionText(opt)
  return (
    <button
      type="button"
      className={`car-choice${variant}`}
      onClick={() => onChoose(opt.value)}
      aria-label={text}
    >
      {text}
    </button>
  )
}

/**
 * The option row under an agent message. Renders a wrapped button row by
 * default; an image-gallery prompt renders a 2-col thumbnail grid (options with
 * an `image_url`) plus a control row for the rest (regen / skip / upload). Once
 * the user has chosen, it collapses to a single "→ {label}" summary line so the
 * buttons can't be re-tapped (optimistic, mirrors the Expo primitive).
 */
function ButtonOptionRow({
  options,
  kind,
  chosenValue,
  onChoose,
}: {
  options: readonly ChatMessageOption[]
  kind: PromptKind | null
  chosenValue: string | null
  onChoose: (value: string) => void
}): React.JSX.Element {
  if (chosenValue !== null) {
    const chosen = options.find((o) => o.value === chosenValue)
    return (
      <div className="car-choices-chosen" aria-label="chosen option">
        → {chosen !== undefined ? optionText(chosen) : chosenValue}
      </div>
    )
  }
  if (kind === 'image-gallery') {
    const hasImage = (o: ChatMessageOption): boolean =>
      typeof o.image_url === 'string' && o.image_url.length > 0
    const gallery = options.filter(hasImage)
    const controls = options.filter((o) => !hasImage(o))
    return (
      <div className="car-gallery-wrap">
        {gallery.length > 0 ? (
          <div className="car-gallery">
            {gallery.map((o) => (
              <button
                key={o.value}
                type="button"
                className="car-gallery-tile"
                onClick={() => onChoose(o.value)}
                aria-label={optionText(o)}
              >
                <img src={o.image_url} alt={optionText(o)} className="car-gallery-img" />
                <span className="car-gallery-label">{optionText(o)}</span>
              </button>
            ))}
          </div>
        ) : null}
        {controls.length > 0 ? (
          <div className="car-choices">
            {controls.map((o) => (
              <ChoiceButton key={o.value} opt={o} onChoose={onChoose} />
            ))}
          </div>
        ) : null}
      </div>
    )
  }
  return (
    <div className="car-choices">
      {options.map((o) => (
        <ChoiceButton key={o.value} opt={o} onChoose={onChoose} />
      ))}
    </div>
  )
}

/** Looks up the current message's options from {@link ButtonsContext} and renders
 *  the option row. Nothing when the message carries no options. */
function MessageButtons(): React.JSX.Element | null {
  const ctx = useContext(ButtonsContext)
  const message = useMessage()
  if (ctx === null) return null
  const entry = ctx.byRenderId.get(message.id)
  if (entry === undefined || entry.options.length === 0) return null
  return (
    <ButtonOptionRow
      options={entry.options}
      kind={entry.kind}
      chosenValue={entry.chosenValue}
      onChoose={(value) => ctx.onChoose(message.id, entry.promptId, value)}
    />
  )
}

/** FIX #338 — a centered "Today / Yesterday / Mon Jul 1" separator rendered
 *  ABOVE the first message of a new calendar day. Nothing when this message
 *  doesn't open a new day (or carries no durable time). */
function DayDivider(): React.JSX.Element | null {
  const ctx = useContext(MetaContext)
  const message = useMessage()
  const entry = ctx?.byRenderId.get(message.id)
  if (entry === undefined || entry.dayDivider === null) return null
  return (
    <div className="car-day-divider" role="separator" aria-label={entry.dayDivider}>
      <span>{entry.dayDivider}</span>
    </div>
  )
}

/** FIX #338 — a subtle trailing timestamp ("14:32"); hovering shows the full
 *  date via the `title` tooltip. Nothing for a streaming/ephemeral bubble. */
function MessageTime(): React.JSX.Element | null {
  const ctx = useContext(MetaContext)
  const message = useMessage()
  const entry = ctx?.byRenderId.get(message.id)
  if (entry === undefined || entry.timeLabel.length === 0) return null
  return (
    <time className="car-time" title={entry.dateTitle}>
      {entry.timeLabel}
    </time>
  )
}

function UserMessage(): React.JSX.Element {
  return (
    <>
      <DayDivider />
      <MessagePrimitive.Root className="car-row car-row-user">
        <div className="car-bubble car-bubble-user">
          <MessagePrimitive.Parts components={PART_COMPONENTS} />
          <MessageTime />
          <EditedMarker />
          <MessageReactions />
          <MessageActions />
          <RetryAffordance />
        </div>
      </MessagePrimitive.Root>
    </>
  )
}

function AssistantMessage(): React.JSX.Element | null {
  const message = useMessage()
  // BUG 7 (non-streaming live-agent path) — assistant-ui's ExternalStoreRuntime
  // synthesizes an EMPTY optimistic "upcoming" assistant bubble whenever it is
  // running and the trailing message is the user's (`hasUpcomingMessage`). On the
  // live-agent path the reply arrives as a SINGLE non-streamed `agent_message`
  // (no `agent_message_partial` frames), so no streaming bubble exists while the
  // turn is pending — the last message stays the user's and that empty bubble
  // renders ABOVE our own typing-dots indicator. Suppress it: the
  // `TypingIndicator` (keyed off `awaitingFirstToken`) is the sole pending
  // affordance until the real `agent_message` lands. `isOptimistic` is set ONLY
  // on this synthesized placeholder, so our real (incl. options-only, empty-body)
  // agent messages are unaffected.
  if (message.metadata?.isOptimistic === true) return null
  return (
    <>
      <DayDivider />
      <MessagePrimitive.Root className="car-row car-row-agent">
        <div className="car-avatar" aria-hidden="true">
          N
        </div>
        <div className="car-bubble car-bubble-agent">
          <MessagePrimitive.Parts components={PART_COMPONENTS} />
          <MessageButtons />
          <MessageTime />
          <EditedMarker />
          <MessageReactions />
        </div>
      </MessagePrimitive.Root>
    </>
  )
}

const MESSAGE_COMPONENTS = { UserMessage, AssistantMessage } as const

/** P1b — build the render-id → option-metadata lookup the agent bubbles read. */
function buildButtonsIndex(messages: readonly RenderMessage[]): ButtonsCtx['byRenderId'] {
  const map: ButtonsCtx['byRenderId'] = new Map()
  for (const m of messages) {
    if (m.options !== null && m.options.length > 0) {
      map.set(m.id, {
        options: m.options,
        promptId: m.promptId,
        kind: m.kind,
        chosenValue: m.chosenValue,
      })
    }
  }
  return map
}

/** FIX #338 — build the render-id → time-metadata lookup the bubbles read.
 *  Walks the ORDERED message list once, tagging each durable message with its
 *  time labels + a day-divider label when it opens a new calendar day. Ephemeral
 *  bubbles (streaming / notices, `timestampMs === null`) get empty labels + no
 *  divider and never advance the day cursor. `now` is injected for the
 *  Today/Yesterday wording (pure + unit-testable). */
export function buildMetaIndex(
  messages: readonly RenderMessage[],
  now: Date,
): Map<string, MetaEntry> {
  const map = new Map<string, MetaEntry>()
  let prevDayKey: string | null = null
  for (const m of messages) {
    if (m.timestampMs === null) {
      map.set(m.id, { timeLabel: '', dateTitle: '', dayDivider: null })
      continue
    }
    const dayKey = dayKeyOf(m.timestampMs)
    const dayDivider = dayKey !== prevDayKey ? formatDayDivider(m.timestampMs, now) : null
    prevDayKey = dayKey
    map.set(m.id, {
      timeLabel: formatMessageTime(m.timestampMs),
      dateTitle: formatMessageDateTitle(m.timestampMs),
      dayDivider,
    })
  }
  return map
}

/**
 * P1b (upload affordance) — the most recent agent message's upload affordance,
 * or null when none. Mirrors the Expo "latest phase wins / absence clears"
 * contract: a later agent message without an affordance hides the hint.
 */
function latestUploadAffordance(
  messages: readonly RenderMessage[],
): ChatMessageUploadAffordance | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m !== undefined && m.role === 'agent') return m.uploadAffordance
  }
  return null
}

/** Human label for an import source: 'chatgpt' → 'ChatGPT', else 'Claude'. */
function importSourceLabel(affordance: ChatMessageUploadAffordance | null): string {
  if (affordance === null) return 'export'
  return affordance.source === 'chatgpt' ? 'ChatGPT' : 'Claude'
}

/**
 * BUG 2+4 (2026-06-29) — the prominent web drag-and-drop overlay for a history
 * import: the web counterpart of `app/components/DropZoneOverlay.tsx`. A single
 * tinted scrim with a dashed-border frame + one instructional line.
 *
 * Shown ONLY while a file is being dragged over the chat AND an upload affordance
 * is active (uploads accepted) — so it is NEVER premature. This replaces the old
 * always-on passive hint (`UploadAffordanceHint`), which nagged from the very
 * first onboarding turn ("what should I call you?") because the Open/Path-1 seam
 * stamps the affordance on EVERY onboarding agent_message (it gates the server's
 * solicited-upload accept, not a discrete "import step"). The explicit ask is the
 * agent's own conversational message ("export your data and drop the .zip here");
 * this overlay + the 📎 picker are the affordances that ask gestures land in.
 */
function WebDropZoneOverlay({
  visible,
  source,
}: {
  visible: boolean
  source: string
}): React.JSX.Element | null {
  if (!visible) return null
  return (
    <div className="car-dropzone" role="alert" aria-label="Drop your export ZIP to import">
      <div className="car-dropzone-frame">
        <div className="car-dropzone-title">Drop your {source} export here</div>
        <div className="car-dropzone-hint">
          Release to upload — Neutron reads it in the background while you keep chatting.
        </div>
      </div>
    </div>
  )
}

/**
 * BUG 3 (2026-06-29) — live history-import progress above the composer. Prefers
 * the server's `import_progress` stream (a spinner + the per-pass body line +
 * a progress bar) once it begins, so a long import visibly works instead of
 * stalling on a one-shot "received" banner. Until the first progress frame lands
 * (or when no import is in flight) it falls back to the upload `importState`
 * banner (uploading / received / error). Renders nothing when both are idle.
 */
function ImportStatus({
  progress,
  upload,
}: {
  progress: ImportProgressVM | null
  upload: ImportState
}): React.JSX.Element | null {
  if (progress !== null) {
    const pct = Math.max(0, Math.min(100, Math.round(progress.pct * 100)))
    const body = progress.body.length > 0 ? progress.body : 'Reading through your history…'
    return (
      <div className="car-import-status car-import-uploading" role="status" aria-live="polite">
        <span className="car-import-row">
          <span className="car-spinner" aria-hidden="true" />
          <span className="car-import-body">{body}</span>
        </span>
        <span className="car-import-bar" aria-hidden="true">
          <span className="car-import-bar-fill" style={{ width: `${pct}%` }} />
        </span>
      </div>
    )
  }
  if (upload.status !== 'idle') {
    // While uploading, show a real progress bar driven by bytes-over-the-wire
    // (loaded/total) once the first chunk callback lands. Reuses the same
    // `car-import-bar` styling as the analysis progress. The percent is only
    // shown when we have a positive total (a zero-byte total can't be a ratio).
    const hasBar =
      upload.status === 'uploading' && typeof upload.total === 'number' && upload.total > 0
    const pct = hasBar
      ? Math.max(0, Math.min(100, Math.round(((upload.loaded ?? 0) / (upload.total as number)) * 100)))
      : 0
    return (
      <div className={`car-import-status car-import-${upload.status}`} role="status" aria-live="polite">
        {upload.status === 'uploading' ? (
          <>
            <span className="car-import-row">
              <span className="car-spinner" aria-hidden="true" />
              <span className="car-import-body">
                {upload.message}
                {hasBar ? ` — ${pct}%` : ''}
              </span>
            </span>
            {hasBar ? (
              <span className="car-import-bar" aria-hidden="true">
                <span className="car-import-bar-fill" style={{ width: `${pct}%` }} />
              </span>
            ) : null}
          </>
        ) : (
          upload.message
        )}
      </div>
    )
  }
  return null
}

/** Build the render-id → {messageId, reactions} lookup the bubbles read. */
function buildReactionIndex(
  messages: readonly RenderMessage[],
): Map<string, { messageId: string | null; reactions: ReactionChip[] }> {
  const map = new Map<string, { messageId: string | null; reactions: ReactionChip[] }>()
  for (const m of messages) {
    map.set(m.id, { messageId: m.messageId, reactions: m.reactions })
  }
  return map
}

/** Track B Phase 4 (edit/delete) — render-id → {messageId,text,edited,deleted,
 *  canMutate} lookup the bubbles read for the edited marker + edit/delete UI. */
function buildEditIndex(
  messages: readonly RenderMessage[],
): EditsCtx['byRenderId'] {
  const map: EditsCtx['byRenderId'] = new Map()
  for (const m of messages) {
    map.set(m.id, {
      messageId: m.messageId,
      text: m.text,
      edited: m.edited,
      deleted: m.deleted,
      // Edit/Delete UI hidden (Ryan 2026-06-30): editing/deleting a message
      // already sent to the REPL isn't meaningful, and the affordance clutters
      // the bubble. Forcing canMutate=false makes MessageActions render null for
      // every bubble (the edit/delete store + server endpoints stay intact).
      canMutate: false,
    })
  }
  return map
}

function TypingIndicator(): React.JSX.Element {
  return (
    <div className="car-row car-row-agent" aria-live="polite">
      <div className="car-avatar" aria-hidden="true">
        N
      </div>
      <div className="car-bubble car-bubble-agent car-typing">
        <span className="car-dot" />
        <span className="car-dot" />
        <span className="car-dot" />
      </div>
    </div>
  )
}

/**
 * M1 UX REDESIGN — a quiet, centered SYSTEM-notification pill (cold-start
 * "Waking up…", a quota notice). This is the ONLY thing rendered in the
 * system-message style — errors and command results are ordinary chat bubbles.
 * A small spinner + short muted text; NOT a chat bubble. Renders nothing when
 * there's no notice.
 */
function SystemNotice({ notice }: { notice: SystemNoticeVM | null }): React.JSX.Element | null {
  if (notice === null) return null
  return (
    <div className="car-system-pill" role="status" aria-live="polite">
      <span className="car-system-pill-spinner" aria-hidden="true" />
      <span className="car-system-pill-text">{notice.text}</span>
    </div>
  )
}

function ConnectionBanner({ status }: { status: ChatViewModel['status'] }): React.JSX.Element | null {
  if (status === 'open' || status === 'idle') return null
  const label =
    status === 'connecting'
      ? 'Connecting…'
      : status === 'reconnecting'
        ? 'Reconnecting…'
        : 'Disconnected'
  return (
    <div className={`car-banner car-banner-${status}`} role="status">
      {label}
    </div>
  )
}

function PendingBadge({ pending }: { pending: number }): React.JSX.Element | null {
  if (pending <= 0) return null
  return (
    <div className="car-pending" role="status">
      {pending} queued · will send when online
    </div>
  )
}

/** The General (no-project) scope glyph + a generic fallback for a project the
 *  server didn't send an emoji for (older row / degraded frame). Kept in sync
 *  with the server's `GENERAL_EMOJI` / `GENERIC_EMOJI` (default-emoji.ts).
 *  Exported so the workspace-identity seat (ProjectShell) resolves the same
 *  glyphs the rail uses. */
export const GENERAL_EMOJI = '💬'
export const GENERIC_PROJECT_EMOJI = '📁'

/** Resolve a project's rail glyph: the server emoji, else the generic fallback. */
export function railEmojiFor(emoji: string | undefined): string {
  return emoji !== undefined && emoji.length > 0 ? emoji : GENERIC_PROJECT_EMOJI
}

const RAIL_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const RAIL_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

/** Format a rail row's right-aligned timestamp from an ISO activity time, à la
 *  Telegram: TODAY → `14:32` (24h), THIS WEEK → weekday (`Mon`), older → `Jun 28`.
 *  Pure — `now` is injected so it unit-tests deterministically. Returns '' for a
 *  missing/unparseable time (the row then renders no timestamp). */
export function formatRailTime(iso: string | undefined, now: Date): string {
  if (iso === undefined || iso.length === 0) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const startOfDay = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (dayDiff <= 0) {
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }
  if (dayDiff < 7) return RAIL_WEEKDAYS[d.getDay()] ?? ''
  return `${RAIL_MONTHS[d.getMonth()] ?? ''} ${d.getDate()}`
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** FIX #338 — local calendar-day key (YYYY-MM-DD) for day-divider adjacency. */
function dayKeyOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** FIX #338 — a message bubble's inline timestamp: 24h `HH:MM` (Telegram-style).
 *  '' for an unparseable time. Pure. */
export function formatMessageTime(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** FIX #338 — the full date+time shown on hover over a bubble's timestamp, e.g.
 *  "Jul 3, 2026, 2:32 PM" (12h). '' for an unparseable time. Pure. */
export function formatMessageDateTitle(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const h24 = d.getHours()
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  const ampm = h24 < 12 ? 'AM' : 'PM'
  return `${RAIL_MONTHS[d.getMonth()] ?? ''} ${d.getDate()}, ${d.getFullYear()}, ${h12}:${pad2(d.getMinutes())} ${ampm}`
}

/** FIX #338 — a day-divider label: TODAY → "Today", YESTERDAY → "Yesterday",
 *  same calendar year → "Mon Jul 1", older → "Mon Jul 1, 2025". `now` injected
 *  for deterministic unit tests. '' for an unparseable time. Pure. */
export function formatDayDivider(ms: number, now: Date): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const startOfDay = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (dayDiff <= 0) return 'Today'
  if (dayDiff === 1) return 'Yesterday'
  const wd = RAIL_WEEKDAYS[d.getDay()] ?? ''
  const mon = RAIL_MONTHS[d.getMonth()] ?? ''
  if (d.getFullYear() !== now.getFullYear()) return `${wd} ${mon} ${d.getDate()}, ${d.getFullYear()}`
  return `${wd} ${mon} ${d.getDate()}`
}

/** The rail avatar's work-activity dot modifier class (or null for no dot):
 *  `working` → pulsing --work, `attention` → static --attention, else none.
 *  General never shows a dot (it has no bound runs). */
export function railDotClass(
  activity: 'idle' | 'working' | 'attention' | undefined,
  isGeneral: boolean,
): 'car-rail-dot-work' | 'car-rail-dot-attention' | null {
  if (isGeneral) return null
  if (activity === 'working') return 'car-rail-dot-work'
  if (activity === 'attention') return 'car-rail-dot-attention'
  return null
}

/** The ⚛ atom mark (accent-lit): 3 rotated ellipses + a center dot. Inline SVG so
 *  it inherits `currentColor` (the accent) and ships no external asset. */
function AtomMark(): React.JSX.Element {
  return (
    <svg
      className="car-rail-atom"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <ellipse cx="12" cy="12" rx="10" ry="4.3" />
      <ellipse cx="12" cy="12" rx="10" ry="4.3" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="4.3" transform="rotate(120 12 12)" />
    </svg>
  )
}

/** Subscribe to a CSS media query (SSR/test-safe: false when `matchMedia` is
 *  unavailable). Drives the rail's narrow (icon-only) render branch. */
export function useMediaQuery(query: string): boolean {
  const read = (): boolean =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  const [matches, setMatches] = useState<boolean>(read)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = (): void => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** Telegram-style unread badge. Renders nothing when caught up; caps the
 *  displayed count at 99+ so a busy project can't blow out the row width. */
function UnreadBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) return null
  const shown = count > 99 ? '99+' : String(count)
  return (
    <span className="car-rail-badge" aria-label={`${count} unread`}>
      {shown}
    </span>
  )
}

/** One rail row — a Telegram-style 2-line row: an emoji "avatar" with a corner
 *  work-activity dot, name + timestamp on line 1, an ellipsised preview (own
 *  messages prefixed `You:`) + unread badge on line 2. On the narrow (<1200px)
 *  rail it collapses to the avatar + a corner count badge, with the name in the
 *  row `title`. A single presentational component shared by General + every
 *  project so their look stays identical. */
function RailItem({
  emoji,
  label,
  active,
  unread,
  activity,
  preview,
  previewFrom,
  lastActivityAt,
  isGeneral,
  narrow,
  now,
  onClick,
}: {
  emoji: string
  label: string
  active: boolean
  unread: number
  activity?: 'idle' | 'working' | 'attention'
  preview?: string | null
  previewFrom?: 'user' | 'agent' | null
  lastActivityAt?: string
  isGeneral: boolean
  narrow: boolean
  now: Date
  onClick: () => void
}): React.JSX.Element {
  const dotClass = railDotClass(activity, isGeneral)
  const timeText = formatRailTime(lastActivityAt, now)
  const previewText = preview !== undefined && preview !== null ? preview : ''
  const showYou = previewFrom === 'user' && previewText.length > 0
  const countText = unread > 99 ? '99+' : String(unread)
  return (
    <button
      type="button"
      className={`car-rail-item${narrow ? ' car-rail-item-narrow' : ''}${
        active ? ' car-rail-item-active' : ''
      }${unread > 0 && !active ? ' car-rail-item-unread' : ''}`}
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      {...(narrow
        ? {
            // The icon rail hides the name/preview, so the button's DOM text can't
            // name it. Provide an explicit accessible name (name + unread) and a
            // hover tooltip so it never announces as just "2 unread" (Codex P2).
            title: label,
            'aria-label': unread > 0 ? `${label}, ${unread} unread` : label,
          }
        : {})}
    >
      <span className="car-rail-avatar">
        <span className="car-rail-emoji" aria-hidden="true">
          {emoji}
        </span>
        {dotClass !== null ? (
          <span className={`car-rail-dot ${dotClass}`} aria-hidden="true" />
        ) : null}
        {narrow && unread > 0 ? (
          <span className="car-rail-count" aria-hidden="true">
            {countText}
          </span>
        ) : null}
      </span>
      {narrow ? null : (
        <span className="car-rail-meta">
          <span className="car-rail-line1">
            <span className="car-rail-name">{label}</span>
            {timeText.length > 0 ? <span className="car-rail-time">{timeText}</span> : null}
          </span>
          <span className="car-rail-line2">
            <span className="car-rail-preview">
              {showYou ? <span className="car-rail-you">You: </span> : null}
              {previewText}
            </span>
            <UnreadBadge count={unread} />
          </span>
        </span>
      )}
    </button>
  )
}

export function TopicRail({
  projects,
  activeId,
  onSelect,
  onCreate,
  creating,
  narrow: narrowOverride,
  now,
}: {
  projects: ProjectTab[]
  activeId: string | null
  onSelect: (id: string | null) => void
  /** POSTs the new project; resolves to an error string to show inline, or null on success. */
  onCreate: (name: string) => Promise<string | null>
  creating: boolean
  /** Test override for the narrow (icon-rail) branch; the live app derives it
   *  from the viewport via `useMediaQuery('(max-width: 1200px)')`. */
  narrow?: boolean
  /** Injected "now" for deterministic rail-timestamp formatting in tests. */
  now?: Date
}): React.JSX.Element {
  const autoNarrow = useMediaQuery('(max-width: 1200px)')
  const narrow = narrowOverride ?? autoNarrow
  const nowDate = now ?? new Date()
  // Inline create-project input (mirrors mobile `app/app/projects`): the header
  // "+" toggles a name field with Enter→submit / Esc→cancel, replacing the
  // native window.prompt. `createError` renders the failure inline instead of a
  // blocking window.alert.
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  // The 68px icon rail can't fit the inline create form's name field, so while
  // that form is open we temporarily expand the rail back to full width (and the
  // rows render 2-line). Collapses back to icons on cancel/submit. (Codex P2.)
  const effectiveNarrow = narrow && !createOpen

  const cancelCreate = (): void => {
    setCreateOpen(false)
    setNewName('')
    setCreateError(null)
  }
  const submitCreate = (): void => {
    if (creating) return
    const name = newName.trim()
    if (name.length === 0) {
      setCreateError('Enter a project name.')
      return
    }
    setCreateError(null)
    void (async () => {
      const err = await onCreate(name)
      if (err !== null) {
        setCreateError(err)
        return
      }
      // Success: navigation is driven by onCreate (controller.setProject); reset.
      setNewName('')
      setCreateOpen(false)
    })()
  }

  return (
    <aside className={`car-rail${effectiveNarrow ? ' car-rail-narrow' : ''}`} aria-label="Projects">
      {/* ⚛ Neutron branding lockup — replaces the old "PROJECTS" caps label. The
          new-project "+" sits on the right of the header (toggles the inline
          create form below). */}
      <div className="car-rail-head">
        <AtomMark />
        <span className="car-rail-wordmark">Neutron</span>
        <button
          type="button"
          className="car-rail-newp"
          onClick={() => {
            if (creating) return
            setCreateError(null)
            setCreateOpen((v) => !v)
          }}
          disabled={creating}
          aria-label="New project"
          aria-expanded={createOpen}
          title="New project"
        >
          +
        </button>
      </div>
      {createOpen ? (
        <div className="car-rail-create-form">
          <input
            type="text"
            className="car-rail-input"
            placeholder="Project name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitCreate()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancelCreate()
              }
            }}
            disabled={creating}
            autoFocus
            aria-label="New project name"
          />
          {createError !== null ? (
            <div className="car-rail-create-error" role="alert">
              {createError}
            </div>
          ) : null}
          <div className="car-rail-create-actions">
            <button
              type="button"
              className="car-rail-create-cancel"
              onClick={cancelCreate}
              disabled={creating}
            >
              Cancel
            </button>
            <button
              type="button"
              className="car-rail-create-confirm"
              onClick={submitCreate}
              disabled={creating}
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      ) : null}
      <div className="car-rail-list">
        <RailItem
          emoji={GENERAL_EMOJI}
          label="General"
          active={activeId === null}
          unread={0}
          isGeneral
          narrow={effectiveNarrow}
          now={nowDate}
          onClick={() => onSelect(null)}
        />
        {projects.map((p) => (
          <RailItem
            key={p.id}
            emoji={railEmojiFor(p.emoji)}
            label={p.label}
            active={activeId === p.id}
            // The project the user is viewing is, by definition, read — zero its
            // badge locally so a just-arrived reply on the ACTIVE project doesn't
            // flash a stale count before the next server frame catches up.
            unread={activeId === p.id ? 0 : (p.unread ?? 0)}
            {...(p.activity !== undefined ? { activity: p.activity } : {})}
            preview={p.preview ?? null}
            previewFrom={p.preview_from ?? null}
            {...(p.last_activity_at !== undefined ? { lastActivityAt: p.last_activity_at } : {})}
            isGeneral={false}
            narrow={effectiveNarrow}
            now={nowDate}
            onClick={() => onSelect(p.id)}
          />
        ))}
      </div>
    </aside>
  )
}

/** Staged-attachment chips above the input: each uploading image, with a
 *  remove affordance and an inline upload/error state. */
function AttachmentChips({ draft }: { draft: AttachmentDraft }): React.JSX.Element | null {
  if (draft.items.length === 0) return null
  return (
    <div className="car-attach-chips">
      {draft.items.map((it) => (
        <span key={it.id} className={`car-attach-chip car-attach-chip-${it.status}`}>
          <span className="car-attach-name">{it.name}</span>
          {it.status === 'uploading' ? <span className="car-attach-state"> · uploading…</span> : null}
          {it.status === 'error' ? (
            <span className="car-attach-state" title={it.error}>
              {' '}
              · failed
            </span>
          ) : null}
          <button
            type="button"
            className="car-attach-remove"
            aria-label={`Remove ${it.name}`}
            onClick={() => draft.remove(it.id)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

interface ImportState {
  status: 'idle' | 'uploading' | 'done' | 'error'
  message?: string
  /** UPLOAD progress (bytes over the wire) while `status === 'uploading'`.
   *  Drives the upload progress bar in {@link ImportStatus} — distinct from
   *  the post-upload import-ANALYSIS progress (`vm.importProgress`). Both
   *  undefined until the first chunk callback fires. */
  loaded?: number
  total?: number
}

function Composer({
  draft,
  controller,
  importActive,
  onFiles,
}: {
  draft: AttachmentDraft
  controller: NeutronChatController
  /** BUG 4 — true when a history-import affordance is active (uploads accepted):
   *  the file picker then advertises `.zip` in addition to images. */
  importActive: boolean
  /** Route picked files through the shared surface handler (import ZIP vs image
   *  draft) — same path the surface-level drag-and-drop drop uses. */
  onFiles: (files: FileList | readonly File[]) => void
}): React.JSX.Element {
  const composer = useComposer()
  const composerRuntime = useComposerRuntime()
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const text = composer.text
  const canSend = text.trim().length > 0 || draft.hasReady

  const onPick = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = e.target.files
    if (files !== null && files.length > 0) onFiles(files)
    e.target.value = '' // allow re-picking the same file
  }

  const send = (): void => {
    const body = text.trim()
    const urls = draft.readUrls()
    if (body.length === 0 && urls.length === 0) return
    if (body.length > 0) {
      // Text (optionally + attachments): route through the runtime so Enter and
      // the Send button share ONE path — `onNew` waits for in-flight uploads,
      // merges the staged URLs, clears the draft, and assistant-ui clears input.
      composerRuntime.send()
    } else {
      // Attachment-only: assistant-ui won't send an empty composer, so hand the
      // staged URLs to the controller directly. Await any still-uploading items
      // first (don't drop them), then clear the draft.
      void (async () => {
        const ready = await draft.waitForUploads()
        if (ready.length === 0) return
        await controller.send('', ready)
        draft.clear()
      })()
    }
  }

  return (
    <div className="car-composer-wrap">
      <AttachmentChips draft={draft} />
      <ComposerPrimitive.Root className="car-composer">
        <button
          type="button"
          className="car-attach-btn"
          aria-label={importActive ? 'Attach file or export ZIP' : 'Attach file…'}
          onClick={() => fileInputRef.current?.click()}
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={
            importActive
              ? 'image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,application/zip,.zip'
              : 'image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf'
          }
          multiple
          hidden
          className="car-file-input"
          onChange={onPick}
        />
        <ComposerPrimitive.Input className="car-input" placeholder="Message Neutron…" autoFocus rows={1} />
        <ThreadPrimitive.If running={false}>
          <button
            type="button"
            className="car-send"
            aria-label="Send"
            disabled={!canSend}
            onClick={send}
          >
            Send
          </button>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel className="car-send car-cancel" aria-label="Stop">
            Stop
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </ComposerPrimitive.Root>
    </div>
  )
}

/**
 * The chat surface (banner · thread · composer) plus the import-upload concerns
 * lifted UP from the composer (BUG 2+4): surface-wide drag-and-drop, the import
 * ZIP / image-draft router, the prominent {@link WebDropZoneOverlay}, and the
 * live {@link ImportStatus}. Dropping a file ANYWHERE over the surface (not just
 * on the composer) routes through the same `handleFiles` the 📎 picker uses.
 */
function ChatSurface({
  vm,
  controller,
  config,
  draft,
  uploadAffordance,
  showPane,
  paneProjectId,
  paneOnOpenDoc,
  fetchImpl,
}: {
  vm: ChatViewModel
  controller: NeutronChatController
  config: BootstrapConfig
  draft: AttachmentDraft
  uploadAffordance: ChatMessageUploadAffordance | null
  /** M1 polish (item 3+5) — mount the desktop Work slide-out pane inside this
   *  Chat view (to the right of the messages, above the full-width composer). */
  showPane: boolean
  /** Board scope for the pane ('' = General); also keys the pane. */
  paneProjectId: string
  /** Open a Work card's spec-doc in the Documents tab; undefined = static label. */
  paneOnOpenDoc?: (projectId: string, path: string) => void
  fetchImpl?: FetchImpl
}): React.JSX.Element {
  const [dragOver, setDragOver] = useState(false)
  const [importState, setImportState] = useState<ImportState>({ status: 'idle' })
  const importActive = uploadAffordance !== null

  // BUG 3 — once the live `import_progress` stream begins, the one-shot upload
  // banner has done its job; drop it so the live progress is the sole indicator
  // (and nothing lingers after the import finishes and progress clears).
  const hasLiveProgress = vm.importProgress !== null
  useEffect(() => {
    if (hasLiveProgress) setImportState({ status: 'idle' })
  }, [hasLiveProgress])

  // BUG 4 — route a ChatGPT/Claude export ZIP to the history-import endpoint
  // (NOT the image-only attachment draft). Images still go to the draft. A ZIP
  // dropped with no active import affordance is rejected with a clear note.
  const handleFiles = (files: FileList | readonly File[]): void => {
    const list = Array.from(files)
    if (list.length === 0) return
    const zips = list.filter(isExportZip)
    const images = list.filter((f) => !isExportZip(f))
    if (images.length > 0) draft.addFiles(images)
    if (zips.length === 0) return
    const zip = zips[0]
    if (zip === undefined) return
    if (!importActive || uploadAffordance === null) {
      setImportState({
        status: 'error',
        message: 'No history import is in progress — Neutron will ask when it wants your export.',
      })
      return
    }
    const uploadingMsg = `Importing ${zip.name}…`
    setImportState({ status: 'uploading', message: uploadingMsg, loaded: 0, total: zip.size })
    void importHistoryZip(zip, uploadAffordance.source, {
      token: config.token,
      topicId: config.topicId,
      // Live UPLOAD progress — each landed 4 MiB chunk advances the bar. This
      // is the bytes-over-the-wire indicator, distinct from the post-upload
      // analysis progress the engine streams once the zip lands.
      onProgress: (loaded, total) =>
        setImportState({ status: 'uploading', message: uploadingMsg, loaded, total }),
    })
      .then((result) => {
        // ND2 (dogfood 2026-06-27) — only claim "reading your history now" when
        // the engine actually STARTED an import job (`job_id` present). A 200
        // with `job_id: null` is a no-op (engine declined to route the upload);
        // showing success there is the banned silent-false-success that left a
        // user staring at a "reading your history" banner while `import_jobs`
        // stayed empty forever. Surface an honest "couldn't start" notice so the
        // failure is visible (and the user can retry) instead of masked.
        if (result.job_id !== null) {
          setImportState({ status: 'done', message: 'Export received — reading through your history now.' })
        } else {
          setImportState({
            status: 'error',
            message: "Couldn't start the import — your export was received but no import job started. Try uploading again.",
          })
        }
      })
      .catch((err: unknown) => {
        setImportState({
          status: 'error',
          message: err instanceof Error ? err.message : 'import failed',
        })
      })
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (files !== undefined && files.length > 0) handleFiles(files)
  }

  // Surface-wide drag-and-drop is ALWAYS armed (Codex r1) — dropping an image
  // anywhere on the chat attaches it to the draft, exactly as the composer used
  // to. `importActive` gates only the PROMINENT import overlay + ZIP→import
  // routing (handled inside handleFiles): a plain image drag shows a subtle
  // outline (`car-dragover`), an import drag shows the DropZoneOverlay.
  const dragProps = {
    onDragOver: (e: React.DragEvent): void => {
      e.preventDefault()
      setDragOver(true)
    },
    // Only clear when the pointer genuinely leaves the surface (not when it
    // crosses between child elements) to avoid flicker.
    onDragLeave: (e: React.DragEvent): void => {
      if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setDragOver(false)
    },
    onDrop,
  }

  // SEV1 chat project-switch race (2026-07-02) — the assistant-ui message
  // primitives resolve a message/part by INDEX into the runtime's live list, so
  // a runtime shared across a project switch (whose `msgs` empties IN-PLACE)
  // let a stale `<MessagePartPrimitive.Text>` index past the end and throw
  // (`useClientLookup: Index N out of bounds`). The ROOT-CAUSE fix now lives one
  // level up: `ConversationRuntimeHost` mounts a FRESH runtime per conversation
  // (keyed on `convId`), so this whole surface — thread AND composer — remounts
  // atomically on a switch and the outgoing runtime is discarded whole (never
  // shrunk in place). `ChatErrorBoundary` stays as a pure last-resort safety net
  // that catches any residual render throw into a recoverable fallback instead
  // of a dead black screen; it should essentially never fire on a normal switch.
  return (
    <main
      className={`car-main${dragOver && !importActive ? ' car-dragover' : ''}`}
      {...dragProps}
    >
      <ConnectionBanner status={vm.status} />
      <WebDropZoneOverlay visible={dragOver && importActive} source={importSourceLabel(uploadAffordance)} />
      <ChatErrorBoundary onBackToGeneral={() => controller.setProject(null)}>
      <ThreadPrimitive.Root className="car-thread">
        {/* M1 polish (item 3+5) — the message column + the Work pane share a row
            (the pane slides in on the right, LIFTED above the composer), and the
            composer is a FULL-WIDTH footer spanning both below. The pane lives
            here (inside the Chat view), so it never bleeds onto other tabs. */}
        <div className="car-chatstage">
        <div className="car-chatmain">
        <ThreadPrimitive.Viewport className="car-viewport">
          <ThreadPrimitive.Empty>
            {config.onboardingActive && vm.projectId === null ? (
              // BUG 1 — a FRESH onboarding auto-starts: the server pushes the
              // first prompt on connect. Show a loading indicator (matching
              // the old vanilla chat's "Setting things up…") while it arrives,
              // NOT the steady-state "Send a message to begin." empty state.
              //
              // ONBOARDING IS GENERAL-TOPIC-ONLY (2026-06-30 fresh-install fix).
              // The welcome seed only auto-fires on the owner's General topic
              // (`vm.projectId === null`); a PROJECT topic is always steady-state
              // (its deterministic opening is seeded by finalize + regenerated on
              // entry). `config.onboardingActive` is a page-global bootstrap flag,
              // so WITHOUT the `vm.projectId === null` guard, opening an empty
              // project tab while still onboarding (or right after) painted this
              // infinite "Setting things up…" loader FOREVER (it never resolves,
              // even on reload). Gate on the active topic so a project tab shows a
              // usable empty state, never the onboarding loader.
              <div className="car-empty">
                <div className="car-empty-title">Neutron</div>
                <div className="car-empty-sub car-empty-loading" role="status" aria-live="polite">
                  <span className="car-typing" aria-hidden="true">
                    <span className="car-dot" />
                    <span className="car-dot" />
                    <span className="car-dot" />
                  </span>
                  Setting things up…
                </div>
              </div>
            ) : (
              <div className="car-empty">
                <div className="car-empty-title">Neutron</div>
                <div className="car-empty-sub">Send a message to begin.</div>
              </div>
            )}
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={MESSAGE_COMPONENTS} />
          {/* Chat-typing persistence — show the standard typing dots for the WHOLE
              processing window, not just the pre-first-token wait. `hasActiveWork`
              (the active project's Work Board has an `in_progress` item — the same
              signal as the flashing Work-tab dot) keeps the dots visible while a
              long/background build runs on after the ack turn settles, and stops
              them the moment the board reports the work done. */}
          {vm.awaitingFirstToken || vm.hasActiveWork ? <TypingIndicator /> : null}
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ScrollToBottom className="car-scroll-bottom" aria-label="Scroll to bottom">
          ↓
        </ThreadPrimitive.ScrollToBottom>
        <PendingBadge pending={vm.pending} />
        <SystemNotice notice={vm.systemNotice} />
        <ImportStatus progress={vm.importProgress} upload={importState} />
        </div>
        {/* Desktop Work slide-out — mounted inside the Chat view so it's scoped to
            this tab (never Documents/Settings) and sits ABOVE the composer footer.
            W7 — NO `key`: this pane belongs to ONE kept-alive conversation surface,
            scoped to that surface's own (stable) project, so it must PERSIST across
            switches — a `key` would force a remount and replay the slide (#355). Its
            open/close lives in `usePlansPaneController` and rides the surface's
            lifetime; a plain project switch (hide→show this surface) never re-slides
            it, only a real kickoff/all-clear transition animates. */}
        {showPane ? (
          <PlansPane
            projectId={paneProjectId}
            config={config}
            controller={controller}
            {...(paneOnOpenDoc !== undefined ? { onOpenDoc: paneOnOpenDoc } : {})}
            {...(fetchImpl !== undefined ? { fetchImpl } : {})}
          />
        ) : null}
        </div>
        <Composer draft={draft} controller={controller} importActive={importActive} onFiles={handleFiles} />
      </ThreadPrimitive.Root>
      </ChatErrorBoundary>
    </main>
  )
}

/**
 * The General surface's per-conversation render/cache key. It MUST be a value no
 * valid project id can ever equal, so the General surface can never collide with a
 * named project's surface (share a mount + frozen-vm cache slot). The gateway's
 * `sanitizeProjectId` accepts only `[A-Za-z0-9_.-]+`, so the leading `#` (rejected)
 * makes this collision-proof — unlike the old `__general__`, which was itself a
 * validator-legal project id and thus collided with a project literally named that
 * (Codex P1: on a General↔`__general__` switch the shared cache slot leaked one
 * scope's board/transcript into the other).
 */
export const GENERAL_CONV_ID = '#general'

/**
 * The stable per-conversation identity — the project id, or the collision-proof
 * {@link GENERAL_CONV_ID} sentinel for the user-scoped General topic. Keying
 * {@link ConversationRuntimeHost} on this gives every conversation its OWN
 * assistant-ui runtime; keying the frozen-vm cache on it keeps each surface's
 * snapshot isolated.
 */
export function conversationIdOf(projectId: string | null): string {
  return projectId !== null && projectId.length > 0 ? projectId : GENERAL_CONV_ID
}

/**
 * Owns the assistant-ui `AssistantRuntimeProvider` for ONE conversation.
 *
 * SEV1 chat project-switch race (2026-07-02) — mounted with `key={convId}` so a
 * project switch REMOUNTS it and builds a FRESH `useExternalStoreRuntime` (see
 * {@link useChatRuntime}). Because the outgoing runtime is discarded whole —
 * never emptied in place — no stale `MessagePart` from the previous project can
 * index into a now-length-0 list mid-render. The provider wraps the entire chat
 * surface (thread AND composer), since both consume the runtime context; the
 * TabBar + project rail live ABOVE this in `ProjectShell` and stay mounted, so
 * the switch swaps only the message list + composer, never the shell chrome.
 */
function ConversationRuntimeHost({
  controller,
  vm,
  origin,
  draft,
  children,
}: {
  controller: NeutronChatController
  vm: ChatViewModel
  origin: string
  draft: AttachmentDraft
  children: React.ReactNode
}): React.JSX.Element {
  const runtime = useChatRuntime(controller, vm, origin, draft)
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}

/** FIX #343 — cap on simultaneously-mounted conversation surfaces. A user who
 *  tours many projects keeps only the most-recently-active few alive (the rest
 *  are evicted and cold-load on return), so mounted assistant-ui runtimes can't
 *  grow without bound over a long session. The active surface is never evicted. */
const MAX_MOUNTED_CONVERSATIONS = 8

/** FIX #343 / Codex P2 — grace window after a switch during which an active
 *  conversation's empty live vm is treated as a transient re-hydration and masked
 *  by its cached snapshot. Once it elapses with the transcript still empty, the
 *  empty is accepted as authoritative (the snapshot is dropped + the surface
 *  remounted), so a genuinely cleared/expired transcript can't be masked forever.
 *  Comfortably longer than a local OPFS transcript hydration. */
const HYDRATION_GRACE_MS = 600

/**
 * One MOUNTED conversation surface — its own message-bubble contexts, its own
 * assistant-ui runtime (via {@link ConversationRuntimeHost}), and the
 * {@link ChatSurface}. It reads a SINGLE conversation's view-model (`hostVm`),
 * which {@link ChatApp} guarantees is ALWAYS this conversation's own data (live
 * when active, its frozen last-snapshot when not) — so this surface's runtime is
 * NEVER fed another project's messages and its list is never emptied in place by
 * a foreign switch. That structural guarantee is what preserves the SEV1
 * switch-race fix (no `useClientLookup` index-out-of-bounds) while letting the
 * surface stay MOUNTED across switches: hidden when inactive, so its scroll
 * position + composer draft survive and switching back is instant.
 */
function MountedConversation({
  hostVm,
  active,
  controller,
  config,
  draft,
  fetchImpl,
  onOpenDocLink,
  showPane,
  paneProjectId,
  paneOnOpenDoc,
}: {
  hostVm: ChatViewModel
  active: boolean
  controller: NeutronChatController
  config: BootstrapConfig
  draft: AttachmentDraft
  fetchImpl?: FetchImpl
  onOpenDocLink?: (projectId: string, path: string) => void
  showPane: boolean
  paneProjectId: string
  paneOnOpenDoc?: (projectId: string, path: string) => void
}): React.JSX.Element {
  const messages = hostVm.messages
  // Indexes are pure over `messages`; memoize on the message-list identity so an
  // inactive (frozen) surface doesn't rebuild them on every parent render (the
  // active conversation streams, re-rendering ChatApp — and thus every mounted
  // surface — frequently).
  const reactionsCtx = useMemo<ReactionsCtx>(
    () => ({
      byRenderId: buildReactionIndex(messages),
      onReact: (messageId, emoji, reactedBySelf) =>
        controller.react(messageId, emoji, reactedBySelf ? 'remove' : 'add'),
    }),
    [messages, controller],
  )
  const editsCtx = useMemo<EditsCtx>(
    () => ({
      byRenderId: buildEditIndex(messages),
      onEdit: (messageId, body) => controller.editMessage(messageId, body),
      onDelete: (messageId) => controller.deleteMessage(messageId),
    }),
    [messages, controller],
  )
  const buttonsCtx = useMemo<ButtonsCtx>(
    () => ({
      byRenderId: buildButtonsIndex(messages),
      onChoose: (renderId, promptId, value) => controller.onChoose(renderId, promptId, value),
    }),
    [messages, controller],
  )
  const deliveryCtx = useMemo<DeliveryCtx>(
    () => ({
      byRenderId: buildDeliveryIndex(messages),
      // renderId is the client_msg_id for user sends; retry re-drives it idempotently.
      onRetry: (renderId) => {
        void controller.retry(renderId)
      },
    }),
    [messages, controller],
  )
  // FIX #338 — per-message time labels + day dividers. Recomputed when the list
  // changes (the Today/Yesterday wording tracks the clock closely enough).
  const metaCtx = useMemo<MetaCtx>(
    () => ({ byRenderId: buildMetaIndex(messages, new Date()) }),
    [messages],
  )
  const uploadAffordance = useMemo(() => latestUploadAffordance(messages), [messages])
  const uploadsCtx: UploadsCtx = fetchImpl !== undefined
    ? { token: config.token, origin: config.origin, fetchImpl }
    : { token: config.token, origin: config.origin }
  const docLinkCtx: DocLinkCtx | null =
    onOpenDocLink !== undefined
      ? { origin: config.origin, onOpenDoc: onOpenDocLink }
      : null

  return (
    <div className="car-conv" hidden={!active} aria-hidden={!active}>
    <DocLinkContext.Provider value={docLinkCtx}>
    <UploadsContext.Provider value={uploadsCtx}>
    <ReactionsContext.Provider value={reactionsCtx}>
    <EditsContext.Provider value={editsCtx}>
    <ButtonsContext.Provider value={buttonsCtx}>
    <DeliveryContext.Provider value={deliveryCtx}>
    <MetaContext.Provider value={metaCtx}>
      <ConversationRuntimeHost
        controller={controller}
        vm={hostVm}
        origin={config.origin}
        draft={draft}
      >
        <ChatSurface
          vm={hostVm}
          controller={controller}
          config={config}
          draft={draft}
          uploadAffordance={uploadAffordance}
          // W7 — the pane stays MOUNTED for the WHOLE life of this kept-alive
          // surface (NOT gated on `active`). Gating on `active` unmounted the pane
          // on every switch-away and re-mounted it on return, replaying the
          // slide-out animation (#355) and re-fetching the board. Kept mounted, its
          // open/close state persists across switches — a plain switch never
          // re-slides — and its board fetch/poll (poll is already gated on a LIVE
          // run) stays warm so an in-flight build the user switched away from is
          // still shown, mid-flight, when they switch back.
          showPane={showPane}
          paneProjectId={paneProjectId}
          {...(paneOnOpenDoc !== undefined ? { paneOnOpenDoc } : {})}
          {...(fetchImpl !== undefined ? { fetchImpl } : {})}
        />
      </ConversationRuntimeHost>
    </MetaContext.Provider>
    </DeliveryContext.Provider>
    </ButtonsContext.Provider>
    </EditsContext.Provider>
    </ReactionsContext.Provider>
    </UploadsContext.Provider>
    </DocLinkContext.Provider>
    </div>
  )
}

export function ChatApp({
  vm,
  controller,
  config,
  draft,
  fetchImpl,
  onOpenDocLink,
  paneEligible,
  paneOnOpenDoc,
}: {
  vm: ChatViewModel
  controller: NeutronChatController
  config: BootstrapConfig
  draft: AttachmentDraft
  /** Injected in tests; the authed image renderer falls back to global fetch. */
  fetchImpl?: FetchImpl
  /** P-A — open a doc referenced by an agent chat link in the Documents tab.
   *  Supplied by `ProjectShell`; omit to leave doc links as plain anchors. */
  onOpenDocLink?: (projectId: string, path: string) => void
  /** W7 — whether this viewport hosts the desktop Work slide-out pane (≥1024px).
   *  A PLAIN viewport gate: each kept-alive conversation surface mounts its OWN
   *  persistent pane, scoped to its OWN project, so a project switch never
   *  unmounts + re-slides the pane (#355). Omitting/false renders no pane (narrow
   *  width — Work stays a seated tab). Every scope, General included, is
   *  Work-board-eligible, so no per-project gate is needed here. */
  paneEligible?: boolean
  /** Open a Work card's spec-doc in the Documents tab; undefined = static label
   *  (e.g. General, which has no Documents tab). */
  paneOnOpenDoc?: (projectId: string, path: string) => void
}): React.JSX.Element {
  // FIX #343 — keep the chat surface MOUNTED across project switches instead of
  // remounting it on every switch (the old `key={convId}` on the sole
  // ConversationRuntimeHost tore down the whole thread + composer, flashed the
  // empty state, and lost scroll/draft — the visible "rebuilding the screen"
  // flicker). Now each visited conversation gets its OWN persistent
  // MountedConversation (its own runtime); only the active one is visible. This
  // preserves the SEV1 switch-race fix structurally (each surface's runtime only
  // ever sees ITS conversation's messages — never emptied in place by a foreign
  // switch), keeps per-project scroll + draft, and makes switching back instant.
  const convId = conversationIdOf(vm.projectId)

  // Per-conversation frozen-vm cache, keyed by convId. Updated during render for
  // the ACTIVE conversation only, and only when the live vm actually carries this
  // conversation's data — a mid-switch empty vm (the controller re-scoping +
  // re-hydrating) must NOT blank a cached snapshot. Mutating a ref in render is
  // the sanctioned React cache pattern (idempotent; survives StrictMode double
  // invoke since the write is value-stable).
  const cacheRef = useRef<Map<string, ChatViewModel>>(new Map())
  const cache = cacheRef.current
  const cachedActive = cache.get(convId)
  if (
    cachedActive === undefined ||
    vm.messages.length > 0 ||
    cachedActive.messages.length === 0
  ) {
    cache.set(convId, vm)
  }

  // Codex P2 — the frozen-vm fallback below shows a conversation's cached messages
  // while its live transcript re-hydrates (so a switch-back doesn't flash empty).
  // If the live transcript is AUTHORITATIVELY empty (cleared/expired), that
  // fallback would otherwise mask it forever. Bound it: after HYDRATION_GRACE_MS,
  // if the active conversation's live vm is STILL empty while a non-empty snapshot
  // is cached, drop the snapshot and bump the conversation's remount epoch — the
  // surface REMOUNTS onto the (empty) live vm rather than shrinking its runtime in
  // place, so the empty is accepted without risking the SEV1 index-out-of-bounds.
  const liveVmRef = useRef(vm)
  liveVmRef.current = vm
  const epochRef = useRef<Map<string, number>>(new Map())
  const [, bumpEpoch] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => {
      const live = liveVmRef.current
      const frozen = cache.get(convId)
      if (
        conversationIdOf(live.projectId) === convId &&
        live.messages.length === 0 &&
        frozen !== undefined &&
        frozen.messages.length > 0
      ) {
        cache.delete(convId)
        epochRef.current.set(convId, (epochRef.current.get(convId) ?? 0) + 1)
        bumpEpoch((n) => n + 1)
      }
    }, HYDRATION_GRACE_MS)
    return () => clearTimeout(t)
  }, [convId, cache])

  // The ordered set of mounted conversation ids (LRU; most-recently-active last).
  const [mounted, setMounted] = useState<string[]>(() => [convId])
  // Render the active conversation immediately even on the switch render (before
  // the effect below commits the new `mounted` state) so the switch never shows a
  // blank frame. The effect then persists the order + evicts stale surfaces.
  const renderList = mounted.includes(convId) ? mounted : [...mounted, convId]

  useEffect(() => {
    setMounted((prev) => {
      const next = prev.filter((id) => id !== convId)
      next.push(convId)
      while (next.length > MAX_MOUNTED_CONVERSATIONS) {
        const evicted = next.shift()
        if (evicted !== undefined && evicted !== convId) cache.delete(evicted)
      }
      return next
    })
  }, [convId, cache])

  return (
    <>
      {renderList.map((id) => {
        const active = id === convId
        const frozen = cache.get(id)
        // The active surface reads the LIVE vm — UNLESS it's momentarily empty
        // during a re-hydration and we still hold a non-empty snapshot, in which
        // case we keep showing the snapshot to avoid an empty-state flash (and to
        // avoid shrinking the runtime out from under its own mounted parts). An
        // inactive surface always reads its frozen snapshot. Either way a surface
        // never receives another conversation's messages.
        const hostVm = active
          ? vm.messages.length === 0 && frozen !== undefined && frozen.messages.length > 0
            ? frozen
            : vm
          : (frozen ?? vm)
        return (
          // The epoch suffix lets an authoritative-empty transition (Codex P2)
          // REMOUNT this surface instead of shrinking its runtime in place.
          <MountedConversation
            key={`${id}#${epochRef.current.get(id) ?? 0}`}
            hostVm={hostVm}
            active={active}
            controller={controller}
            config={config}
            draft={draft}
            {...(fetchImpl !== undefined ? { fetchImpl } : {})}
            {...(onOpenDocLink !== undefined ? { onOpenDocLink } : {})}
            showPane={paneEligible === true}
            // Each surface scopes its pane to ITS OWN conversation's project (not
            // the globally-active one), so a kept-alive background surface never
            // renders a foreign project's board. Derive the board scope from the
            // authoritative NULLABLE `hostVm.projectId` (null General → '', the
            // owner board), NOT from the render key `id` — the General key
            // (`GENERAL_CONV_ID`) is now collision-proof, but `hostVm.projectId` is
            // still the single source of truth for which board this surface owns.
            paneProjectId={hostVm.projectId ?? ''}
            {...(paneOnOpenDoc !== undefined ? { paneOnOpenDoc } : {})}
          />
        )
      })}
    </>
  )
}

/** Re-exported for a render smoke test. */
export { MessagePartPrimitive }
