/**
 * landing/chat-react — a render error boundary around the assistant-ui chat
 * thread (SEV1 chat-rail stability, 2026-07-01).
 *
 * WHY THIS EXISTS
 * ───────────────
 * The assistant-ui message primitives resolve a message (and its parts) by
 * INDEX into the runtime's live message list (`useClientLookup` →
 * `get({ index })`, which THROWS `Index N out of bounds (length: M)` when the
 * index is past the end). On a project switch the controller re-scopes to a new
 * topic and publishes an EMPTY message list before the new transcript hydrates;
 * if a `<MessagePartPrimitive.Text>` from the outgoing project is still mounted
 * for one render, its index lookup hits the now-empty list and throws. React
 * then unmounts the WHOLE tree (no boundary) → a dead black screen.
 *
 * The ROOT-CAUSE fix is to remount the thread subtree on a project switch (a
 * `key` on the boundary, keyed by the active conversation) so a stale MessagePart
 * can never index into the emptied list. This boundary is DEFENSE-IN-DEPTH on
 * top of that: ANY render throw inside the chat thread renders a recoverable
 * fallback (Retry / Back to General / Reload) instead of a blank screen — which
 * React itself advised ("Consider adding an error boundary.").
 *
 * A class component is required — React exposes error boundaries ONLY via the
 * class lifecycle (`getDerivedStateFromError` / `componentDidCatch`); there is no
 * hook equivalent.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ChatErrorBoundaryProps {
  children: ReactNode
  /** "Back to General" — re-scopes the chat to the user-scoped (General) topic.
   *  Supplied by the chat surface (`controller.setProject(null)`); omitted in
   *  contexts where there is no General to fall back to. */
  onBackToGeneral?: () => void
}

interface ChatErrorBoundaryState {
  error: Error | null
}

export class ChatErrorBoundary extends Component<ChatErrorBoundaryProps, ChatErrorBoundaryState> {
  state: ChatErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ChatErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the throw for debugging (dogfood console / bug reports) without
    // re-throwing — the fallback UI is the user-facing recovery path.
    console.error('[chat] render error caught by ChatErrorBoundary', error, info)
  }

  /** In-place recovery: clear the error and re-render the children. Used when the
   *  underlying data has already moved on (e.g. the new project's transcript
   *  hydrated) so a retry succeeds without a full page reload. */
  private readonly retry = (): void => {
    this.setState({ error: null })
  }

  private readonly reload = (): void => {
    const w = (globalThis as { location?: { reload?: () => void } }).location
    w?.reload?.()
  }

  private readonly backToGeneral = (): void => {
    // Clear the error first so the fallback tears down, then re-scope. The
    // caller keys this boundary by the active conversation, so the switch also
    // remounts the thread fresh.
    this.setState({ error: null })
    this.props.onBackToGeneral?.()
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div className="car-error-boundary" role="alert">
        <div className="car-error-title">This conversation hit a snag</div>
        <div className="car-error-sub">
          The chat view ran into a display error. Your messages are safe — try
          again, switch back to General, or reload.
        </div>
        <div className="car-error-actions">
          <button type="button" className="car-error-btn car-error-btn-primary" onClick={this.retry}>
            Try again
          </button>
          {this.props.onBackToGeneral !== undefined ? (
            <button type="button" className="car-error-btn" onClick={this.backToGeneral}>
              Back to General
            </button>
          ) : null}
          <button type="button" className="car-error-btn" onClick={this.reload}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
