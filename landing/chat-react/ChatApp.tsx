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

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  MessagePartPrimitive,
  useMessage,
  useComposer,
  useComposerRuntime,
} from '@assistant-ui/react'

import type { ReactionChip } from '@neutron/chat-core'
import type { ChatViewModel, RenderMessage } from './controller.ts'
import type { NeutronChatController } from './controller.ts'
import type { BootstrapConfig, ProjectTab } from './config.ts'
import type { AttachmentDraft } from './useAttachmentDraft.ts'
import { fetchAttachmentObjectUrl, isAuthedAttachmentUrl } from './uploads.ts'

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

/** Part-component map: route image parts through the authed renderer; text
 *  falls back to assistant-ui's default text part. */
const PART_COMPONENTS = { Image: AttachmentImagePart } as const

/** Quick-reaction palette the web "add reaction" affordance offers. */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '🔥'] as const

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
 * Reaction chips + an add-reaction affordance for a single message bubble.
 * Reads the current message id from assistant-ui's `useMessage`, looks up its
 * reactions from context, and renders the chip row. Tapping a self-chip removes
 * it; the "＋" opens a small emoji palette. A bubble with no wire message id yet
 * (optimistic, not server-acked) can't be reacted to, so we render nothing.
 */
function MessageReactions(): React.JSX.Element | null {
  const ctx = useContext(ReactionsContext)
  const message = useMessage()
  const [pickerOpen, setPickerOpen] = useState(false)
  if (ctx === null) return null
  const entry = ctx.byRenderId.get(message.id)
  if (entry === undefined || entry.messageId === null) return null
  const messageId = entry.messageId
  const { reactions } = entry

  const toggle = (emoji: string, reactedBySelf: boolean): void => {
    ctx.onReact(messageId, emoji, reactedBySelf)
    setPickerOpen(false)
  }

  return (
    <div className="car-reactions">
      {reactions.map((chip) => (
        <button
          key={chip.emoji}
          type="button"
          className={`car-reaction${chip.reactedBySelf ? ' car-reaction-self' : ''}`}
          onClick={() => toggle(chip.emoji, chip.reactedBySelf)}
          aria-label={`${chip.emoji} ${chip.count}${chip.reactedBySelf ? ', reacted' : ''}`}
        >
          {chip.emoji} {chip.count}
        </button>
      ))}
      <button
        type="button"
        className="car-reaction car-reaction-add"
        onClick={() => setPickerOpen((v) => !v)}
        aria-label="Add reaction"
      >
        ＋
      </button>
      {pickerOpen ? (
        <span className="car-reaction-picker" role="menu">
          {QUICK_REACTIONS.map((emoji) => {
            const existing = reactions.find((c) => c.emoji === emoji)
            return (
              <button
                key={emoji}
                type="button"
                className="car-reaction-pick"
                onClick={() => toggle(emoji, existing?.reactedBySelf ?? false)}
                aria-label={`React ${emoji}`}
              >
                {emoji}
              </button>
            )
          })}
        </span>
      ) : null}
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

function AssistantMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="car-row car-row-agent">
      <div className="car-avatar" aria-hidden="true">
        N
      </div>
      <div className="car-bubble car-bubble-agent">
        <MessagePrimitive.Parts components={PART_COMPONENTS} />
        <EditedMarker />
        <MessageReactions />
      </div>
    </MessagePrimitive.Root>
  )
}

const MESSAGE_COMPONENTS = { UserMessage, AssistantMessage } as const

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
      // Author-only: the web client owns the `user` messages on its topic; the
      // agent's are immutable here (server rejects a cross-author mutation).
      canMutate: m.role === 'user' && !m.streaming,
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

/**
 * Track B Phase 4 — Telegram-style delivery status for the latest user send.
 * assistant-ui owns per-message bubble composition via the runtime, so rather
 * than fight it for a per-bubble tick we surface the most-recent send's ladder
 * here: 🕓 Queued → ✓ Sent → ✓✓ Delivered → ✓✓ Read (the read tick blue, via
 * the `car-receipt-read` class). Hidden once the agent's reply arrives (the
 * thread itself is the acknowledgement) or before anything is sent.
 */
function DeliveryStatus({
  delivery,
  isRunning,
}: {
  delivery: ChatViewModel['latestUserDelivery']
  isRunning: boolean
}): React.JSX.Element | null {
  if (delivery === null || isRunning) return null
  const label =
    delivery === 'pending'
      ? '🕓 Queued'
      : delivery === 'sent'
        ? '✓ Sent'
        : delivery === 'read'
          ? '✓✓ Read'
          : '✓✓ Delivered'
  return (
    <div
      className={`car-receipt${delivery === 'read' ? ' car-receipt-read' : ''}`}
      role="status"
      aria-label={`delivery: ${delivery}`}
    >
      {label}
    </div>
  )
}

function TopicRail({
  projects,
  activeId,
  onSelect,
}: {
  projects: ProjectTab[]
  activeId: string | null
  onSelect: (id: string | null) => void
}): React.JSX.Element {
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

function Composer({
  draft,
  controller,
}: {
  draft: AttachmentDraft
  controller: NeutronChatController
}): React.JSX.Element {
  const composer = useComposer()
  const composerRuntime = useComposerRuntime()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const text = composer.text
  const canSend = text.trim().length > 0 || draft.hasReady

  const onPick = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = e.target.files
    if (files !== null && files.length > 0) draft.addFiles(files)
    e.target.value = '' // allow re-picking the same file
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (files !== undefined && files.length > 0) draft.addFiles(files)
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
    <div
      className={`car-composer-wrap${dragOver ? ' car-dragover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <AttachmentChips draft={draft} />
      <ComposerPrimitive.Root className="car-composer">
        <button
          type="button"
          className="car-attach-btn"
          aria-label="Attach image"
          onClick={() => fileInputRef.current?.click()}
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
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
  const uploadsCtx: UploadsCtx = fetchImpl !== undefined
    ? { token: config.token, origin: config.origin, fetchImpl }
    : { token: config.token, origin: config.origin }
  return (
    <UploadsContext.Provider value={uploadsCtx}>
    <ReactionsContext.Provider value={reactionsCtx}>
    <EditsContext.Provider value={editsCtx}>
    <div className="car-shell">
      {config.projects.length > 0 && (
        <TopicRail
          projects={config.projects}
          activeId={vm.projectId}
          onSelect={(id) => controller.setProject(id)}
        />
      )}
      <main className="car-main">
        <ConnectionBanner status={vm.status} />
        <ThreadPrimitive.Root className="car-thread">
          <ThreadPrimitive.Viewport className="car-viewport">
            <ThreadPrimitive.Empty>
              <div className="car-empty">
                <div className="car-empty-title">Neutron</div>
                <div className="car-empty-sub">Send a message to begin.</div>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={MESSAGE_COMPONENTS} />
            <ThreadPrimitive.If running>
              <TypingIndicator />
            </ThreadPrimitive.If>
          </ThreadPrimitive.Viewport>
          <ThreadPrimitive.ScrollToBottom className="car-scroll-bottom" aria-label="Scroll to bottom">
            ↓
          </ThreadPrimitive.ScrollToBottom>
          <PendingBadge pending={vm.pending} />
          <DeliveryStatus delivery={vm.latestUserDelivery} isRunning={vm.isRunning} />
          <Composer draft={draft} controller={controller} />
        </ThreadPrimitive.Root>
      </main>
    </div>
    </EditsContext.Provider>
    </ReactionsContext.Provider>
    </UploadsContext.Provider>
  )
}

/** Re-exported for a render smoke test. */
export { MessagePartPrimitive }
