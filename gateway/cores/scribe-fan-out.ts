/**
 * @neutronai/gateway/cores — shared scribe Cores-source fan-out seam (scribe p2).
 *
 * The Calendar + Email Managed Cores' scheduler `fire` callbacks call this
 * fire-and-forget hook with an already-fetched, flattened Core row. The gateway
 * composer binds it (when scribe is live) to
 * `scribe.extractFromCoresSource(...)` — which runs the #83 quarantine guard
 * then the shared budget-gated extract→GBrain path. It is `void`-returning and
 * MUST never throw into the Core's brief/triage path (the binding swallows its
 * own errors).
 *
 * This type carries NO scribe import so the Cores-wiring modules stay decoupled
 * from the scribe package's internals; the gateway owns the binding.
 */
export type ScribeFanOut = (
  trigger: 'calendar' | 'email',
  text: string,
  source: string,
) => void
