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

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
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
import { useChatRuntime } from './useNeutronChat.ts'

import type { ChatMessageOption, ChatMessageUploadAffordance, PromptKind, ReactionChip } from '@neutron/chat-core'
import type { ChatViewModel, RenderMessage, ImportProgressVM, SystemNoticeVM } from './controller.ts'
import type { NeutronChatController } from './controller.ts'
import type { BootstrapConfig, ProjectTab } from './config.ts'
import type { AttachmentDraft } from './useAttachmentDraft.ts'
import { fetchAttachmentObjectUrl, isAuthedAttachmentUrl, importHistoryZip, isExportZip } from './uploads.ts'

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

/**
 * Render one image attachment. A same-origin `/api/app/upload/…` URL is
 * bearer-authed, so we fetch it with the token and show the resulting `blob:`
 * object URL (revoked on unmount / src change). `data:` / `blob:` / external
 * `https:` URLs render directly — no auth, no fetch.
 */
function AttachmentImage({ src }: { src: string }): React.JSX.Element {
  const uploads = useContext(UploadsContext)
  const needsAuth = uploads !== null && isAuthedAttachmentUrl(src, uploads.origin)
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

function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="car-row car-row-user">
      <div className="car-bubble car-bubble-user">
        <MessagePrimitive.Parts components={PART_COMPONENTS} />
        <EditedMarker />
        <MessageReactions />
        <MessageActions />
      </div>
    </MessagePrimitive.Root>
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
    <MessagePrimitive.Root className="car-row car-row-agent">
      <div className="car-avatar" aria-hidden="true">
        N
      </div>
      <div className="car-bubble car-bubble-agent">
        <MessagePrimitive.Parts components={PART_COMPONENTS} />
        <MessageButtons />
        <EditedMarker />
        <MessageReactions />
      </div>
    </MessagePrimitive.Root>
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
          aria-label={importActive ? 'Attach image or export ZIP' : 'Attach image'}
          onClick={() => fileInputRef.current?.click()}
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={
            importActive
              ? 'image/png,image/jpeg,image/gif,image/webp,application/zip,.zip'
              : 'image/png,image/jpeg,image/gif,image/webp'
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
}: {
  vm: ChatViewModel
  controller: NeutronChatController
  config: BootstrapConfig
  draft: AttachmentDraft
  uploadAffordance: ChatMessageUploadAffordance | null
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
        <Composer draft={draft} controller={controller} importActive={importActive} onFiles={handleFiles} />
      </ThreadPrimitive.Root>
      </ChatErrorBoundary>
    </main>
  )
}

/**
 * The stable per-conversation identity — the project id, or a sentinel for the
 * user-scoped General topic. Keying {@link ConversationRuntimeHost} on this
 * gives every conversation its OWN assistant-ui runtime.
 */
export function conversationIdOf(projectId: string | null): string {
  return projectId !== null && projectId.length > 0 ? projectId : '__general__'
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

export function ChatApp({
  vm,
  controller,
  config,
  draft,
  fetchImpl,
  onOpenDocLink,
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
}): React.JSX.Element {
  const reactionsCtx: ReactionsCtx = {
    byRenderId: buildReactionIndex(vm.messages),
    onReact: (messageId, emoji, reactedBySelf) =>
      controller.react(messageId, emoji, reactedBySelf ? 'remove' : 'add'),
  }
  const editsCtx: EditsCtx = {
    byRenderId: buildEditIndex(vm.messages),
    onEdit: (messageId, body) => controller.editMessage(messageId, body),
    onDelete: (messageId) => controller.deleteMessage(messageId),
  }
  const buttonsCtx: ButtonsCtx = {
    byRenderId: buildButtonsIndex(vm.messages),
    onChoose: (renderId, promptId, value) => controller.onChoose(renderId, promptId, value),
  }
  const uploadAffordance = latestUploadAffordance(vm.messages)
  const uploadsCtx: UploadsCtx = fetchImpl !== undefined
    ? { token: config.token, origin: config.origin, fetchImpl }
    : { token: config.token, origin: config.origin }
  const docLinkCtx: DocLinkCtx | null =
    onOpenDocLink !== undefined
      ? { origin: config.origin, onOpenDoc: onOpenDocLink }
      : null

  // ChatApp is now JUST the Chat-tab body (`ChatSurface` + its message-bubble
  // contexts). The persistent project rail + the tab bar live one level up in
  // `ProjectShell` (the rail is a persistent left column across ALL tabs; this
  // surface is only the chat pane). `ChatApp` stays mounted across tab switches
  // so the live session, stream, and scroll state survive.
  //
  // `ConversationRuntimeHost` is keyed by the active conversation so the
  // assistant-ui runtime is rebuilt per project (the SEV1 switch-race fix). The
  // message-bubble contexts stay ABOVE it: they carry no assistant-ui index
  // state, so they can persist across the switch and just take fresh values.
  const convId = conversationIdOf(vm.projectId)
  return (
    <DocLinkContext.Provider value={docLinkCtx}>
    <UploadsContext.Provider value={uploadsCtx}>
    <ReactionsContext.Provider value={reactionsCtx}>
    <EditsContext.Provider value={editsCtx}>
    <ButtonsContext.Provider value={buttonsCtx}>
      <ConversationRuntimeHost
        key={convId}
        controller={controller}
        vm={vm}
        origin={config.origin}
        draft={draft}
      >
        <ChatSurface
          vm={vm}
          controller={controller}
          config={config}
          draft={draft}
          uploadAffordance={uploadAffordance}
        />
      </ConversationRuntimeHost>
    </ButtonsContext.Provider>
    </EditsContext.Provider>
    </ReactionsContext.Provider>
    </UploadsContext.Provider>
    </DocLinkContext.Provider>
  )
}

/** Re-exported for a render smoke test. */
export { MessagePartPrimitive }
