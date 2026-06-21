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

import { createContext, useContext, useState } from 'react'
import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  MessagePartPrimitive,
  useMessage,
} from '@assistant-ui/react'

import type { ReactionChip } from '@neutron/chat-core'
import type { ChatViewModel, RenderMessage } from './controller.ts'
import type { NeutronChatController } from './controller.ts'
import type { BootstrapConfig, ProjectTab } from './config.ts'

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

function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="car-row car-row-user">
      <div className="car-bubble car-bubble-user">
        <MessagePrimitive.Parts />
        <MessageReactions />
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
        <MessagePrimitive.Parts />
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

function Composer(): React.JSX.Element {
  return (
    <ComposerPrimitive.Root className="car-composer">
      <ComposerPrimitive.Input
        className="car-input"
        placeholder="Message Neutron…"
        autoFocus
        rows={1}
      />
      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send className="car-send" aria-label="Send">
          Send
        </ComposerPrimitive.Send>
      </ThreadPrimitive.If>
      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel className="car-send car-cancel" aria-label="Stop">
          Stop
        </ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </ComposerPrimitive.Root>
  )
}

export function ChatApp({
  vm,
  controller,
  config,
}: {
  vm: ChatViewModel
  controller: NeutronChatController
  config: BootstrapConfig
}): React.JSX.Element {
  const reactionsCtx: ReactionsCtx = {
    byRenderId: buildReactionIndex(vm.messages),
    onReact: (messageId, emoji, reactedBySelf) =>
      controller.react(messageId, emoji, reactedBySelf ? 'remove' : 'add'),
  }
  return (
    <ReactionsContext.Provider value={reactionsCtx}>
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
          <Composer />
        </ThreadPrimitive.Root>
      </main>
    </div>
    </ReactionsContext.Provider>
  )
}

/** Re-exported for a render smoke test. */
export { MessagePartPrimitive }
