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

import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  MessagePartPrimitive,
} from '@assistant-ui/react'

import type { ChatViewModel } from './controller.ts'
import type { NeutronChatController } from './controller.ts'
import type { BootstrapConfig, ProjectTab } from './config.ts'

function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="car-row car-row-user">
      <div className="car-bubble car-bubble-user">
        <MessagePrimitive.Parts />
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
      </div>
    </MessagePrimitive.Root>
  )
}

const MESSAGE_COMPONENTS = { UserMessage, AssistantMessage } as const

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
  return (
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
          <Composer />
        </ThreadPrimitive.Root>
      </main>
    </div>
  )
}

/** Re-exported for a render smoke test. */
export { MessagePartPrimitive }
