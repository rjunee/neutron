/**
 * `landing/chat-react` — is the owner ACTIVELY USING this tab?
 *
 * ── WHY THIS IS NOT `document.visibilityState` ─────────────────────────────
 *
 * The owner asked (2026-08-15) for *"can you also check if I'm **actively
 * using** the web app, and if so dont send push notifications to my phone"*, and
 * the first implementation answered a narrower question: is the tab un-hidden?
 * Those come apart in the single most common way a chat tab is left:
 * `visibilityState` is `'visible'` for a window sitting on a second monitor, or
 * behind the editor he is actually working in, for as long as the machine is
 * awake. So that tab re-declares `foreground` every twenty seconds, forever, and
 * the server's TTL never fires — it protects against a browser that DIED, not
 * against a live one at rest, and at rest is where a chat tab spends its day.
 * The net effect of shipping visibility alone would be a phone that stops
 * notifying the moment a tab is opened and does not start again until it is
 * closed. Silent, invisible, and indistinguishable from the feature working.
 *
 * ── THE THREE SIGNALS, AND WHY EACH IS NECESSARY ───────────────────────────
 *
 *   • VISIBLE (`document.visibilityState`) — a minimised window or a background
 *     tab. Necessary, and it was never sufficient.
 *   • FOCUSED (`document.hasFocus()`) — the second-monitor case above. A visible
 *     but unfocused window is one he can see and is not typing into; every other
 *     chat app treats that as "not in the conversation".
 *   • RECENTLY INTERACTED — the focused window he walked away from. Nothing in
 *     the DOM fires an event when a human STOPS doing something, so this one is
 *     a timestamp plus a poll rather than a listener.
 *
 * ── THE IDLE WINDOW IS DELIBERATELY GENEROUS ───────────────────────────────
 *
 * {@link DEFAULT_ATTENTION_IDLE_MS} is five minutes, which is far longer than it
 * needs to be to catch "he left", because the two ways of being wrong here are
 * not symmetric and the asymmetry should be visible in the constant. Too SHORT
 * and a man reading a long agent reply without touching his mouse gets a
 * redundant buzz — mildly annoying, immediately obvious, self-correcting the
 * moment he scrolls. Too LONG and he misses something, learns nothing about why,
 * and has no way to notice. So the tuning bias is toward buzzing, and five
 * minutes is the point where "still reading" has stopped being plausible.
 *
 * ── WHY A MODULE RATHER THAN A `useEffect` ─────────────────────────────────
 *
 * Same reason `app/lib/push-foreground-policy.ts` and
 * `gateway/push/web-presence.ts` are modules: a notification rule that can only
 * be reached by mounting a React tree in a browser is a rule nothing tests, and
 * "nothing tests it" is how it quietly stops matching what the owner asked for.
 * {@link decideAttention} is pure and takes its three inputs as data;
 * {@link observeWebAttention} is the thin DOM shell around it, with the document,
 * the window and the clock all injectable so the shell is testable too.
 */

/**
 * How long after the owner's last interaction a FOCUSED, VISIBLE tab still
 * counts as actively used (ms).
 *
 * See the module docblock for why this is five minutes and not thirty seconds:
 * the cost of expiring too early is a redundant buzz, the cost of expiring too
 * late is a message he never hears about, and only one of those is recoverable.
 */
export const DEFAULT_ATTENTION_IDLE_MS = 5 * 60_000

/**
 * How often the idle clock is re-checked (ms).
 *
 * A poll, because no event fires when a human stops interacting. Kept well below
 * `WEB_PRESENCE_REFRESH_MS` (20 s) so the transition to inattentive is reported
 * BEFORE the next `foreground` refresh would have renewed the server's belief —
 * otherwise going idle would cost up to a full refresh interval of extra silence.
 */
export const ATTENTION_POLL_MS = 5_000

export interface AttentionInputs {
  /** `document.visibilityState === 'visible'`. */
  visible: boolean
  /** `document.hasFocus()`. */
  focused: boolean
  /** Milliseconds since the owner last interacted with the page. */
  ms_since_interaction: number
}

/**
 * The whole decision, as a pure function of three observations.
 *
 * ALL THREE MUST HOLD. There is no "two out of three" reading and there should
 * not be: every relaxation of this predicate buys a marginally quieter phone and
 * pays for it with a class of message the owner never hears about, and he can
 * report the first but not the second.
 */
export function decideAttention(
  input: AttentionInputs,
  idle_ms: number = DEFAULT_ATTENTION_IDLE_MS,
): boolean {
  if (!input.visible) return false
  if (!input.focused) return false
  // A non-finite or negative reading is a broken clock, not a fresh interaction.
  // Treat it as "not attentive" — the direction that notifies.
  if (!Number.isFinite(input.ms_since_interaction)) return false
  if (input.ms_since_interaction < 0) return false
  return input.ms_since_interaction < idle_ms
}

/** The DOM surfaces {@link observeWebAttention} reads, narrowed so tests can fake them. */
export interface AttentionEnv {
  addEventListener(type: string, listener: () => void, options?: unknown): void
  removeEventListener(type: string, listener: () => void, options?: unknown): void
}

export interface ObserveWebAttentionOptions {
  /** Called on START and thereafter only when the answer CHANGES. */
  onChange: (attentive: boolean) => void
  /** `document`, or a fake. */
  doc: AttentionEnv & { visibilityState: string; hasFocus(): boolean }
  /** `window`, or a fake. */
  win: AttentionEnv
  idle_ms?: number
  poll_ms?: number
  now?: () => number
  setIntervalFn?: (fn: () => void, ms: number) => unknown
  clearIntervalFn?: (handle: unknown) => void
}

/**
 * Watch the three signals and report attention changes. Returns the teardown.
 *
 * EMITS ON CHANGE ONLY, plus once at start. The consumer forwards each emission
 * to the session, which sends a wire frame, and an unconditional emit on every
 * mousemove would be a frame per mousemove. The start emission is not an
 * optimisation to skip: it is what corrects the session's optimistic
 * `attentive = true` for a tab that mounted already hidden or unfocused.
 *
 * INTERACTION EVENTS ARE CAPTURE-PHASE AND PASSIVE. Capture so a component that
 * stops propagation cannot make the page look idle while the owner is using it;
 * passive so listening for `wheel` / `touchstart` cannot cost a frame of scroll
 * latency.
 */
export function observeWebAttention(opts: ObserveWebAttentionOptions): () => void {
  const now = opts.now ?? ((): number => Date.now())
  const idle_ms = opts.idle_ms ?? DEFAULT_ATTENTION_IDLE_MS
  const poll_ms = opts.poll_ms ?? ATTENTION_POLL_MS
  const setIntervalFn =
    opts.setIntervalFn ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms))
  const clearIntervalFn =
    opts.clearIntervalFn ?? ((h: unknown): void => clearInterval(h as never))

  let lastInteraction = now()
  // No previous answer yet — `null` rather than a boolean so the FIRST evaluate
  // always emits, whatever it decides. Seeding this with `true` would swallow the
  // start emission for an already-hidden tab, which is the one case it exists for.
  let last: boolean | null = null

  const evaluate = (): void => {
    const attentive = decideAttention(
      {
        visible: opts.doc.visibilityState === 'visible',
        focused: opts.doc.hasFocus(),
        ms_since_interaction: now() - lastInteraction,
      },
      idle_ms,
    )
    if (attentive === last) return
    last = attentive
    opts.onChange(attentive)
  }

  const onInteraction = (): void => {
    lastInteraction = now()
    evaluate()
  }

  const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const
  const passiveCapture = { capture: true, passive: true }
  for (const type of INTERACTION_EVENTS) {
    opts.win.addEventListener(type, onInteraction, passiveCapture)
  }
  opts.doc.addEventListener('visibilitychange', evaluate)
  opts.win.addEventListener('focus', evaluate)
  opts.win.addEventListener('blur', evaluate)

  const poll = setIntervalFn(evaluate, poll_ms)
  evaluate()

  return (): void => {
    for (const type of INTERACTION_EVENTS) {
      opts.win.removeEventListener(type, onInteraction, passiveCapture)
    }
    opts.doc.removeEventListener('visibilitychange', evaluate)
    opts.win.removeEventListener('focus', evaluate)
    opts.win.removeEventListener('blur', evaluate)
    clearIntervalFn(poll)
  }
}
