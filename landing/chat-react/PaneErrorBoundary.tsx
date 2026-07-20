/**
 * PaneErrorBoundary — per-pane render isolation.
 *
 * THE BUG (live, Ryan 2026-07-20): clicking to a different project sometimes
 * blanked the ENTIRE screen. The console showed the #354 crash signature
 * ("Tried to unmount a fiber that is already unmounted" → the boundary trips),
 * alongside a 503 on a `docs/file` fetch and a WebSocket that closed before it
 * opened.
 *
 * #354's own fix (the memoized assistant-ui adapter in `useNeutronChat.ts`) is
 * intact and its regression test still passes — so this was a DIFFERENT trigger
 * reaching the same failure. The reason any such trigger blanks everything is
 * structural, and independent of which one fired: there was exactly ONE error
 * boundary in the whole client (`ChatApp.tsx`, wrapping the entire surface).
 * `DocumentsTab` — which does its own network I/O on project switch — sat
 * inside it with no isolation of its own. So a single failed doc fetch took
 * down chat, the rail, the work board and the docs pane together.
 *
 * This boundary makes a pane's failure LOCAL: the pane renders a small inline
 * error with a retry, and everything around it keeps working. It is
 * deliberately NOT a copy of `ChatErrorBoundary` — that one owns a
 * whole-surface recovery affordance ("Back to General"); this one must stay
 * visually minor, because the point is that the rest of the app is still fine.
 *
 * Placement rule: wrap any pane that performs its own I/O and can therefore
 * fail independently of the chat transcript.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface PaneErrorBoundaryProps {
  children: ReactNode
  /** Pane name for the inline message + console line (e.g. "Documents"). */
  label: string
}

interface PaneErrorBoundaryState {
  error: Error | null
}

export class PaneErrorBoundary extends Component<PaneErrorBoundaryProps, PaneErrorBoundaryState> {
  state: PaneErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): PaneErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log with the pane name so a bug report says WHICH pane died, not just
    // that "a React component" threw (the unhelpful shape of the live report).
    console.error(`[chat] ${this.props.label} pane error (isolated)`, error, info)
  }

  private readonly retry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    return (
      <div className="pane-error" role="alert">
        <p className="pane-error__text">
          {this.props.label} could not load.
        </p>
        <button type="button" className="pane-error__retry" onClick={this.retry}>
          Try again
        </button>
      </div>
    )
  }
}
