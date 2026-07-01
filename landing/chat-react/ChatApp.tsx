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
  useMessage,
  useMessagePartText,
  useComposer,
  useComposerRuntime,
} from '@assistant-ui/react'
import { Markdown } from './Markdown.tsx'

import type { ChatMessageOption, ChatMessageUploadAffordance, PromptKind, ReactionChip } from '@neutron/chat-core'
import type { ChatViewModel, RenderMessage, ImportProgressVM } from './controller.ts'
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
function TextPart(): React.JSX.Element {
  const message = useMessage()
  const part = useMessagePartText()
  if (message.role === 'assistant') {
    return <Markdown text={part.text} />
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
    return (
      <div className={`car-import-status car-import-${upload.status}`} role="status" aria-live="polite">
        {upload.status === 'uploading' ? (
          <span className="car-import-row">
            <span className="car-spinner" aria-hidden="true" />
            <span className="car-import-body">{upload.message}</span>
          </span>
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

export function TopicRail({
  projects,
  activeId,
  onSelect,
  onCreate,
  creating,
}: {
  projects: ProjectTab[]
  activeId: string | null
  onSelect: (id: string | null) => void
  /** POSTs the new project; resolves to an error string to show inline, or null on success. */
  onCreate: (name: string) => Promise<string | null>
  creating: boolean
}): React.JSX.Element {
  // Inline create-project input (mirrors mobile `app/app/projects`): a closed
  // "+ Create Project" button toggles to a name field with Enter→submit /
  // Esc→cancel, replacing the native window.prompt. `createError` renders the
  // failure inline instead of a blocking window.alert.
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

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
    <aside className="car-rail" aria-label="Projects">
      <div className="car-rail-title">Projects</div>
      <button
        type="button"
        className={`car-rail-item${activeId === null ? ' car-rail-item-active' : ''}`}
        onClick={() => onSelect(null)}
      >
        General
      </button>
      {projects.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`car-rail-item${activeId === p.id ? ' car-rail-item-active' : ''}`}
          onClick={() => onSelect(p.id)}
        >
          {p.label}
        </button>
      ))}
      {/* Pinned to the bottom (the rail is a flex column; the closed button /
          open form both carry `margin-top:auto`). Always visible, even when only
          General exists, so a skip-import owner can jump straight into a fresh
          project + its tabs. */}
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
      ) : (
        <button
          type="button"
          className="car-rail-create"
          onClick={() => {
            setCreateError(null)
            setCreateOpen(true)
          }}
          disabled={creating}
          aria-label="Create a new project"
        >
          + Create Project
        </button>
      )}
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
    setImportState({ status: 'uploading', message: `Importing ${zip.name}…` })
    void importHistoryZip(zip, uploadAffordance.source, { token: config.token, topicId: config.topicId })
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

  return (
    <main
      className={`car-main${dragOver && !importActive ? ' car-dragover' : ''}`}
      {...dragProps}
    >
      <ConnectionBanner status={vm.status} />
      <WebDropZoneOverlay visible={dragOver && importActive} source={importSourceLabel(uploadAffordance)} />
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
          {vm.awaitingFirstToken ? <TypingIndicator /> : null}
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ScrollToBottom className="car-scroll-bottom" aria-label="Scroll to bottom">
          ↓
        </ThreadPrimitive.ScrollToBottom>
        <PendingBadge pending={vm.pending} />
        <ImportStatus progress={vm.importProgress} upload={importState} />
        <Composer draft={draft} controller={controller} importActive={importActive} onFiles={handleFiles} />
      </ThreadPrimitive.Root>
    </main>
  )
}

export function ChatApp({
  vm,
  controller,
  config,
  draft,
  fetchImpl,
}: {
  vm: ChatViewModel
  controller: NeutronChatController
  config: BootstrapConfig
  draft: AttachmentDraft
  /** Injected in tests; the authed image renderer falls back to global fetch. */
  fetchImpl?: FetchImpl
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

  // ChatApp is now JUST the Chat-tab body (`ChatSurface` + its message-bubble
  // contexts). The persistent project rail + the tab bar live one level up in
  // `ProjectShell` (the rail is a persistent left column across ALL tabs; this
  // surface is only the chat pane). `ChatApp` stays mounted across tab switches
  // so the live session, stream, and scroll state survive.
  return (
    <UploadsContext.Provider value={uploadsCtx}>
    <ReactionsContext.Provider value={reactionsCtx}>
    <EditsContext.Provider value={editsCtx}>
    <ButtonsContext.Provider value={buttonsCtx}>
      <ChatSurface
        vm={vm}
        controller={controller}
        config={config}
        draft={draft}
        uploadAffordance={uploadAffordance}
      />
    </ButtonsContext.Provider>
    </EditsContext.Provider>
    </ReactionsContext.Provider>
    </UploadsContext.Provider>
  )
}

/** Re-exported for a render smoke test. */
export { MessagePartPrimitive }
