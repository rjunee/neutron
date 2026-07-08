/**
 * @neutronai/open — the `late<T>` two-phase holder seam (C3d).
 *
 * The Open composer has several "late-bound holders": a value CREATED early in
 * the `createOpenComposition` closure, MUTATED (bound) much later once its real
 * dependency exists, and READ — often fire-and-forget via optional-chain
 * (`holder.x?.method(...)`) — from runtime paths scattered across the closure.
 * The classic shape was a bare mutable object:
 *
 *     const holder: { adapter?: AppWsAdapter } = {}
 *     // ...much later...
 *     holder.adapter = new AppWsAdapter(...)
 *     // ...runtime fire-and-forget...
 *     void holder.adapter?.send(msg)   // silently no-ops if unbound
 *
 * `late<T>(name)` replaces that ad-hoc pattern with an explicit two-phase seam
 * that PRESERVES the exact production behaviour (a deref before `bind` is still a
 * no-op) while adding two things the bare object lacked:
 *
 *   1. OBSERVABILITY — a deref-before-bind logs loudly and increments a
 *      per-seam counter (there is no `system_events` table in this repo, so the
 *      counter is an in-process Map exposed for tests + an injectable sink; the
 *      default sink also emits the repo-standard `[open] event=…` warn line).
 *   2. TEST-STRICTNESS — under `NODE_ENV === 'test'` a deref-before-bind THROWS,
 *      so a unit test catches an ordering bug the silent `?.` would have hidden.
 *
 * CRITICAL — deref-before-bind semantics (the Verifier amendment):
 *   - AFTER `bind(value)`, `deref(fn)` returns `fn(value)` — callers use it
 *     exactly as the old `holder.x?.foo(...)` did.
 *   - BEFORE `bind`, `deref(fn)` must NOT throw in production (these holders sit
 *     in fire-and-forget runtime paths — e.g. `onboardingMsg.deref(emit => …)`
 *     fired from the import-completion watcher; a throw would be a behaviour
 *     change). It logs loudly, bumps the counter, and returns `undefined`
 *     (skipping `fn`) — byte-identical to the old silent `?.` no-op.
 *   - The throw escalation is gated on `NODE_ENV === 'test'` ONLY, so prod stays
 *     a no-op and tests stay strict.
 *
 * `isBound()` / `get()` are plain accessors (no logging, no throw) for the call
 * sites that are presence-checks (`holder.x !== undefined`) or a post-bind direct
 * read — NOT `?.` derefs. Only the `?.` fire-paths map onto `deref`.
 *
 * This is a NEW leaf the composer imports DOWNWARD — it never imports back into
 * `open/composer.ts`.
 */

/** Injectable observability sink fired on a deref-before-bind. */
export type LateUnboundSink = (name: string) => void

export interface Late<T> {
  /** Bind the real value. Idempotent (last write wins); flips `isBound()` true. */
  bind(value: T): void
  /** Presence check — pure, never logs/throws. Mirrors `holder.x !== undefined`. */
  isBound(): boolean
  /**
   * Raw accessor — returns the bound value or `undefined`. Pure (no log/throw).
   * Use only for a presence-guarded direct read or a post-bind local capture;
   * the `?.` fire-paths use {@link Late.deref} instead.
   */
  get(): T | undefined
  /**
   * The guarded deref helper that every old `holder.x?.foo(...)` call site maps
   * onto. Bound → returns `fn(value)`. Unbound → loud log + counter bump + (throw
   * under `NODE_ENV==='test'`) + returns `undefined` (skips `fn`) — the exact
   * prod no-op the old optional-chain gave.
   */
  deref<R>(fn: (value: T) => R): R | undefined
}

/**
 * Process-wide count of deref-before-bind events, keyed by seam name. There is no
 * `system_events` sink in this repo, so this in-process Map IS the counter; it is
 * exposed so a test can assert the increment and observability can read it.
 */
const unboundDerefCounts = new Map<string, number>()

/** Read the deref-before-bind counter for a seam (0 if never tripped). */
export function lateUnboundDerefCount(name: string): number {
  return unboundDerefCounts.get(name) ?? 0
}

/** Reset the deref-before-bind counters (test hygiene). */
export function resetLateUnboundDerefCounts(): void {
  unboundDerefCounts.clear()
}

/** The default sink: bump the in-process counter + emit the repo-standard warn. */
function defaultUnboundSink(name: string): void {
  const next = (unboundDerefCounts.get(name) ?? 0) + 1
  unboundDerefCounts.set(name, next)
  console.error(
    `[open] event=late_deref_before_bind seam=${name} count=${next} — a late<T> holder was dereferenced before it was bound; the call was skipped (prod no-op). This is a boot-ordering bug.`,
  )
}

/**
 * Construct a two-phase late-bound holder. `name` labels it in the loud log +
 * the counter. `opts.onUnboundDeref` overrides the default (counter + warn) sink
 * — threaded via a param rather than importing a sink upward into the composer.
 */
export function late<T>(
  name: string,
  opts?: { onUnboundDeref?: LateUnboundSink },
): Late<T> {
  let value: T | undefined
  let bound = false
  const sink = opts?.onUnboundDeref ?? defaultUnboundSink
  return {
    bind(v: T): void {
      value = v
      bound = true
    },
    isBound(): boolean {
      return bound
    },
    get(): T | undefined {
      return value
    },
    deref<R>(fn: (v: T) => R): R | undefined {
      if (bound) return fn(value as T)
      sink(name)
      // Escalate to a throw ONLY under test so a unit test catches the ordering
      // bug; prod stays a no-op (byte-identical to the old silent `?.`).
      if (process.env['NODE_ENV'] === 'test') {
        throw new Error(
          `late<${name}>.deref called before bind (NODE_ENV=test strict mode)`,
        )
      }
      return undefined
    },
  }
}
